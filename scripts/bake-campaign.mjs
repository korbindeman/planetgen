#!/usr/bin/env bun
/**
 * The planet-scale bake: every tile of a level, face by face.
 *
 *   bun run bake:campaign --project=quarter --variant-name=glep --level=3
 *   bun run bake:campaign --project=quarter --variant-name=glep --dry-run
 *   bun run bake:campaign ... --shards=2 --shard=0
 *
 * This is not `bake:tiles` in a loop, and the difference is the whole point.
 *
 * `bake:tiles` imports one tile's conditioning per bake. Every
 * `set_custom_conditioning_import` calls `rebuild()`, which installs a fresh
 * tile store, so two tiles that touch come out of two diffusions that never
 * shared a parent latent. Measured on f0l4x1y8/f0l4x1y9: the edge they share
 * disagrees by 269 m on average and 1351 m at worst, where one row to the
 * next inside a tile moves 9 m. The landforms line up (r = 0.88, they read
 * the same sketch) and the detail does not. In hillshade it is a faint line;
 * in elevation it is a few hundred metres of terrace at every tile boundary
 * on the planet, and hydrology would run on it.
 *
 * So the campaign imports the conditioning **once per face** and then asks
 * for each tile as a window of it — which is what docs/stages/terrain.md
 * said to do all along. The face raster is built at level 0 with
 * `(1 << level) * cells`, so `stereoCellSize` gives bit-identical steps and
 * the windows land on the tiles' own lattice. Same pair, same measurement,
 * after: 1.7 m mean, 37 m max. Same-face joins stop being a seam.
 *
 * A cube fold is still two faces and two imports, so folds keep the halo and
 * the existing stitch. Face order is fixed, so first-baked owns the edge.
 *
 * Resumable: a tile with output.elev and a matching tile.json is skipped, so
 * an interrupted overnight run picks up where it stopped.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTdFolder, hillshadePng } from "./td-geotiff.mjs";
import { projectBakeDir } from "./td-overlays.mjs";
import { resolveRun } from "./project-run.mjs";
import { finishBake, runOnWorker, stopTdWorker, tdWsl, toWslPath } from "./td-jobs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Cube = require(join(root, "src", "cubesphere.js"));
const Planet = require(join(root, "src", "planet.js"));
const Projects = require(join(root, "src", "projects"));
const TdExport = require(join(root, "src", "td-export.js"));
const TdTile = require(join(root, "src", "td-tile.js"));
const Tectonics = require(join(root, "src", "tectonics.js"));
const {decodePng, encodePng} = require(join(root, "src", "png.js"));

const MODEL = "xandergos/terrain-diffusion-90m";
const SNR = "0.2,0.2,1.0,0.2,1.0";
/* Native grain. The studio's 128 is a preview at ~180 m; a campaign that
 * threw away half the model's resolution would not be a 90 m planet. */
const PX_PER_CELL = 256;

function parseArgs(argv) {
  const out = {shards: 1, shard: 0, dryRun: false, level: null, force: false, limit: 0,
    mask: false, shelfM: 0, rings: 1};
  for (const arg of argv) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--force") out.force = true;
    else if (arg.startsWith("--project=")) out.project = arg.slice(10);
    else if (arg.startsWith("--variant=")) out.variant = arg.slice(10);
    else if (arg.startsWith("--variant-name=")) out.variantName = arg.slice(15);
    else if (arg.startsWith("--level=")) out.level = Number(arg.slice(8)) | 0;
    else if (arg.startsWith("--shards=")) out.shards = Math.max(1, Number(arg.slice(9)) | 0);
    else if (arg.startsWith("--shard=")) out.shard = Math.max(0, Number(arg.slice(8)) | 0);
    else if (arg.startsWith("--limit=")) out.limit = Math.max(0, Number(arg.slice(8)) | 0);
    else if (arg.startsWith("--px-per-cell=")) out.pxPerCell = Number(arg.slice(14)) | 0;
    else if (arg === "--mask") out.mask = true;
    else if (arg.startsWith("--shelf-m=")) { out.mask = true; out.shelfM = Number(arg.slice(10)); }
    else if (arg.startsWith("--mask-rings=")) { out.mask = true; out.rings = Number(arg.slice(13)) | 0; }
    else if (arg.startsWith("--mask-preview=")) { out.mask = true; out.maskPreview = arg.slice(15); }
    /* A named block, for proving a region before committing the night. */
    else if (arg.startsWith("--tiles=")) out.tiles = arg.slice(8).split(",").map((s) => {
      const tile = Cube.parseTileName(s.trim());
      if (!tile) throw new Error(`not a tile name: ${s}`);
      return tile;
    });
    else throw new Error(`unknown arg: ${arg}`);
  }
  if (out.shard >= out.shards) throw new Error(`shard ${out.shard} of ${out.shards}`);
  return out;
}

