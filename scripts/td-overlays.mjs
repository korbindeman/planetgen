/**
 * List a project's terrain-diffusion crops and serve their files.
 *
 * A crop is a folder preview/<name>/crop-<id>/. The folder is the record;
 * the files inside say how far it has got. Jobs, manifests and paint
 * caches do not invent or replace that record.
 */
import { readdir, stat } from "node:fs/promises";
import { join, normalize, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));
const Projects = require(join(here, "..", "src", "projects"));
const Cube = require(join(here, "..", "src", "cubesphere.js"));

const PROJECT_PREFIX = "/preview/";


export function projectBakeDir(root, project, variant) {
  return join(root, Projects.bakeDir(project, variant || undefined));
}

export function projectUrlPrefix(project, variant) {
  return `/${Projects.bakeDir(Projects.byName(project).name, variant || undefined)}/`;
}

function sameSeed(a, b) {
  return Projects.sameSeed(a, b);
}

export async function readTiffBounds(path) {
  let buf;
  try {
    buf = Buffer.from(await Bun.file(path).arrayBuffer());
  } catch {
    return null;
  }
  if (buf.length < 16 || buf.toString("ascii", 0, 2) !== "II" || buf.readUInt16LE(2) !== 42) {
    return null;
  }
  const ifd = buf.readUInt32LE(4);
  if (ifd + 2 > buf.length) return null;
  const n = buf.readUInt16LE(ifd);
  let w = 0;
  let h = 0;
  let scaleOff = 0;
  let tieOff = 0;
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12;
    if (o + 12 > buf.length) return null;
    const id = buf.readUInt16LE(o);
    const value = buf.readUInt32LE(o + 8);
    if (id === 256) w = value;
    else if (id === 257) h = value;
    else if (id === 33550) scaleOff = value;
    else if (id === 33922) tieOff = value;
  }
  if (!w || !h || scaleOff + 16 > buf.length || tieOff + 40 > buf.length) return null;
  const sx = buf.readDoubleLE(scaleOff);
  const sy = buf.readDoubleLE(scaleOff + 8);
  const west = buf.readDoubleLE(tieOff + 24);
  const north = buf.readDoubleLE(tieOff + 32);
  if (![sx, sy, west, north].every(Number.isFinite) || sx === 0 || sy === 0) return null;
  return {
    west,
    north,
    east: west + sx * w,
    south: north - sy * h,
  };
}

/*
 * Where a tile raster actually belongs. Written by submitJob, and the reason
 * the nominal lon/lat box in the GeoTIFF never has to be believed.
 */
async function readTileSidecar(dir) {
  let raw;
  try {
    raw = await Bun.file(join(dir, "tile.json")).json();
  } catch {
    return null;
  }
  const {face, level, i, j} = raw || {};
  if (![face, level, i, j].every(Number.isInteger)) return null;
  if (face < 0 || face > 5 || level < 0 || level > 12) return null;
  const n = 1 << level;
  if (i < 0 || j < 0 || i >= n || j >= n) return null;
  return {
    face,
    level,
    i,
    j,
    project: raw.project || null,
    seed: raw.seed != null && raw.seed !== "" ? raw.seed : null,
    variant: raw.variant || null,
  };
}

async function readElevMeta(dir) {
  let meta;
  try {
    meta = await Bun.file(join(dir, "output.elev.json")).json();
  } catch {
    return null;
  }
  const width = meta && meta.width | 0;
  const height = meta && meta.height | 0;
  if (!(width > 0 && height > 0)) return null;
  if (!(await exists(join(dir, "output.elev")))) return null;
  return {width, height};
}

