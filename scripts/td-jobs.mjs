import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { b64ToF32, CHANNELS, hillshadePng, writeTdFolder } from "./td-geotiff.mjs";
import { listTdOverlays, pipelineFact, projectBakeDir } from "./td-overlays.mjs";
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

function jobKey(project, name) {
  return `${project}/${name}`;
}

export function listJobs(project) {
  return [...jobs.values()]
    .filter((j) => !project || j.project === project)
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

async function uniqueName(root, project, wanted) {
  const dir = projectBakeDir(root, project);
  let name = wanted;
  let n = 2;
  for (;;) {
    const key = jobKey(project, name);
    const folder = join(dir, `crop-${name}`);
    const taken = jobs.has(key) || await Bun.file(join(folder, "heightmap.tif")).exists()
      || await Bun.file(join(folder, "output.png")).exists();
    if (!taken) return name;
    name = `${wanted}-${n++}`;
  }
}

function cropUrl(job, file) {
  return `/preview/${job.project}/crop-${job.name}/${file}`;
}

export async function submitJob(root, body) {
  const project = body.project || Projects.DEFAULT;
  Projects.byName(project);
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
  const layers = decodeLayers(body.layers, cropW, cropH);
  const tile = readTile(body.tile);
  /*
   * A tile owns its folder. The name is (face, level, i, j), so baking the
   * same ground twice replaces it instead of piling up crop-foo-2, -3, -4 —
   * that is the whole point of having a grid. Free-named crops keep the old
   * uniquify-on-collision behaviour.
   */
  const name = tile ? tileName(tile) : await uniqueName(root, project, slug(body.name));
  if (tile) {
    const running = jobs.get(jobKey(project, name));
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

  const dir = join(projectBakeDir(root, project), `crop-${name}`);
  const job = {
    id: jobKey(project, name),
    name,
    project,
    status: "exporting",
    error: null,
    log: [],
    dir,
    ...bounds,
    tile,
    cropW,
    cropH,
    scaleKm: Number(body.scaleKm) || 23,
    seed: body.seed ?? null,
    snr: body.snr || DEFAULT_SNR,
    model: body.model || DEFAULT_MODEL,
  };
  jobs.set(job.id, job);

  await writeTdFolder(dir, layers, bounds);
  await writeFile(join(dir, "coarse.png"), hillshadePng(layers.heightmap, cropW, cropH));
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
      scaleKm: Number(body.scaleKm) || 23,
      cells: cropW,
      nominalBounds: bounds,
    }, null, 2));
  }
  job.status = "queued";
  job.log.push("wrote conditioning GeoTIFFs");
  kickQueue(root);
  return publicJob(job);
}

export async function queueExistingCrop(root, {project, name, seed, west, south, east, north, cropW, cropH}) {
  const id = jobKey(project, name);
  const existing = jobs.get(id);
  if (existing && existing.status !== "done" && existing.status !== "error") {
    return publicJob(existing);
  }
  const dir = join(projectBakeDir(root, project), `crop-${name}`);
  if (!(await Bun.file(join(dir, "heightmap.tif")).exists())) {
    throw new Error(`no conditioning for ${project}/${name}`);
  }
  const job = {
    id,
    name,
    project,
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
  const exported = await exportProjectCrops(root, {
    project,
    seed: body.seed,
    values: body.values,
    connectOceans: !!body.connectOceans,
  });
  const queued = [];
  for (const crop of exported.crops) {
    const out = join(exported.outDir, crop.dir, "output.png");
    if (await Bun.file(out).exists()) continue;
    queued.push(await queueExistingCrop(root, {
      project,
      name: crop.name,
      seed: exported.manifest.seed,
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
  const args = [
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
  job.log.push(`tiff-export ${job.cropW}×${job.cropH} on ${tdDevice()}`);

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

export async function overlaysWithJobs(root, {project, seed} = {}) {
  const listed = await listTdOverlays(root, {project, seed});
  const byName = new Map(listed.crops.map((c) => [c.name, c]));
  for (const job of jobs.values()) {
    if (project && job.project !== project) continue;
    if (seed != null && seed !== "" && job.seed != null && !Projects.sameSeed(job.seed, seed)) continue;
    const baked = job.status === "done";
    byName.set(job.name, {
      name: job.name,
      dir: `crop-${job.name}`,
      project: job.project,
      west: job.west,
      south: job.south,
      east: job.east,
      north: job.north,
      image: baked ? cropUrl(job, "output.png") : null,
      status: job.status,
      seed: job.seed,
      baked,
      conditioned: true,
    });
  }
  const crops = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    seed: seed ?? listed.seed,
    lon0: listed.lon0,
    project: project || listed.project,
    api: true,
    crops,
    jobs: listJobs(project),
  };
}

export async function pipelineStatus(root, {project, seed} = {}) {
  const fact = await pipelineFact(root, {project, seed});
  const running = listJobs(project).filter((j) => j.status !== "done" && j.status !== "error");
  const regional = fact.stages.find((s) => s.id === "regional");
  if (regional && running.length) {
    regional.fact = running[0].status === "baking"
      ? `baking ${running[0].name}`
      : `${running[0].status} ${running[0].name}`;
    regional.canBake = false;
  }
  return {
    ...fact,
    jobs: listJobs(project),
  };
}