/* Any partition of the tile list is a valid shard — `get()` is a pure
 * function of (seed, coords) plus a bounded parent window. Contiguous by
 * face rather than round-robin, so a shard imports each face once. */
function shardOf(tiles, shards, shard) {
  const per = Math.ceil(tiles.length / shards);
  return tiles.slice(shard * per, (shard + 1) * per);
}

function listTiles(level) {
  const n = 1 << level;
  const out = [];
  for (let face = 0; face < 6; face++)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out.push({face, level, i, j});
  return out;
}

/*
 * Where a rect's raster sits in the model's (i, j), given that the model
 * indexes an import [row, col] from (origin_i, origin_j).
 *
 * `bakeDirection` is the authority on what a rasterized rect's cells mean:
 * column x is X = originI + x, and row y is Y = originJ + height - y. The Y
 * axis is *flipped* — row 0 is the highest Y — which is the part that makes
 * this more than a transpose. Composing the two gives one frame for the whole
 * face: i = -Y and j = X. Then a tile's window is just its own rect written
 * the same way, and every window of a face is addressed consistently.
 *
 * `bake:tiles` passes originI/originJ straight through and is not wrong,
 * because it imports and reads back through the same mapping and a lone tile
 * does not care which absolute cells it sat on. Sharing one import across a
 * face is what makes the frame matter. Getting it wrong put windows on the
 * wrong ground: open ocean baked over tiles the sketch calls 100% land, and
 * neighbours that still agreed with each other, so only the land-fraction
 * check against the sketch could see it.
 */
function latticeOrigin(rect) {
  return {origin_i: -(rect.originJ + rect.height), origin_j: rect.originI};
}

/*
 * The land-and-shelf mask: which tiles are worth 90 m.
 *
 * The abyss is a smooth plain the model has little to say about, it is never
 * landed on, and on this planet it is half the sphere. Skipping it is the
 * "mask to land and shelf" trial docs/stages/terrain.md has open.
 *
 * A tile is kept if any of its conditioning cells is above `shelfM`, and then
 * the set is grown by `rings` whole tiles. The growth is the point and is not
 * an optimisation: a tile that merely *contains* land still ends at a tile
 * edge, so without a ring the DEM would stop within 313 km of a shore and the
 * boundary would be visible from the beach. One ring puts a full tile of
 * baked seabed beyond every coast. Growth crosses folds, because
 * `neighborTile` does.
 *
 * What this costs downstream: skipped tiles have no 90 m DEM at all, so
 * anything reading the bake needs the coarse sketch as its fallback there.
 * That is a real gap, not a lower level of detail.
 */
function coastMask(names, infoOf, {shelfM = 0, rings = 1} = {}) {
  let keep = new Set(names.filter((name) => infoOf(name).maxM > shelfM));
  for (let r = 0; r < rings; r++) {
    const grown = new Set(keep);
    for (const name of keep) {
      for (const nb of neighbourhood(infoOf(name).tile)) grown.add(Cube.tileName(nb));
    }
    keep = grown;
  }
  /*
   * Fill single-tile holes. A skipped tile with kept tiles all round it is a
   * 313 km square of missing DEM in the middle of ground we are baking
   * anyway — worse than the abyss it was meant to save, because you reach it
   * by flying over finished seabed. Cheap to close, and it costs a handful
   * of tiles.
   */
  for (const name of names) {
    if (keep.has(name)) continue;
    const around = neighbourhood(infoOf(name).tile);
    if (around.length && around.every((nb) => keep.has(Cube.tileName(nb)))) keep.add(name);
  }
  return keep;
}

