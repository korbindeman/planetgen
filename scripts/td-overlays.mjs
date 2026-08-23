/**
 * List a project's terrain-diffusion crops and serve their files.
 *
 * Writes live in preview/<name>/.
 */
import { stat } from "node:fs/promises";
import { join, normalize, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));
const Projects = require(join(here, "..", "src", "projects"));

const PROJECT_PREFIX = "/preview/";


export function projectBakeDir(root, project) {
  return join(root, Projects.dir(project));
}

export function projectUrlPrefix(project) {
  return `${PROJECT_PREFIX}${Projects.byName(project).name}/`;
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
  return {face, level, i, j};
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

async function scanDir(root, dir, project, urlPrefix) {
  const manifest = await readManifest(dir);
  const byName = new Map((manifest.crops || []).map((c) => [c.name, c]));
  const crops = [];
  const seen = new Set();
  for (const pattern of ["crop-*/heightmap.tif", "crop-*/output.png"]) {
    for await (const rel of new Bun.Glob(pattern).scan({cwd: dir})) {
      const folder = rel.split("/")[0];
      if (seen.has(folder)) continue;
      seen.add(folder);
      const name = folder.replace(/^crop-/, "");
      const folderPath = join(dir, folder);
      const heightmap = join(folderPath, "heightmap.tif");
      const outputPng = join(folderPath, "output.png");
      if (!(await exists(heightmap)) && !(await exists(outputPng))) continue;

      const listed = byName.get(name);
      const bounds = listed && Number.isFinite(listed.west)
        ? listed
        : await readTiffBounds(heightmap);
      if (!bounds || ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) {
        continue;
      }

      const tile = await readTileSidecar(folderPath);
      /*
       * The baked DEM in raw float metres, which is what the app draws from:
       * it colours the tile with the globe's own look rather than pasting a
       * PNG that was coloured once, at bake time, by whatever the settings
       * were then.
       */
      const elevMeta = await readElevMeta(folderPath);
      /*
       * The elevation dump *is* the bake. A crop whose output.png never got
       * written — the paint step died, or the run was interrupted — still has
       * a real DEM, and used to sit in the list looking unbaked while its
       * result lay on disk unread.
       *
       * These two are deliberately separate. `baked` says a result exists;
       * `hasPng` says the fallback picture exists. Deriving the image url
       * from `baked` would point it at a PNG that was never written.
       */
      const hasPng = await exists(outputPng);
      const baked = !!elevMeta || hasPng;

      crops.push({
        name,
        dir: folder,
        project,
        tile,
        west: bounds.west,
        south: bounds.south,
        east: bounds.east,
        north: bounds.north,
        seed: listed && listed.seed != null ? listed.seed : manifest.seed,
        /* "conditioned" means the GeoTIFFs the model reads exist but the
         * bake has not run. It used to be called "sketch", which told you
         * nothing about what to do next. */
        status: baked ? "done" : "conditioned",
        image: hasPng ? `${urlPrefix}${folder}/output.png` : null,
        elev: elevMeta ? `${urlPrefix}${folder}/output.elev` : null,
        elevWidth: elevMeta ? elevMeta.width : 0,
        elevHeight: elevMeta ? elevMeta.height : 0,
        baked,
        conditioned: await exists(heightmap),
      });
    }
  }
  return {
    seed: manifest.seed ?? null,
    lon0: manifest.lon0 ?? 0,
    project: manifest.project || project,
    crops,
  };
}

/*
 * The same crop can be listed twice if a scan overlaps. Take the better of
 * each *part* rather than the later folder, so a crop is never made worse
 * by whichever copy happened to be scanned first.
 */
function mergeCrop(prev, next) {
  if (!prev) return next;
  const base = next.baked && !prev.baked ? next : prev;
  const other = base === next ? prev : next;
  const elevFrom = base.elev ? base : other;
  return {
    ...base,
    image: base.image || other.image,
    elev: elevFrom.elev,
    elevWidth: elevFrom.elevWidth,
    elevHeight: elevFrom.elevHeight,
    tile: base.tile || other.tile,
    baked: base.baked || other.baked,
    conditioned: base.conditioned || other.conditioned,
    status: base.baked || other.baked ? "done" : base.status,
  };
}

export async function listTdOverlays(root, opts = {}) {
  const project = opts.project || null;
  const seed = opts.seed;
  const byKey = new Map();

  async function take(dir, proj, prefix) {
    if (!(await exists(dir))) return;
    const listed = await scanDir(root, dir, proj, prefix);
    for (const crop of listed.crops) {
      const key = `${crop.project}/${crop.name}`;
      byKey.set(key, mergeCrop(byKey.get(key), crop));
    }
    return listed;
  }

  let seedHint = null;
  let lon0 = 0;

  if (project) {
    const own = await take(projectBakeDir(root, project), project, projectUrlPrefix(project));
    if (own) {
      seedHint = own.seed;
      lon0 = own.lon0;
    }
  } else {
    for (const p of Projects.PROJECTS) {
      await take(projectBakeDir(root, p.name), p.name, projectUrlPrefix(p.name));
    }
  }

  let crops = [...byKey.values()];
  if (project) crops = crops.filter((c) => c.project === project);
  if (seed != null && seed !== "") {
    crops = crops.filter((c) => sameSeed(c.seed, seed) || c.seed == null || c.seed === "");
  }
  crops.sort((a, b) => a.name.localeCompare(b.name));
  return {
    seed: seedHint,
    lon0,
    project,
    crops,
  };
}

export async function pipelineFact(root, {project, seed}) {
  const authored = Projects.byName(project).pipeline || {};
  const all = await listTdOverlays(root, {project});
  const matching = seed != null && seed !== ""
    ? all.crops.filter((c) => sameSeed(c.seed, seed) || c.seed == null || c.seed === "")
    : all.crops;
  const otherSeed = all.crops.length > 0 && matching.length === 0;

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
