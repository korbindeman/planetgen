#!/usr/bin/env bun
/**
 * Assemble the baked tiles into the six cube faces the game's terrain package
 * wants, and write them where a Rust producer can pick them up.
 *
 *   bun run build:cubemap --project=quarter --variant-name=glep --res=8192
 *
 * The package format is not ours. `crates/domain/terrain/src/package.rs` in
 * the game defines schema v1: a `Cubemap<u16>` of height goes in, and
 * `encode_height_pyramid` produces the whole pyramid itself — a 32² base per
 * face plus quantized signed-residual children, pruned where the parent
 * predictor is already within `max_fallback_error_m`. So this does not build
 * a pyramid. It builds the one input that pyramid is reduced from, which is
 * the "coarse levels are LOD of the full detail" property for free: every
 * level above the leaves is a reduction of these planes, never a second bake.
 *
 * ## Why this samples by direction rather than mapping tile to texel
 *
 * Two cube-sphere conventions are in play and they do not agree. Ours is
 * equal-angle with its own face order; the game's is the OpenGL cubemap
 * convention (`PosX, NegX, PosY, NegY, PosZ, NegZ`) with its own axis signs
 * and a flipped V. Mapping one to the other by hand is exactly the kind of
 * frame algebra that already cost a day on this bake — the transposed face
 * import baked ocean onto land and every tile still agreed with its
 * neighbours, so nothing but the sketch could see it.
 *
 * So this does not map. It ports the game's `face_uv_to_dir` verbatim, walks
 * *their* texels, and asks *our* planet what is at that direction. Any
 * disagreement about face order or orientation cancels, because only one
 * convention is ever evaluated. The cost is a gather per texel instead of a
 * scatter per tile, which is slower and worth it.
 *
 * Where the mask skipped a tile there is no DEM, so the coarse sketch fills
 * in. That is the fallback the mask always implied: a gap in the 90 m data,
 * not a gap in the planet.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectBakeDir } from "./td-overlays.mjs";
import { resolveRun } from "./project-run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Cube = require(join(root, "src", "cubesphere.js"));
const Planet = require(join(root, "src", "planet.js"));
const Projects = require(join(root, "src", "projects"));
const TdTile = require(join(root, "src", "td-tile.js"));
const Tectonics = require(join(root, "src", "tectonics.js"));

/* The game's face order, by discriminant. Do not reorder: the package writes
 * faces in this order and the reader indexes them by it. */
const FACES = ["PosX", "NegX", "PosY", "NegY", "PosZ", "NegZ"];

/*
 * Ported verbatim from `dir_to_face_uv`'s inverse in
 * crates/domain/terrain/src/cubemap.rs. If that file changes, this changes.
 * `v` runs top-to-bottom because face data is stored row-major, top first.
 */
function faceUvToDir(face, u, v) {
  const sc = u * 2 - 1;
  const tc = v * 2 - 1;
  let d;
  switch (face) {
    case "PosX": d = [1, -tc, -sc]; break;
    case "NegX": d = [-1, -tc, sc]; break;
    case "PosY": d = [sc, 1, tc]; break;
    case "NegY": d = [sc, -1, -tc]; break;
    case "PosZ": d = [sc, -tc, 1]; break;
    case "NegZ": d = [-sc, -tc, -1]; break;
    default: throw new Error(`unknown face ${face}`);
  }
  const len = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / len, d[1] / len, d[2] / len];
}

/*
 * The two frames do not share an up axis, and nothing in either codebase says
 * so out loud.
 *
 * This repo is z-up: `lonLatToXyz` puts latitude on z, so the pole is +Z.
 * The game is glam/y-up, and its cubemap's `PosY` face is the pole. Feeding a
 * game-frame direction straight into `xyzToLonLat` therefore reads the game's
 * north pole as our equator and lays the planet on its side — ice caps down
 * the middle of a face.
 *
 * So: game +Y becomes our +Z. The remaining freedom is a sign, and it is not
 * free: `(gx, gz, gy)` has determinant -1 and would ship a mirrored planet,
 * with every coastline handed the wrong way round. `(gx, -gz, gy)` is the
 * proper rotation.
 */
function gameDirToOurs(d) {
  return [d[0], -d[2], d[1]];
}

/*
 * An identity for these planes, to be mixed into the package's content key.
 *
 * The game namespaces its memory and disk tile caches by the package
 * fingerprint precisely so "a rebake cannot reuse stale reconstructed tiles".
 * That key is computed from the *body's* terrain config, which does not change
 * when we swap a different height cubemap underneath it — so without this,
 * two different planets would share a key and the game would happily serve
 * tiles reconstructed from the previous one.
 *
 * FNV-1a over the fields that decide the heights, in BigInt because the key
 * is 64-bit and JS numbers are not.
 */