/*
 * The eight tiles touching this one, corners included. Corners matter here:
 * with edge neighbours alone the mask can leave a skipped tile touching a
 * land tile at a point, so the DEM ends exactly at the corner of a coast.
 * `neighborTile` only crosses edges, so a diagonal is two steps — and taking
 * both orders and de-duplicating is what keeps it honest at a cube corner,
 * where the two paths do not always arrive at the same tile.
 */
function neighbourhood(tile) {
  const out = new Map();
  const add = (t) => { if (t) out.set(Cube.tileName(t), t); };
  for (const edge of Cube.EDGES) add(Cube.neighborTile(tile, edge));
  /* Only the perpendicular pairs are diagonals. Stepping north then north
   * again is two tiles away, not a corner, and folding that in would grow
   * the mask by a second ring in the four cardinal directions. */
  for (const ns of ["north", "south"]) {
    const side = Cube.neighborTile(tile, ns);
    if (!side) continue;
    for (const ew of ["east", "west"]) add(Cube.neighborTile(side, ew));
  }
  out.delete(Cube.tileName(tile));
  return [...out.values()];
}

/*
 * The mask, drawn over the project's equirect so it can be judged as a
 * picture rather than as a tile count. Skipped ground is tinted red; kept
 * ground is left alone. What you are looking for is red never touching a
 * coastline — the whole question is whether the mask hugs it.
 */
async function writeMaskPreview(outPath, keep, level) {
  const src = join(root, Projects.dir(run.project), "equirect.png");
  const img = decodePng(await readFile(src));
  const {width, height} = img;
  const rgba = Buffer.from(img.rgba);
  for (let y = 0; y < height; y++) {
    const lat = 90 - (y + 0.5) / height * 180;
    for (let x = 0; x < width; x++) {
      const lon = (x + 0.5) / width * 360 - 180;
      if (keep.has(Cube.tileName(Cube.tileAt(lon, lat, level)))) continue;
      const k = (y * width + x) * 4;
      rgba[k] = Math.min(255, rgba[k] * 0.45 + 130);
      rgba[k + 1] = rgba[k + 1] * 0.35;
      rgba[k + 2] = rgba[k + 2] * 0.35;
    }
  }
  await writeFile(outPath, encodePng(rgba, width, height));
}

/* Max elevation and land share of a tile's conditioning, in metres. Read off
 * the sketch, so deciding the mask costs no GPU. */
function tileRelief(planet, tile, cells) {
  const halo = TdTile.haloCellsFor(tile);
  const rect = Cube.tileBakeRect(tile, cells, 0, Object.values(halo).some(Boolean) ? halo : null);
  const raw = Planet.rasterizeBakeRect(planet.mesh, planet.map, tile, rect, 0);
  const n = rect.width * rect.height;
  let maxM = -Infinity, land = 0;
  for (let k = 0; k < n; k++) {
    const m = Tectonics.elevationToMeters(raw.elev[k]);
    if (m > maxM) maxM = m;
    if (m > 0) land++;
  }
  return {tile, maxM, land: n ? land / n : 0};
}

/* How far a tile's baked land fraction may sit from its sketch's before it
 * counts as a bake that is not reading its own conditioning. Wide, because
 * the model does move a coastline: this is a wrong-ground alarm, not a
 * quality bar. The transposition it caught was 100% land against ~0%. */
const LAND_TOLERANCE = 0.25;

async function readElev(path) {
  const meta = JSON.parse(await readFile(path + ".json", "utf8"));
  const buf = await readFile(path);
  return new Float32Array(buf.buffer, buf.byteOffset, meta.width * meta.height);
}

function fraction(values, predicate) {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (predicate(values[i])) n++;
  return values.length ? n / values.length : 0;
}

async function alreadyBaked(dir, pxPerCell) {
  try {
    const meta = JSON.parse(await readFile(join(dir, "tile.json"), "utf8"));
    if (meta.pxPerCell !== pxPerCell) return false;
    return await Bun.file(join(dir, "output.elev")).exists();
  } catch {
    return false;
  }
}

const args = parseArgs(process.argv.slice(2));
const pxPerCell = args.pxPerCell || PX_PER_CELL;