async function readManifest(dir) {
  try {
    return await Bun.file(join(dir, "manifest.json")).json();
  } catch {
    return {crops: [], seed: null, lon0: 0, project: null};
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listCropFolders(dir) {
  let entries;
  try {
    entries = await readdir(dir, {withFileTypes: true});
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && e.name.startsWith("crop-"));
}

/*
 * One folder, one crop. Presence of the directory is what makes it exist;
 * the files inside only say whether it is conditioned, baked, or a tile.
 * A new artifact (another dump, a sidecar) cannot hide the folder, and a
 * missing PNG cannot either — that is how a finished DEM used to vanish.
 */
async function readCrop(dir, folder, project, urlPrefix, listed, manifestSeed) {
  const name = folder.replace(/^crop-/, "");
  const folderPath = join(dir, folder);
  const heightmap = join(folderPath, "heightmap.tif");
  const hasHeightmap = await exists(heightmap);
  const hasPng = await exists(join(folderPath, "output.png"));
  const sidecar = await readTileSidecar(folderPath);
  const tile = sidecar
    ? {face: sidecar.face, level: sidecar.level, i: sidecar.i, j: sidecar.j}
    : Cube.parseTileName(name);
  const elevMeta = await readElevMeta(folderPath);
  if (!hasHeightmap && !hasPng && !elevMeta && !tile) return null;

  const bounds = (listed && Number.isFinite(listed.west) && listed)
    || (tile && Cube.tileBBox(tile))
    || (hasHeightmap ? await readTiffBounds(heightmap) : null);
  if (!bounds || ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) {
    return null;
  }

  const baked = !!elevMeta || hasPng;
  const seed = sidecar && sidecar.seed != null
    ? sidecar.seed
    : (listed && listed.seed != null ? listed.seed : manifestSeed);
  return {
    name,
    dir: folder,
    project: (sidecar && sidecar.project) || project,
    tile,
    west: bounds.west,
    south: bounds.south,
    east: bounds.east,
    north: bounds.north,
    seed,
    variant: sidecar && sidecar.variant || undefined,
    status: baked ? "done" : "conditioned",
    image: hasPng ? `${urlPrefix}${folder}/output.png` : null,
    elev: elevMeta ? `${urlPrefix}${folder}/output.elev` : null,
    elevWidth: elevMeta ? elevMeta.width : 0,
    elevHeight: elevMeta ? elevMeta.height : 0,
    baked,
    conditioned: hasHeightmap,
  };
}

export async function cropHasBake(dir) {
  return !!(await readElevMeta(dir)) || await exists(join(dir, "output.png"));
}

async function scanDir(dir, project, urlPrefix) {
  const manifest = await readManifest(dir);
  const byName = new Map((manifest.crops || []).map((c) => [c.name, c]));
  const crops = [];
  for (const entry of await listCropFolders(dir)) {
    const crop = await readCrop(
      dir, entry.name, project, urlPrefix,
      byName.get(entry.name.replace(/^crop-/, "")),
      manifest.seed,
    );
    if (crop) crops.push(crop);
  }
  return {
    seed: manifest.seed ?? null,
    lon0: manifest.lon0 ?? 0,
    project: manifest.project || project,
    crops,
  };
}

export async function listTdOverlays(root, opts = {}) {
  const project = opts.project || null;
  const seed = opts.seed;
  const variant = opts.variant && Projects.isVariantId(opts.variant) ? opts.variant : null;
  const found = [];

  async function take(dir, proj, prefix) {
    if (!(await exists(dir))) return;
    const listed = await scanDir(dir, proj, prefix);
    found.push(...listed.crops);
    return listed;
  }

  let seedHint = null;
  let lon0 = 0;

  if (project) {
    const own = await take(
      projectBakeDir(root, project, variant),
      project,
      projectUrlPrefix(project, variant),
    );
    if (own) {
      seedHint = own.seed;
      lon0 = own.lon0;
    }
  } else {
    for (const p of Projects.PROJECTS) {
      await take(projectBakeDir(root, p.name), p.name, projectUrlPrefix(p.name));
    }
  }

  let crops = project ? found.filter((c) => c.project === project) : found;
  if (seed != null && seed !== "") {
    crops = crops.filter((c) => sameSeed(c.seed, seed));
  }
  crops.sort((a, b) => a.name.localeCompare(b.name));
  if (variant) {
    for (const crop of crops) crop.variant = variant;
  }
  return {
    seed: seedHint,
    lon0,
    project,
    variant,
    crops,
  };
}

export async function pipelineFact(root, {project, seed, variant}) {
  const authored = Projects.byName(project).pipeline || {};
  const listed = await listTdOverlays(root, {project, variant});
  const matching = variant
    ? listed.crops
    : (seed != null && seed !== ""
      ? listed.crops.filter((c) => sameSeed(c.seed, seed))
      : listed.crops);
  const otherSeed = !variant && listed.crops.length > 0 && matching.length === 0;

  const conditioned = matching.filter((c) => c.conditioned);
  const baked = matching.filter((c) => c.baked);

  function stage(id, fact, extra) {
    const intent = authored[id];
    const empty = (intent == null || intent === "") && (fact == null || fact === "");
    return {
      id,
      label: Projects.STAGES.find((s) => s.id === id).label,
      title: Projects.STAGES.find((s) => s.id === id).title,
      intent: intent || "",
      fact: fact || "",
      empty,
      later: intent === "later",
      ...extra,
    };
  }

  const stale = otherSeed ? "stale" : "";
  const condFact = conditioned.length
    ? `${conditioned.length} crop${conditioned.length === 1 ? "" : "s"}`
    : stale;
  const regionalFact = baked.length || conditioned.length
    ? `${baked.length} of ${Math.max(conditioned.length, baked.length)}`
    : stale;

  return {
    project,
    seed: seed ?? null,
    variant: variant || null,
    stages: Projects.STAGES.map((s) => {
      if (s.id === "base") return stage("base", "on screen");
      if (s.id === "conditioning") return stage("conditioning", condFact);
      if (s.id === "regional") {
        return stage("regional", regionalFact, {
          canBake: !otherSeed && (conditioned.length === 0 || baked.length < conditioned.length),
          unfinished: Math.max(0, conditioned.length - baked.length),
        });
      }
      return stage(s.id, "");
    }),
    crops: matching,
  };
}

function safeFile(rootDir, pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const rel = decodeURIComponent(pathname.slice(prefix.length));
  if (!rel || rel.includes("\0")) return null;
  const filePath = normalize(join(rootDir, rel));
  const inside = relative(rootDir, filePath);
  if (!inside || inside.startsWith("..") || inside.split(sep).includes("..")) return null;
  return filePath;
}

export async function serveTdFile(root, pathname) {
  if (!pathname.startsWith(PROJECT_PREFIX)) return null;
  const slug = decodeURIComponent(pathname.slice(PROJECT_PREFIX.length)).split("/")[0];
  if (!slug) return null;
  let project;
  try {
    project = Projects.byName(slug).name;
  } catch {
    return null;
  }
  const filePath = safeFile(projectBakeDir(root, project), pathname, projectUrlPrefix(project));
  if (!filePath) return new Response("Not Found", {status: 404});
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("Not Found", {status: 404});
  return new Response(file);
}
