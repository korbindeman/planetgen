import { spawn } from "node:child_process";
import { delimiter, join, resolve as resolvePath } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { b64ToF32, CHANNELS, hillshadePng, writeTdFolder } from "./td-geotiff.mjs";
import { cropHasBake, listTdOverlays, pipelineFact, projectBakeDir } from "./td-overlays.mjs";
import { exportProjectCrops } from "./export-project.mjs";
import { paintCropTerrain } from "./paint-td-terrain.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));
const Projects = require(join(here, "..", "src", "projects"));
const Cubesphere = require(join(here, "..", "src", "cubesphere.js"));
const TdTile = require(join(here, "..", "src", "td-tile.js"));
const Seam = require(join(here, "..", "src", "td-seam.js"));

const DEFAULT_SNR = "0.2,0.2,1.0,0.2,1.0";
const DEFAULT_MODEL = "xandergos/terrain-diffusion-90m";
const jobs = new Map();
let queueRunning = false;

/*
 * The model checkout. A *sibling* of this repo, which is what the prose
 * always said and what is actually on disk — the old `~/dev/terrain-diffusion`
 * default was neither, so an agent that went looking concluded there was no
 * checkout at all and reported the bake unverifiable. TD_ROOT overrides.
 * See docs/ref/terrain-diffusion.md for the two environments.
 */
export function tdCheckout() {
  return process.env.TD_ROOT || join(here, "..", "..", "terrain-diffusion");
}

function jobKey(project, name, variant) {
  return variant ? `${project}/${variant}/${name}` : `${project}/${name}`;
}

function readVariant(project, raw) {
  if (project === "earth") return null;
  const variant = raw && Projects.isVariantId(raw) ? raw : null;
  if (!variant) throw new Error("variant required");
  return variant;
}

export function listJobs(project, variant) {
  return [...jobs.values()]
    .filter((j) => {
      if (project && j.project !== project) return false;
      if (variant && j.variant !== variant) return false;
      return true;
    })
    .map(publicJob);
}

export function getJob(id) {
  const job = jobs.get(id) || [...jobs.values()].find((j) => j.name === id || j.id === id);
  return job ? publicJob(job) : null;
}

function publicJob(job) {
  return {
    id: job.id,
    name: job.name,
    project: job.project,
    status: job.status,
    error: job.error || null,
    west: job.west,
    south: job.south,
    east: job.east,
    north: job.north,
    cropW: job.cropW,
    cropH: job.cropH,
    scaleKm: job.scaleKm,
    seed: job.seed,
    variant: job.variant || null,
    tile: job.tile || null,
    progress: job.progress ?? null,
    logTail: job.log.slice(-12),
  };
}

/* Accept a tile only if it is a real (face, level, i, j) on the grid. */
function readTile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const {face, level, i, j} = raw;
  if (![face, level, i, j].every(Number.isInteger)) return null;
  if (face < 0 || face > 5 || level < Cubesphere.MIN_LEVEL || level > Cubesphere.MAX_LEVEL) return null;
  const n = 1 << level;
  if (i < 0 || j < 0 || i >= n || j >= n) return null;
  return {face, level, i, j};
}

function tileName(tile) {
  return Cubesphere.tileName(tile);
}

function slug(name) {
  const s = String(name || "tile").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (s || "tile").slice(0, 40);
}

async function uniqueName(root, project, wanted, variant) {
  const dir = projectBakeDir(root, project, variant);
  let name = wanted;
  let n = 2;
  for (;;) {
    const key = jobKey(project, name, variant);
    const folder = join(dir, `crop-${name}`);
    const taken = jobs.has(key) || await Bun.file(folder).exists();
    if (!taken) return name;
    name = `${wanted}-${n++}`;
  }
}