/* --dry-run and --mask-preview decide from the sketch and never reach a GPU. */
if (!tdWsl() && !args.dryRun && !args.maskPreview) {
  console.error("TD_WSL is not set. A campaign wants the WSL2 worker: torch.compile is");
  console.error("unsupported on Windows and the model would reload for every tile.");
  console.error("  TD_WSL=1 bun run bake:campaign ...   (docs/ref/wsl-bake-env.md)");
  process.exit(2);
}

const run = await resolveRun(root, Projects, args.project, null, args.variant);
let variantId = run.variant;
let values = run.values;
let seed = run.seed;
if (args.variantName) {
  const raw = JSON.parse(await readFile(join(root, Projects.catalogPath(run.project)), "utf8"));
  const catalog = Projects.parseCatalog(raw, run.project);
  const want = args.variantName.toLowerCase();
  const found = Projects.Variants.live(catalog.variants)
    .find((v) => String(v.name || "").toLowerCase() === want);
  if (!found) throw new Error(`no live variant named "${args.variantName}" in ${run.project}`);
  variantId = found.id;
  seed = found.seed;
  values = Projects.recipeOf(found, Projects.byName(run.project).body);
}
if (!variantId) throw new Error("a campaign bakes a saved variant — pass --variant-name or --variant");

const planet = Planet.generatePlanet({
  seed, project: run.project, values,
  simulateTectonics: true, polarStraits: true, detailPass: true, quiet: true,
});
const radiusKm = planet.body.radiusKm;
const level = args.level || Cube.bestLevel(
  TdTile.TARGET_TILE_KM, radiusKm, TdTile.SCALE_KM,
  TdTile.MIN_CELLS, TdTile.MAX_CELLS, TdTile.SEAM_HALO_CELLS,
);
const cells = Cube.tileCells(level, radiusKm, TdTile.SCALE_KM);
const bakeDir = projectBakeDir(root, run.project, variantId);
const all = args.tiles || listTiles(level);
const mine = args.tiles || shardOf(all, args.shards, args.shard);
if (args.tiles && args.tiles.some((t) => t.level !== level)) {
  throw new Error(`--tiles are level ${args.tiles[0].level}, campaign level is ${level}`);
}

console.log(`project ${run.project}  variant ${variantId}  seed ${seed}`);
console.log(`radius ${radiusKm} km  level ${level}  ${cells} cells/tile`
  + `  ${Cube.tileEdgeKm(level, radiusKm).toFixed(0)} km/tile  ${pxPerCell} px/cell`);
console.log(`${all.length} tiles, shard ${args.shard}/${args.shards} takes ${mine.length}`);
console.log(`bake dir ${bakeDir}`);

/* What it costs, from the rects themselves rather than a rule of thumb. */
let px = 0;
for (const tile of mine) {
  const halo = TdTile.haloCellsFor(tile);
  const r = Cube.tileBakeRect(tile, cells, 0, Object.values(halo).some(Boolean) ? halo : null);
  px += r.width * r.height * pxPerCell * pxPerCell;
}
const RATE = 0.53e6;
console.log(`${(px / 1e9).toFixed(1)} Gpx to generate — about `
  + `${(px / RATE / 3600).toFixed(1)} h at the measured 0.53 Mpx/s`);
console.log(`~${(mine.length * cells * cells * pxPerCell * pxPerCell * 4 / 1e9).toFixed(0)} GB of float32 output`);

let masked = null;
if (args.mask) {
  const info = new Map();
  for (const tile of all) info.set(Cube.tileName(tile), tileRelief(planet, tile, cells));
  const infoOf = (name) => info.get(name);
  masked = coastMask([...info.keys()], infoOf, {shelfM: args.shelfM, rings: args.rings});
  const withLand = [...info.values()].filter((v) => v.land > 0).length;
  const droppedLand = [...info.entries()].filter(([n, v]) => v.land > 0 && !masked.has(n));
  console.log(`mask: keep ${masked.size}/${all.length} tiles`
    + ` (above ${args.shelfM} m, grown ${args.rings} ring${args.rings === 1 ? "" : "s"})`
    + `  — ${all.length - masked.size} abyss tiles skipped`);
  console.log(`  ${withLand} tiles carry land; ${droppedLand.length} of those would be dropped`);
  /* The one thing the mask must never do. Cheap to assert, and a wrong
   * shelfM or a broken neighbour walk shows up here rather than as a hole
   * in the finished planet. */
  if (droppedLand.length) {
    throw new Error(`mask drops ${droppedLand.length} tiles that contain land: `
      + droppedLand.slice(0, 5).map(([n]) => n).join(", "));
  }
  if (args.maskPreview) {
    await writeMaskPreview(args.maskPreview, masked, level);
    console.log(`  mask preview: ${args.maskPreview}`);
    process.exit(0);
  }
}

