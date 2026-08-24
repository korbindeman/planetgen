import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
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

const DEFAULT_SNR = "0.2,0.2,1.0,0.2,1.0";
const DEFAULT_MODEL = "xandergos/terrain-diffusion-90m";
const jobs = new Map();
let queueRunning = false;

export function tdCheckout() {
  return process.env.TD_ROOT || join(homedir(), "dev", "terrain-diffusion");
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
      padCells,
      originI,
      originJ,
      nominalBounds: bounds,
    }, null, 2));
  }
  job.status = "queued";
  job.log.push("wrote conditioning GeoTIFFs");
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
  return join(tdCheckout(), ".venv", "bin", "python");
}

function tdDevice() {
  if (process.env.TD_DEVICE) return process.env.TD_DEVICE;
  return process.platform === "darwin" ? "mps" : "cuda";
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
   * uses the pad as the U-Net context and the face-grid origin so
   * adjacent tiles share noise at the seam.
   */
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

  job.status = "baking";
  job.progress = 0;
  job.log.push(pad > 0
    ? `td-bake ${job.cropW}×${job.cropH} +${pad} pad on ${tdDevice()}`
    : `tiff-export ${job.cropW}×${job.cropH} on ${tdDevice()}`);

  const code = await spawnLogged(python, args, {
    cwd: tdRootDir,
    env: {
      ...process.env,
      MPLBACKEND: "Agg",
      PYTORCH_ENABLE_MPS_FALLBACK: "1",
      PYTHONUNBUFFERED: "1",
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
  const preview = await spawnLogged(python, [
    join(root, "scripts", "td-preview.py"),
    outTif,
    join(job.dir, "output.png"),
  ], {cwd: root, job});
  if (preview !== 0) {
    job.status = "error";
    job.error = job.error || `preview exited ${preview}`;
    return;
  }
  try {
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
    const onData = (buf) => {
      const text = buf.toString();
      /* tiff-export prints a tqdm bar; carriage returns rewrite one line, so
       * split on those too or the whole bake arrives as a single log entry
       * with no visible progress until it ends. */
      for (const line of text.split(/[\r\n]/)) {
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
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      job.error = err.code === "ENOENT"
        ? `terrain-diffusion python not found (${cmd}). Expected sibling checkout at ${tdCheckout()}`
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
  const running = listJobs(project, variant).filter((j) => j.status !== "done" && j.status !== "error");
  const regional = fact.stages.find((s) => s.id === "regional");
  if (regional && running.length) {
    regional.fact = running[0].status === "baking"
      ? `baking ${running[0].name}`
      : `${running[0].status} ${running[0].name}`;
    regional.canBake = false;
  }
  return {
    ...fact,
    jobs: listJobs(project, variant),
  };
}