function sourceKey(m) {
  const text = [
    m.body, m.variant, String(m.seed), String(m.resolution),
    String(m.radius_m), String(m.height_range_m),
    String(m.source.level), String(m.source.tiles),
    m.observed_min_m.toFixed(3), m.observed_max_m.toFixed(3),
  ].join("|");
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash ^ BigInt(text.charCodeAt(i) & 0xff)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function parseArgs(argv) {
  const out = {res: 8192, level: 3};
  for (const arg of argv) {
    if (arg.startsWith("--project=")) out.project = arg.slice(10);
    else if (arg.startsWith("--variant=")) out.variant = arg.slice(10);
    else if (arg.startsWith("--variant-name=")) out.variantName = arg.slice(15);
    else if (arg.startsWith("--res=")) out.res = Number(arg.slice(6)) | 0;
    else if (arg.startsWith("--level=")) out.level = Number(arg.slice(8)) | 0;
    else if (arg.startsWith("--out=")) out.out = arg.slice(6);
    else throw new Error(`unknown arg: ${arg}`);
  }
  /* encode_height_pyramid rejects anything else, and it is better to fail
   * here than after an hour of sampling. */
  const base = 32;
  if (out.res < base || (out.res & (out.res - 1)) !== 0 || (out.res / base) % 1 !== 0
      || ((out.res / base) & (out.res / base - 1)) !== 0) {
    throw new Error(`--res must be a power-of-two multiple of ${base}, got ${out.res}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
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
  if (!found) throw new Error(`no live variant named "${args.variantName}"`);
  variantId = found.id;
  seed = found.seed;
  values = Projects.recipeOf(found, Projects.byName(run.project).body);
}

const planet = Planet.generatePlanet({
  seed, project: run.project, values,
  simulateTectonics: true, polarStraits: true, detailPass: true, quiet: true,
});
const radiusKm = planet.body.radiusKm;
const level = args.level;
const cells = Cube.tileCells(level, radiusKm, TdTile.SCALE_KM);
const bakeDir = projectBakeDir(root, run.project, variantId);
const outDir = args.out || join(root, "bake", `${run.project}-${variantId}-cubemap`);

console.log(`project ${run.project}  variant ${variantId}  radius ${radiusKm} km`);
console.log(`cube faces at ${args.res}x${args.res}  (${(Cube.faceEdgeKm(radiusKm) * 1000 / args.res).toFixed(0)} m/texel)`);

/*
 * Every baked tile's DEM, preloaded and decimated once.
 *
 * Two reasons this is not lazy. The gather visits a tile from many texels, so
 * an `await` per texel puts a promise between every sample and dominates
 * everything else. And the full DEMs do not fit: 250 tiles x 51 MB is 12.8 GB.
 *
 * The target resolution says how much of a tile is actually reachable. A
 * level-`level` tile covers `res / 2^level` texels of a face, so anything
 * finer than that is averaged away by the sampler regardless. Decimating to
 * that (x2 for bilinear headroom) turns 12.8 GB into a few hundred MB and
 * loses nothing the output could have shown.
 */
const dems = new Map();
async function loadDems(perTile) {
  const names = new Set();
  const n = 1 << level;
  for (let face = 0; face < 6; face++)
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
      names.add(Cube.tileName({face, level, i, j}));
  let loaded = 0, bytes = 0;
  for (const name of names) {
    const dir = join(bakeDir, `crop-${name}`);
    try {
      const meta = JSON.parse(await readFile(join(dir, "output.elev.json"), "utf8"));
      const buf = await readFile(join(dir, "output.elev"));
      const src = new Float32Array(buf.buffer, buf.byteOffset, meta.width * meta.height);
      const want = Math.min(meta.width, Math.max(64, perTile));
      const step = Math.max(1, Math.floor(meta.width / want));
      const w = Math.floor(meta.width / step), h = Math.floor(meta.height / step);
      const a = new Float32Array(w * h);
      /* Box average, not decimation by stride: a 90 m DEM subsampled at
       * stride 3 keeps whichever ridge the stride happened to land on and
       * drops the rest, which reads as noise at this scale. */
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0, cnt = 0;
          for (let sy = 0; sy < step; sy++) {
            const row = (y * step + sy) * meta.width;
            for (let sx = 0; sx < step; sx++) { sum += src[row + x * step + sx]; cnt++; }
          }
          a[y * w + x] = sum / cnt;
        }
      }
      dems.set(name, {w, h, a});
      loaded++;
      bytes += a.byteLength;
    } catch { dems.set(name, null); }
  }
  console.log(`loaded ${loaded} baked tiles, decimated to <=${perTile}px (${(bytes / 1e6).toFixed(0)} MB)`);
}

function demFor(name) {
  return dems.get(name) || null;
}

/* The sketch, per tile, for the ground the mask skipped. Cheap: a level-3
 * tile is ~15 conditioning cells a side. */
const sketches = new Map();
function sketchFor(tile, name) {
  if (sketches.has(name)) return sketches.get(name);
  const halo = TdTile.haloCellsFor(tile);
  const rect = Cube.tileBakeRect(tile, cells, 0, Object.values(halo).some(Boolean) ? halo : null);
  const raw = Planet.rasterizeBakeRect(planet.mesh, planet.map, tile, rect, 0);
  const n = rect.width * rect.height;
  const m = new Float32Array(n);
  for (let k = 0; k < n; k++) m[k] = Tectonics.elevationToMeters(raw.elev[k]);
  const out = {rect, m};
  sketches.set(name, out);
  return out;
}

function sampleTile(dem, px) {
  const x = Math.min(dem.w - 1, Math.max(0, px.x));
  const y = Math.min(dem.h - 1, Math.max(0, px.y));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(dem.w - 1, x0 + 1), y1 = Math.min(dem.h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = dem.a;
  const w = dem.w;
  return (a[y0 * w + x0] * (1 - fx) + a[y0 * w + x1] * fx) * (1 - fy)
    + (a[y1 * w + x0] * (1 - fx) + a[y1 * w + x1] * fx) * fy;
}

await mkdir(outDir, {recursive: true});
const res = args.res;
/* x2 so bilinear has a neighbour to interpolate toward. */
await loadDems(Math.ceil(res / (1 << level)) * 2);
let minM = Infinity, maxM = -Infinity, fromDem = 0, fromSketch = 0;
const faceStats = [];

for (const face of FACES) {
  const plane = new Float32Array(res * res);
  let land = 0;
  for (let y = 0; y < res; y++) {
    const v = (y + 0.5) / res;
    for (let x = 0; x < res; x++) {
      const u = (x + 0.5) / res;
      const dir = gameDirToOurs(faceUvToDir(face, u, v));
      const ll = Cube.xyzToLonLat(dir);
      const tile = Cube.tileAt(ll.lon, ll.lat, level);
      const name = Cube.tileName(tile);
      const dem = demFor(name);
      let metres;
      if (dem) {
        const px = Cube.tilePixel(tile, ll.lon, ll.lat, dem.w, dem.h);
        metres = px ? sampleTile(dem, px) : 0;
        fromDem++;
      } else {
        const s = sketchFor(tile, name);
        const px = Cube.bakePixel(tile, s.rect, dir);
        const cx = px ? Math.min(s.rect.width - 1, Math.max(0, Math.round(px.x))) : 0;
        const cy = px ? Math.min(s.rect.height - 1, Math.max(0, Math.round(px.y))) : 0;
        metres = s.m[cy * s.rect.width + cx];
        fromSketch++;
      }
      plane[y * res + x] = metres;
      if (metres < minM) minM = metres;
      if (metres > maxM) maxM = metres;
      if (metres > 0) land++;
    }
    if (y % 512 === 0) process.stdout.write(`\r  ${face} row ${y}/${res}   `);
  }
  const path = join(outDir, `face-${FACES.indexOf(face)}-${face}.f32`);
  await writeFile(path, Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength));
  faceStats.push({face, land: land / (res * res)});
  console.log(`\r  ${face}: land ${(land / (res * res) * 100).toFixed(1)}%  -> ${path}`);
}

/*
 * The package encodes height as R16Unorm about zero:
 *   real_m = (texel / 65535 * 2 - 1) * height_range
 * so the range has to be symmetric and cover the deepest trench as well as
 * the highest peak, or the encoding clips one end.
 */
const heightRange = Math.ceil(Math.max(Math.abs(minM), Math.abs(maxM)) / 100) * 100;
const manifest = {
  body: run.project,
  variant: variantId,
  seed,
  radius_m: radiusKm * 1000,
  height_range_m: heightRange,
  resolution: res,
  faces: FACES.map((f, i) => ({index: i, face: f, file: `face-${i}-${f}.f32`})),
  source: {level, cells, tiles: dems.size, from_dem: fromDem, from_sketch: fromSketch},
  observed_min_m: minM,
  observed_max_m: maxM,
  encoding: "f32 metres, row-major, top-to-bottom, game cubemap face order",
};
await writeFile(join(outDir, "cubemap.json"), JSON.stringify(manifest, null, 2));

/*
 * The same numbers again as `key=value` lines. The Rust producer reads this
 * one: `thalos_terrain_baker` has three dependencies and none of them is a
 * JSON parser, and a height cubemap is not worth adding one for. The JSON
 * above stays for humans and for anything else that picks these planes up.
 */
await writeFile(join(outDir, "cubemap.meta"), [
  `resolution=${res}`,
  `height_range_m=${heightRange}`,
  `radius_m=${radiusKm * 1000}`,
  `body=${run.project}`,
  `variant=${variantId}`,
  `source_key=${sourceKey(manifest)}`,
  ...FACES.map((f, i) => `face${i}=face-${i}-${f}.f32`),
  "",
].join("\n"));

console.log(`\nheight ${minM.toFixed(0)}..${maxM.toFixed(0)} m -> symmetric range +/-${heightRange} m`);
console.log(`${(fromDem / (fromDem + fromSketch) * 100).toFixed(1)}% of texels from the 90 m bake,`
  + ` ${(fromSketch / (fromDem + fromSketch) * 100).toFixed(1)}% from the sketch where the mask skipped`);
console.log(`land by face: ${faceStats.map((f) => `${f.face} ${(f.land * 100).toFixed(0)}%`).join("  ")}`);
console.log(`wrote ${outDir}`);