const todo = [];
let skippedByMask = 0, alreadyDone = 0;
for (const tile of mine) {
  const name = Cube.tileName(tile);
  if (masked && !masked.has(name)) { skippedByMask++; continue; }
  const dir = join(bakeDir, `crop-${name}`);
  if (!args.force && await alreadyBaked(dir, pxPerCell)) { alreadyDone++; continue; }
  todo.push({tile, name, dir});
}
console.log(`${alreadyDone} already baked`
  + (skippedByMask ? `, ${skippedByMask} skipped by the mask` : "")
  + `, ${todo.length} to go`);
if (args.limit) todo.splice(args.limit);

if (args.dryRun) {
  console.log(`dry run — first tiles: ${todo.slice(0, 5).map((t) => t.name).join(", ")}`);
  process.exit(0);
}

const spec = {model: MODEL, snr: SNR, seed: Number(seed) | 0, device: "cuda"};
const progressPath = join(bakeDir, "campaign.jsonl");
await mkdir(bakeDir, {recursive: true});

/* One import per face, held for every window of it. */
let importedFace = -1;
async function importFace(face, job) {
  const faceTile = {face, level: 0, i: 0, j: 0};
  const faceCells = (1 << level) * cells;
  const faceRect = Cube.tileBakeRect(faceTile, faceCells, TdTile.CONTEXT_PAD, null);
  const raw = Planet.rasterizeBakeRect(planet.mesh, planet.map, faceTile, faceRect, 0);
  const layers = TdExport.fieldsToTdLayers(raw, faceRect.width, faceRect.height, (row) => {
    const mid = Cube.xyzToLonLat(
      Cube.bakeDirection(faceTile, faceRect, faceRect.width / 2, row + 0.5),
    );
    return mid.lat * Math.PI / 180;
  });
  const faceDir = join(bakeDir, `face-${face}`);
  await writeTdFolder(faceDir, layers, Cube.tileBBox(faceTile));
  const res = await runOnWorker(root, spec, job, {
    op: "import", name: `face-${face}`,
    tiff_dir: toWslPath(faceDir),
    ...latticeOrigin(faceRect),
  });
  if (!res.ok) throw new Error(`face ${face} import failed: ${res.error}`);
  importedFace = face;
  console.log(`  face ${face}: imported ${faceRect.width}x${faceRect.height} cells`
    + ` at (${faceRect.originI}, ${faceRect.originJ})`);
}