export async function submitJob(root, body) {
  const project = body.project || Projects.DEFAULT;
  Projects.byName(project);
  const variant = readVariant(project, body.variant);
  /*
   * Say no rather than quietly resizing. Clamping here meant a caller asking
   * for 27 cells got its request silently changed to 24 and then rejected for
   * sending 729 samples instead of 576 — an error about the symptom, three
   * steps from the cause. The caps live in src/td-tile.js so the picker and
   * this agree on what is bakeable.
   */
  const cropW = body.cropW | 0 || 16;
  const cropH = body.cropH | 0 || 12;
  for (const [side, cells] of [['width', cropW], ['height', cropH]]) {
    if (cells < TdTile.MIN_CELLS || cells > TdTile.MAX_CELLS) {
      throw new Error(
        `crop ${side} is ${cells} cells; a bake takes ${TdTile.MIN_CELLS}-${TdTile.MAX_CELLS}`
        + ` per side. Pick a different tile level.`,
      );
    }
  }
  const padCells = Math.max(0, body.padCells | 0);
  const originI = Number.isFinite(Number(body.originI)) ? Number(body.originI) | 0 : 0;
  const originJ = Number.isFinite(Number(body.originJ)) ? Number(body.originJ) | 0 : 0;
  /*
   * A cube tile is conditioned on its face's conformal bake plane, not on the
   * tile's own square — see the bake plane in src/cubesphere.js. The step and
   * the tile's cell count are what let the finished bake be put back on the
   * tile raster, so they travel with the job and land in tile.json.
   */
  const bakeStep = Number(body.bakeStep) > 0 ? Number(body.bakeStep) : 0;
  const tileCells = Math.max(0, body.tileCells | 0) || cropW;
  const haloCells = Math.max(0, body.haloCells | 0);
  const layerW = cropW + 2 * padCells;
  const layerH = cropH + 2 * padCells;
  const layers = decodeLayers(body.layers, layerW, layerH);
  const tile = readTile(body.tile);
  /*
   * A tile owns its folder. The name is (face, level, i, j), so baking the
   * same ground twice replaces it instead of piling up crop-foo-2, -3, -4 —
   * that is the whole point of having a grid. Free-named crops keep the old
   * uniquify-on-collision behaviour.
   */
  const name = tile ? tileName(tile) : await uniqueName(root, project, slug(body.name), variant);
  if (tile) {
    const running = jobs.get(jobKey(project, name, variant));
    if (running && running.status !== "done" && running.status !== "error") return publicJob(running);
  }
  const bounds = {
    west: Number(body.west),
    south: Number(body.south),
    east: Number(body.east),
    north: Number(body.north),
  };
  if (![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) {
    throw new Error("crop needs west,south,east,north");
  }
  if (bounds.north <= bounds.south) throw new Error("north must be greater than south");

  const dir = join(projectBakeDir(root, project, variant), `crop-${name}`);
  const job = {
    id: jobKey(project, name, variant),
    name,
    project,
    variant,
    status: "exporting",
    error: null,
    log: [],
    dir,
    ...bounds,
    tile,
    cropW,
    cropH,
    padCells,
    originI,
    originJ,
    bakeStep,
    tileCells,
    haloCells,
    /* Pixels of DEM kept per conditioning cell. The studio's 128 is a preview
     * at ~180 m; a campaign asks for 256 and keeps the model's own 90 m. */
    pxPerCell: Math.max(0, body.pxPerCell | 0) || TdTile.TILE_PX_PER_CELL,
    scaleKm: Number(body.scaleKm) || 23,
    seed: body.seed ?? null,
    snr: body.snr || DEFAULT_SNR,
    model: body.model || DEFAULT_MODEL,
  };
  jobs.set(job.id, job);

  await writeTdFolder(dir, layers, bounds);
  const previewMap = padCells
    ? interiorField(layers.heightmap, layerW, padCells, cropW, cropH)
    : layers.heightmap;
  await writeFile(join(dir, "coarse.png"), hillshadePng(previewMap, cropW, cropH));
  /*
   * The GeoTIFF's geotransform is a nominal lon/lat box, because a cube tile
   * is not an axis-aligned WGS84 rectangle and no CRS we could write would
   * make it one. This sidecar is the truth about where the raster belongs;
   * the overlay places the bake from it, not from the box.
   */
  if (tile) {
    await writeFile(join(dir, "tile.json"), JSON.stringify({
      ...tile,
      name,
      project,
      seed: body.seed ?? null,
      variant,
      scaleKm: Number(body.scaleKm) || 23,
      cells: cropW,
      tileCells,
      padCells,
      originI,
      originJ,
      bakeStep,
      haloCells,
      halo: TdTile.haloCellsFor(tile),
      nominalBounds: bounds,
    }, null, 2));
  }
  job.log.push("wrote conditioning GeoTIFFs");
  /* Export without baking. The conditioning half needs no GPU, so this is
   * what a check or a dry run asks for; `queueExistingCrop` bakes it later. */
  if (body.exportOnly) {
    job.status = "exported";
    return publicJob(job);
  }
  job.status = "queued";
  kickQueue(root);
  return publicJob(job);
}

export async function queueExistingCrop(root, {project, name, seed, variant, west, south, east, north, cropW, cropH}) {
  const id = jobKey(project, name, variant);
  const existing = jobs.get(id);
  if (existing && existing.status !== "done" && existing.status !== "error") {
    return publicJob(existing);
  }
  const dir = join(projectBakeDir(root, project, variant), `crop-${name}`);
  if (!(await Bun.file(join(dir, "heightmap.tif")).exists())) {
    throw new Error(`no conditioning for ${project}/${name}`);
  }
  const job = {
    id,
    name,
    project,
    variant: variant || null,
    status: "queued",
    error: null,
    log: [`queued existing crop ${name}`],
    dir,
    west, south, east, north,
    cropW: cropW || 16,
    cropH: cropH || 12,
    scaleKm: 23,
    seed: seed ?? null,
    snr: DEFAULT_SNR,
    model: DEFAULT_MODEL,
  };
  jobs.set(id, job);
  kickQueue(root);
  return publicJob(job);
}

export async function previewBakes(root, body) {
  const project = body.project || Projects.DEFAULT;
  Projects.byName(project);
  const variant = readVariant(project, body.variant);
  const exported = await exportProjectCrops(root, {
    project,
    seed: body.seed,
    values: body.values,
    variant,
    connectOceans: !!body.connectOceans,
  });
  const queued = [];
  for (const crop of exported.crops) {
    if (await cropHasBake(join(exported.outDir, crop.dir))) continue;
    queued.push(await queueExistingCrop(root, {
      project,
      name: crop.name,
      seed: exported.manifest.seed,
      variant,
      west: crop.west,
      south: crop.south,
      east: crop.east,
      north: crop.north,
      cropW: crop.width,
      cropH: crop.height,
    }));
  }
  return {
    project,
    seed: exported.manifest.seed,
    crops: exported.crops,
    queued,
  };
}

function decodeLayers(raw, w, h) {
  if (!raw) throw new Error("layers missing");
  const layers = {width: w, height: h};
  for (const name of CHANNELS) {
    if (typeof raw[name] !== "string") throw new Error(`layer ${name} missing`);
    const arr = b64ToF32(raw[name]);
    if (arr.length !== w * h) {
      throw new Error(`layer ${name} is ${arr.length} samples, expected ${w * h}`);
    }
    layers[name] = arr;
  }
  return layers;
}

/* The thumbnail is the tile, not the context pad around it. */
function interiorField(src, fullW, pad, innerW, innerH) {
  const out = new Float32Array(innerW * innerH);
  for (let y = 0; y < innerH; y++) {
    const srcOff = (y + pad) * fullW + pad;
    out.set(src.subarray(srcOff, srcOff + innerW), y * innerW);
  }
  return out;
}

function kickQueue(root) {
  if (queueRunning) return;
  queueRunning = true;
  runQueue(root).finally(() => {
    queueRunning = false;
  });
}

async function runQueue(root) {
  for (;;) {
    const next = [...jobs.values()].find((j) => j.status === "queued");
    if (!next) return;
    await bakeJob(root, next);
  }
}

function tdPython() {
  // uv writes Scripts/python.exe on Windows, bin/python everywhere else.
  return process.platform === "win32"
    ? join(tdCheckout(), ".venv", "Scripts", "python.exe")
    : join(tdCheckout(), ".venv", "bin", "python");
}

function tdDevice() {
  if (process.env.TD_DEVICE) return process.env.TD_DEVICE;
  return process.platform === "darwin" ? "mps" : "cuda";
}

/* ------------------------------------------------------------------ WSL2
 *
 * `TD_WSL=1` (or `TD_WSL=<distro>`) runs the bake inside WSL2 instead of the
 * checkout's native-Windows venv. Two reasons, both measured, both in
 * docs/ref/wsl-bake-env.md: `torch.compile` refuses to run on Windows —
 * WorldPipeline prints a warning and silently drops it — and the model load
 * plus inductor warmup is ~150 s, which one process per tile pays every time.
 *
 * So the WSL path is also a *persistent* worker: `td-bake.py --serve` stays up
 * and takes one JSON job per line. That is safe because every
 * `set_custom_conditioning_import` calls `rebuild()`, which installs a fresh
 * tile store — measured here as job 2 coming back byte-identical to job 1.
 * It matters because face origins are per-face, so a cache that outlived a
 * job would hand one face another face's terrain.
 *
 * The worker is keyed by model/snr/seed/device: those are constructor
 * arguments to WorldPipeline, so a job that differs in any of them gets a new
 * process rather than quietly baking against the wrong world.
 */
const WSL_DEFAULT_DISTRO = "Thalos-Ubuntu";
const WSL_PYTHON = "$HOME/td-env/bin/python";
let worker = null;

export function tdWsl() {
  const raw = process.env.TD_WSL;
  if (!raw || raw === "0" || raw.toLowerCase() === "false") return null;
  const distro = raw === "1" || raw.toLowerCase() === "true" ? WSL_DEFAULT_DISTRO : raw;
  return {distro};
}

/* C:\a\b -> /mnt/c/a/b. The cross-mount is how the WSL env reads this repo
 * and the model checkout; there is no second copy of either. */
export function toWslPath(p) {
  const abs = resolvePath(p);
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(abs);
  if (!m) throw new Error(`not an absolute Windows path, cannot map into WSL: ${p}`);
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

function workerKey({model, snr, seed, device}) {
  return JSON.stringify([model, snr, seed == null ? null : Number(seed), device]);
}

function startWorker(root, spec) {
  const {distro} = tdWsl();
  /*
   * Run from the checkout: `bind()` resolves data/global/synthetic_map_stats.json
   * relative to cwd, and without it the pipeline prompts for a WorldClim
   * download and hangs with no output at all.
   */
  const script = toWslPath(join(root, "scripts", "td-bake.py"));
  const checkout = toWslPath(tdCheckout());
  /*
   * PYTHONPATH is the checkout spelled out, not `$PWD`. wsl.exe exports the
   * launching process's directory as PWD and `cd` in the command string does
   * not replace it for the environment the child sees, so `PYTHONPATH=$PWD`
   * silently pointed at planetgen and `import terrain_diffusion` failed with
   * the cwd looking correct. td-bake.py is run by path, so sys.path[0] is
   * scripts/ and the package has to come from here.
   */
  const command = [
    `cd ${JSON.stringify(checkout)}`,
    [
      `PYTHONPATH=${JSON.stringify(checkout)}`,
      "HF_HUB_CACHE=$HOME/td-hub", "MPLBACKEND=Agg", "PYTHONUNBUFFERED=1",
      WSL_PYTHON, "-u", JSON.stringify(script), JSON.stringify(spec.model),
      "--serve", "--device", spec.device, "--snr", JSON.stringify(spec.snr),
      ...(spec.seed == null ? [] : ["--seed", String(spec.seed)]),
    ].join(" "),
  ].join(" && ");

  const child = spawn("wsl.exe", ["-d", distro, "--", "bash", "-lc", command], {cwd: root});
  const state = {
    child, key: workerKey(spec), pending: null, out: "", log: [], exited: null, job: null,
  };

  child.stdout.on("data", (buf) => {
    state.out += buf.toString();
    let cut;
    while ((cut = state.out.indexOf("\n")) >= 0) {
      const line = state.out.slice(0, cut).trim();
      state.out = state.out.slice(cut + 1);
      if (!line) continue;
      let result;
      try {
        result = JSON.parse(line);
      } catch {
        logToJob(state.job, line);   // not a result; the worker said something
        continue;
      }
      const pending = state.pending;
      state.pending = null;
      if (pending) pending.resolve(result);
    }
  });
  /* Human output and tqdm are on stderr, which is what the job log wants. */
  child.stderr.on("data", (buf) => logToJob(state.job, buf.toString()));
  child.on("error", (err) => finishWorker(state, String(err.message || err)));
  child.on("close", (code) => finishWorker(state, `wsl worker exited ${code}`));
  return state;
}

function finishWorker(state, reason) {
  state.exited = reason;
  if (worker === state) worker = null;
  const pending = state.pending;
  state.pending = null;
  if (pending) pending.resolve({ok: false, error: reason});
}

/* The queue is strictly sequential, so one job is in flight at a time. */
export function runOnWorker(root, spec, job, payload) {
  const key = workerKey(spec);
  if (worker && worker.key !== key) {
    worker.child.stdin.end();
    worker = null;
  }
  if (!worker) worker = startWorker(root, spec);
  const state = worker;
  state.job = job;
  return new Promise((resolve) => {
    if (state.exited) return resolve({ok: false, error: state.exited});
    state.pending = {resolve};
    state.child.stdin.write(JSON.stringify(payload) + "\n");
  });
}

/* Shut the worker down between campaigns, and on the way out of a CLI run:
 * the model is holding VRAM that the next process wants. */
export function stopTdWorker() {
  if (!worker) return;
  worker.child.stdin.end();
  worker = null;
}

/* tqdm rewrites one line with carriage returns, so split on those too or a
 * whole bake arrives as a single log entry with no visible progress until it
 * ends. Shared by the native spawn and the WSL worker's stderr. */
function logToJob(job, text) {
  if (!job) return;
  for (const line of String(text).split(/[\r\n]/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pct = /(\d{1,3})%/.exec(trimmed);
    if (pct) {
      const value = Number(pct[1]);
      if (value >= 0 && value <= 100) job.progress = value;
    }
    job.log.push(trimmed.slice(0, 240));
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
  }
}

function copyF32(buf, n) {
  const src = new Float32Array(buf.buffer, buf.byteOffset, n);
  return new Float32Array(src);
}

async function loadSeamTile(dir, tile) {
  let meta;
  try {
    meta = JSON.parse(await readFile(join(dir, "output.elev.json"), "utf8"));
  } catch {
    return null;
  }
  const w = meta.width | 0;
  const h = meta.height | 0;
  if (!(w > 0 && h > 0)) return null;
  let raw;
  try {
    raw = await readFile(join(dir, "output.elev"));
  } catch {
    return null;
  }
  if (raw.byteLength < w * h * 4) return null;
  const halo = {};
  for (const edge of Cubesphere.EDGES) {
    try {
      const hm = JSON.parse(await readFile(join(dir, `halo-${edge}.elev.json`), "utf8"));
      const hw = hm.width | 0;
      const hh = hm.height | 0;
      const hb = await readFile(join(dir, `halo-${edge}.elev`));
      if (!(hw > 0 && hh > 0) || hb.byteLength < hw * hh * 4) continue;
      halo[edge] = {data: copyF32(hb, hw * hh), width: hw, height: hh};
    } catch {
      /* neighbour baked before halo, or this edge is not a fold */
    }
  }
  return {tile, width: w, height: h, elev: copyF32(raw, w * h), halo};
}

/*
 * The bake ran on the face's conformal plane, so put it back on the tile's
 * own raster before anything else reads it. Everything downstream — the
 * drape, the stitch, the painter, the exporter — speaks tile raster, and
 * output.elev is that raster's contract; this is the only place the two
 * grids meet.
 *
 * A job with no bakeStep is a legacy crop that was conditioned on the tile
 * square itself. It is already in the right grid, so leave it alone.
 */
async function bakeBackOntoTile(job) {
  if (!job.tile || !(job.bakeStep > 0)) return;
  const meta = JSON.parse(await readFile(join(job.dir, "output.elev.json"), "utf8"));
  const srcW = meta.width | 0;
  const srcH = meta.height | 0;
  if (!(srcW > 0 && srcH > 0)) return;
  const raw = await readFile(join(job.dir, "output.elev"));
  if (raw.byteLength < srcW * srcH * 4) return;
  const src = copyF32(raw, srcW * srcH);
  /* The interior of the lattice rectangle: the padded rect the exporter
   * asked for, minus the context the model only reads. */
  const rect = {
    step: job.bakeStep,
    originI: job.originI + job.padCells,
    originJ: job.originJ + job.padCells,
    width: job.cropW,
    height: job.cropH,
  };
  const side = Math.max(64, Math.round(job.tileCells * (srcW / job.cropW)));
  const out = Seam.bakeToTile(job.tile, rect, src, srcW, srcH, side, side);
  await writeFile(
    join(job.dir, "output.elev"),
    Buffer.from(out.buffer, out.byteOffset, out.byteLength),
  );
  await writeFile(
    join(job.dir, "output.elev.json"),
    JSON.stringify({width: side, height: side}),
  );

  /*
   * The halo the exporter grew the rect by, cut back out in the tile's own
   * continuation. rasterizeHalo is what defines that convention — sampling
   * `tileDirection` past the edge — so reusing it here means sampleHalo
   * reads these files correctly by construction rather than by agreement.
   */
  const sx = srcW / rect.width;
  const sy = srcH / rect.height;
  const sample = (d) => {
    const px = Cubesphere.bakePixel(job.tile, rect, d);
    return px ? Seam.sampleBicubic(src, srcW, srcH, px.x * sx, px.y * sy) : 0;
  };
  const haloPx = Math.round(side * (job.haloCells || 0) / Math.max(1, job.tileCells));
  const edges = [];
  if (haloPx > 0) {
    for (const [edge, cells] of Object.entries(TdTile.haloCellsFor(job.tile))) {
      if (!cells) continue;
      const h = Seam.rasterizeHalo(job.tile, edge, side, side, haloPx, sample);
      const buf = Buffer.from(h.data.buffer, h.data.byteOffset, h.data.byteLength);
      await writeFile(join(job.dir, `halo-${edge}.elev`), buf);
      await writeFile(
        join(job.dir, `halo-${edge}.elev.json`),
        JSON.stringify({width: h.width, height: h.height}),
      );
      edges.push(edge);
    }
  }
  job.log.push(
    `resampled ${srcW}x${srcH} of bake plane onto a ${side}x${side} tile raster`
    + (edges.length ? `, ${haloPx}px halo on ${edges.join("/")}` : ""),
  );
}

/*
 * The tile that just finished conforms to any already-baked neighbour
 * across a cube fold. Same-face joins are left to WorldPipeline. The
 * first tile at an edge stays native; the second follows its halo.
 */
async function stitchFaceEdges(job) {
  if (!job.tile) return;
  const dest = await loadSeamTile(job.dir, job.tile);
  if (!dest) return;
  let moved = 0;
  const restitched = [];
  for (const edge of Cubesphere.faceEdges(job.tile)) {
    const nb = Cubesphere.neighborTile(job.tile, edge);
    if (!nb) continue;
    const src = await loadSeamTile(join(job.dir, "..", `crop-${Cubesphere.tileName(nb)}`), nb);
    if (!src) continue;
    const n = Seam.blendFromNeighbor(dest, src);
    if (!n) continue;
    moved += n;
    /*
     * The stitch just moved this tile's ground near `edge`, but the halo past
     * that edge was cut before it and still describes the native bake. Leaving
     * them disagreeing is not cosmetic: the halo is what the *next* tile
     * conforms to, so it would be pulled onto a surface this tile no longer
     * has. Measured on the first three-tile bake — f1's edge matched f5's halo
     * to 0.1 m while f5's own interior sat 32 m below it, and the join showed
     * as a crease. Past a stitched edge the ground is the neighbour's, so
     * re-cut the halo from the same place the interior now follows.
     */
    const halo = dest.halo && dest.halo[edge];
    if (!halo) continue;
    const haloPx = edge === "east" || edge === "west" ? halo.width : halo.height;
    const cut = Seam.rasterizeHalo(dest.tile, edge, dest.width, dest.height, haloPx, (d) => {
      const ll = Cubesphere.xyzToLonLat(d);
      const v = Seam.sampleSrc(src, ll.lon, ll.lat);
      return v == null || !Number.isFinite(v) ? 0 : v;
    });
    await writeFile(
      join(job.dir, `halo-${edge}.elev`),
      Buffer.from(cut.data.buffer, cut.data.byteOffset, cut.data.byteLength),
    );
    await writeFile(
      join(job.dir, `halo-${edge}.elev.json`),
      JSON.stringify({width: cut.width, height: cut.height}),
    );
    restitched.push(edge);
  }
  if (!moved) return;
  await writeFile(
    join(job.dir, "output.elev"),
    Buffer.from(dest.elev.buffer, dest.elev.byteOffset, dest.elev.byteLength),
  );
  job.log.push(`stitched ${moved} face-edge pixels`
    + (restitched.length ? `, re-cut the ${restitched.join("/")} halo to match` : ""));
}

async function bakeJob(root, job) {
  const python = tdPython();
  const tdRootDir = tdCheckout();
  const outTif = join(job.dir, "output.tif");
  const pad = job.padCells | 0;
  /*
   * Cube tiles arrive already padded with real neighbour cells. Feeding
   * those to tiff-export would pad again (edge-repeat of the pad) and
   * generate the whole thing as a crop starting at (0,0). td-bake.py
   * uses the pad as the U-Net context and the lattice origin so adjacent
   * tiles on one face share noise at the seam.
   *
   * A cube fold needs a halo of ground past its edge for the stitch. That
   * used to be td-bake.py's `--halo-*`, which grew the raster on the named
   * side — fine when the raster *was* the tile square. On the conformal
   * bake plane it is not: a tile's east edge is a tilted curve in that
   * plane, so "grow the rect eastward" stopped meaning "past the tile's
   * east edge". So the exporter grows the rect itself (`tileBakeRect` takes
   * the halo), the model paints tile and halo in one pass, and
   * `bakeBackOntoTile` cuts the halo out afterwards in the tile's own
   * continuation — the grid td-seam.js already reads. Nothing to ask for
   * here any more.
   */
  const halo = job.bakeStep > 0
    ? {north: 0, east: 0, south: 0, west: 0}
    : TdTile.haloCellsFor(job.tile);
  const args = pad > 0
    ? [
        "-u",
        join(root, "scripts", "td-bake.py"),
        job.model,
        job.dir,
        outTif,
        "--snr", job.snr,
        "--no-compile",
        "--device", tdDevice(),
        "--pad", String(pad),
        "--origin-i", String(job.originI | 0),
        "--origin-j", String(job.originJ | 0),
        "--crop-w", String(job.cropW),
        "--crop-h", String(job.cropH),
        "--halo-north", String(halo.north),
        "--halo-east", String(halo.east),
        "--halo-south", String(halo.south),
        "--halo-west", String(halo.west),
      ]
    : [
        "-u",
        "-m", "terrain_diffusion.inference.tiff_export",
        job.model,
        job.dir,
        outTif,
        "--snr", job.snr,
        "--no-compile",
        "--device", tdDevice(),
      ];
  if (job.seed != null && Number.isFinite(Number(job.seed))) {
    args.push("--seed", String(Number(job.seed) | 0));
  }

  /*
   * Clear what the last bake of this tile left. A tile owns its folder and a
   * re-bake replaces it, but td-preview.py globs `halo-*.tif`, so a stale
   * halo from a run with different geometry gets dumped again and read as if
   * it were this bake's. Rebaking f5l4x15y0 did exactly that.
   */
  for (const edge of Cubesphere.EDGES) {
    for (const ext of ["tif", "elev", "elev.json"]) {
      await Bun.file(join(job.dir, `halo-${edge}.${ext}`)).unlink().catch(() => {});
    }
  }

  job.status = "baking";
  job.progress = 0;
  /* tiff-export keeps the native path: it is the isolated-crop tool, not the
   * campaign, and it has no persistent-worker entry to talk to. */
  const wsl = pad > 0 ? tdWsl() : null;
  job.log.push(pad > 0
    ? `td-bake ${job.cropW}×${job.cropH} +${pad} pad on ${tdDevice()}${wsl ? ` in wsl:${wsl.distro}` : ""}`
    : `tiff-export ${job.cropW}×${job.cropH} on ${tdDevice()}`);

  /*
   * How much of the bake to keep. 128 px per cell is the studio preview's
   * long-standing halving of the model's 90 m; a campaign passes 256 and gets
   * the native grain. Either way the cap is against the *bake raster*, which
   * covers the tile and its halo, so the tile's own share stays put.
   */
  const dumpMaxDim = Math.max(job.cropW, job.cropH)
    * (job.pxPerCell || TdTile.TILE_PX_PER_CELL);

  if (wsl) {
    const result = await runOnWorker(root, {
      model: job.model,
      snr: job.snr,
      device: tdDevice(),
      seed: job.seed != null && Number.isFinite(Number(job.seed)) ? Number(job.seed) | 0 : null,
    }, job, {
      name: job.name,
      tiff_dir: toWslPath(job.dir),
      output: toWslPath(outTif),
      pad,
      origin_i: job.originI | 0,
      origin_j: job.originJ | 0,
      crop_w: job.cropW,
      crop_h: job.cropH,
      halo,
      /* The worker writes output.elev itself. Spawning python, importing
       * rasterio and re-reading a 5376² GeoTIFF per tile is a minute a
       * hundred tiles for a cast the worker already has in memory. */
      dump_elev: true,
      max_dim: job.bakeStep > 0 ? dumpMaxDim : 2048,
    });
    if (!result.ok) {
      job.status = "error";
      job.error = job.error || result.error || "wsl bake failed";
      return;
    }
    job.log.push(`baked in wsl:${wsl.distro}`);
    return await finishBake(job);
  }

  const code = await spawnLogged(python, args, {
    cwd: tdRootDir,
    env: {
      ...process.env,
      MPLBACKEND: "Agg",
      PYTORCH_ENABLE_MPS_FALLBACK: "1",
      PYTHONUNBUFFERED: "1",
      /*
       * tiff_export prints arrows. Python picks cp1252 for a piped stdout on
       * Windows, so that print raises UnicodeEncodeError and the bake exits 1
       * before it generates anything. Ask for UTF-8 on every platform.
       */
      PYTHONIOENCODING: "utf-8",
      /*
       * td-bake.py is ours, run by path, so sys.path[0] is scripts/ and not
       * the checkout — `import terrain_diffusion` then fails unless the
       * package happens to be installed into the venv. tiff_export runs as
       * -m and gets the cwd for free, which is why only the tile path broke.
       */
      PYTHONPATH: [tdRootDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    },
    job,
  });
  if (code !== 0) {
    job.status = "error";
    job.error = job.error || `tiff-export exited ${code}`;
    return;
  }

  job.status = "preview";
  job.progress = null;
  /*
   * Ask for a dump big enough that the *tile* still lands at its usual
   * resolution. The bake raster covers the tile plus its halo, so the default
   * 2048 cap is applied to a bigger picture than it used to be and the tile's
   * own share shrinks — 21 cells capped at 2048 left the 14-cell tile 1195 px
   * where it had always had 1792.
   */
  const dumpDim = job.bakeStep > 0 ? [`--max-dim=${dumpMaxDim}`] : [];
  const preview = await spawnLogged(python, [
    join(root, "scripts", "td-preview.py"),
    outTif,
    join(job.dir, "output.png"),
    ...dumpDim,
  ], {cwd: root, job});
  if (preview !== 0) {
    job.status = "error";
    job.error = job.error || `preview exited ${preview}`;
    return;
  }
  return await finishBake(job);
}

/*
 * Everything after the DEM exists, and it is the same work whichever process
 * generated it: put the bake back on the tile raster, conform to a neighbour
 * across a fold, colour it. Shared so the WSL worker and the native spawn
 * cannot drift into finishing a tile two different ways.
 */
export async function finishBake(job) {
  try {
    await bakeBackOntoTile(job);
    await stitchFaceEdges(job);
    await paintCropTerrain(job.dir);
  } catch (err) {
    job.status = "error";
    job.error = String(err.message || err);
    return;
  }
  job.status = "done";
  job.progress = null;
  job.log.push("output.png ready");
}

function spawnLogged(cmd, args, {cwd, env, job}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {cwd, env: env || process.env});
    const onData = (buf) => logToJob(job, buf.toString());
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      job.error = err.code === "ENOENT"
        ? `terrain-diffusion python not found (${cmd}).
`
          + `Expected the sibling checkout at ${tdCheckout()} — set TD_ROOT to move it.
`
          + `The two environments are documented in docs/ref/terrain-diffusion.md.`
        : String(err.message || err);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function overlaysWithJobs(root, {project, seed, variant} = {}) {
  const listed = await listTdOverlays(root, {project, seed, variant});
  /* Jobs are progress, not crops. The folder on disk is the crop; writing
   * a job over it is how a finished DEM disappeared while the process
   * still remembered the bake. */
  return {
    ...listed,
    api: true,
    jobs: listJobs(project, variant),
  };
}

export async function pipelineStatus(root, {project, seed, variant} = {}) {
  const fact = await pipelineFact(root, {project, seed, variant});
  return {
    ...fact,
    jobs: listJobs(project, variant),
  };
}