const started = Date.now();
let done = 0, failed = 0, mismatched = 0;
for (const {tile, name, dir} of todo) {
  const t0 = Date.now();
  const job = {
    dir, tile, name, log: [], status: "baking", progress: 0,
    project: run.project, variant: variantId, seed,
  };
  try {
    if (importedFace !== tile.face) await importFace(tile.face, job);

    const halo = TdTile.haloCellsFor(tile);
    const anyHalo = Object.values(halo).some(Boolean);
    const rect = Cube.tileBakeRect(tile, cells, 0, anyHalo ? halo : null);
    const bounds = Cube.tileBBox(tile);

    /* The painter reads this tile's own climate channels, so the crop still
     * gets conditioning GeoTIFFs — pad 0, because the bake took its context
     * from the face and this copy is only for colour. */
    const raw = Planet.rasterizeBakeRect(planet.mesh, planet.map, tile, rect, 0);
    const layers = TdExport.fieldsToTdLayers(raw, rect.width, rect.height, (row) => {
      const mid = Cube.xyzToLonLat(Cube.bakeDirection(tile, rect, rect.width / 2, row + 0.5));
      return mid.lat * Math.PI / 180;
    });
    await writeTdFolder(dir, layers, bounds);
    await writeFile(join(dir, "coarse.png"),
      hillshadePng(layers.heightmap, rect.width, rect.height));

    Object.assign(job, {
      cropW: rect.width, cropH: rect.height, padCells: 0,
      originI: rect.originI, originJ: rect.originJ, bakeStep: rect.step,
      tileCells: cells, haloCells: TdTile.SEAM_HALO_CELLS, pxPerCell,
      scaleKm: TdTile.SCALE_KM, ...bounds,
    });
    await writeFile(join(dir, "tile.json"), JSON.stringify({
      ...tile, name, project: run.project, seed, variant: variantId,
      scaleKm: TdTile.SCALE_KM, cells: rect.width, tileCells: cells,
      padCells: 0, originI: rect.originI, originJ: rect.originJ,
      bakeStep: rect.step, haloCells: TdTile.SEAM_HALO_CELLS, halo,
      pxPerCell, campaign: true, nominalBounds: bounds,
    }, null, 2));

    let res = await runOnWorker(root, spec, job, {
      op: "generate", name,
      /* The tile's own rect in the face's frame — see latticeOrigin. */
      start_i: latticeOrigin(rect).origin_i, start_j: latticeOrigin(rect).origin_j,
      w: rect.width, h: rect.height,
      output_elev: toWslPath(join(dir, "output.elev")),
      max_dim: Math.max(rect.width, rect.height) * pxPerCell,
    });
    if (!res.ok) {
      /* A worker that died takes its face import with it. Bring both back
       * once before giving up on the tile. */
      console.log(`  ${name}: ${res.error} — re-importing face and retrying`);
      importedFace = -1;
      await importFace(tile.face, job);
      res = await runOnWorker(root, spec, job, {
        op: "generate", name,
        start_i: latticeOrigin(rect).origin_i, start_j: latticeOrigin(rect).origin_j,
        w: rect.width, h: rect.height,
        output_elev: toWslPath(join(dir, "output.elev")),
        max_dim: Math.max(rect.width, rect.height) * pxPerCell,
      });
    }
    if (!res.ok) throw new Error(res.error || "generate failed");

    await finishBake(job);
    if (job.status === "error") throw new Error(job.error);

    /*
     * Does the DEM agree with the sketch it was conditioned on? Land fraction
     * is a scalar and needs no geometry, which is the point — it catches the
     * failure that geometry bugs produce and that a consistency check misses.
     * A transposed window read the face at the wrong place and baked open
     * ocean over tiles the sketch calls 100% land; every tile still agreed
     * with its neighbours, so only the sketch could tell us.
     */
    const baked = await readElev(join(dir, "output.elev"));
    const bakedLand = fraction(baked, (v) => v > 0);
    const sketchLand = fraction(layers.heightmap, (v) => v > 0);
    if (Math.abs(bakedLand - sketchLand) > LAND_TOLERANCE) {
      mismatched++;
      console.log(`  ${name}: land ${(bakedLand * 100).toFixed(0)}% but the sketch says`
        + ` ${(sketchLand * 100).toFixed(0)}% — the bake is not reading its own conditioning`);
      if (mismatched >= 3) {
        throw new Error("three tiles disagree with the sketch; stopping rather than baking all night");
      }
    }
    done++;
  } catch (err) {
    failed++;
    console.log(`  ${name}: FAILED ${err.message || err}`);
    await appendFile(progressPath,
      JSON.stringify({name, ok: false, error: String(err.message || err), at: Date.now()}) + "\n");
    continue;
  }
  const secs = (Date.now() - t0) / 1000;
  const left = todo.length - done - failed;
  const eta = left * ((Date.now() - started) / 1000 / Math.max(1, done));
  /* A fold tile conforms to whatever neighbour is already down. Say so, or a
   * whole night's folds are unobservable until someone crops one. */
  const stitched = job.log.filter((l) => l.startsWith("stitched")).join("; ");
  console.log(`  ${name}  ${secs.toFixed(0)}s   ${done}/${todo.length}`
    + `   eta ${(eta / 3600).toFixed(1)} h${stitched ? `   ${stitched}` : ""}`);
  await appendFile(progressPath,
    JSON.stringify({name, ok: true, seconds: secs, at: Date.now()}) + "\n");
}

stopTdWorker();
const hours = (Date.now() - started) / 3600000;
console.log(`\n${done} baked, ${failed} failed, ${hours.toFixed(2)} h`);
console.log(`look at it:  bun run seam ${join("preview", run.project, "v", variantId)} <tile>... --relief`);
process.exit(failed ? 1 : 0);
