#!/usr/bin/env bun
/**
 * Write the planet package the engine consumes.
 *
 *   bun run build:package --project=quarter --variant-name=glep
 *   bun run build:package --project=quarter --variant-name=glep --error=12
 *   bun run build:package ... --validate      (read it back and check it)
 *
 * The contract is docs/stages/export.md § The planet package. The parts that
 * shape this file:
 *
 * - Nodes sit on **the bake's own cubesphere**, `(face, lod, x, y)`. No
 *   reprojection anywhere in this script. Everything that went wrong on the
 *   campaign was a frame mismatch, so the format does not have a frame to get
 *   wrong.
 * - A leaf node is a **straight copy out of a tile raster** — a bake tile is
 *   8 nodes on a side, so a node is `tileCells * 256 / 8` texels and the node
 *   *grid* is the power of two rather than the node. Nothing resamples the
 *   sphere; reducing a level is an exact 2:1 box average of four children.
 * - Nodes carry a one-texel skirt, so the consumer never looks up a
 *   neighbour to shade or interpolate an edge.
 * - Dense to `--dense-lod`, sparse above it, and above it a missing node
 *   means exactly one thing: the parent is already within `--error`.
 *
 * Memory is bounded by working one bake tile at a time. A tile's subtree is
 * 8x8 leaves and its three ancestors — tens of MB — where the whole leaf
 * level would be about 10 GB.
 */
import { open, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { projectBakeDir } from "./td-overlays.mjs";
import { resolveRun } from "./project-run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Cube = require(join(root, "src", "cubesphere.js"));
const Planet = require(join(root, "src", "planet.js"));
const Projects = require(join(root, "src", "projects"));
const TdTile = require(join(root, "src", "td-tile.js"));
const Tectonics = require(join(root, "src", "tectonics.js"));

const MAGIC = "PLANETPK";
const FORMAT_VERSION = 1;
/* A bake tile is this many nodes on a side. It is what makes the node grid a
 * power of two while the node itself need not be. */
const NODES_PER_TILE = 8;
const NODATA = -32768;

function parseArgs(argv) {
  const out = {denseLod: 4, error: 12, validate: false, level: 3};
  for (const arg of argv) {
    if (arg === "--validate") out.validate = true;
    else if (arg.startsWith("--project=")) out.project = arg.slice(10);
    else if (arg.startsWith("--variant=")) out.variant = arg.slice(10);
    else if (arg.startsWith("--variant-name=")) out.variantName = arg.slice(15);
    else if (arg.startsWith("--level=")) out.level = Number(arg.slice(8)) | 0;
    else if (arg.startsWith("--dense-lod=")) out.denseLod = Number(arg.slice(12)) | 0;
    else if (arg.startsWith("--error=")) out.error = Number(arg.slice(8));
    else if (arg.startsWith("--out=")) out.out = arg.slice(6);
    else throw new Error(`unknown arg: ${arg}`);
  }
  return out;
}

/* FNV-1a over the inputs that decide the heights. Sits in the header so a
 * rebake cannot quietly reuse a cache keyed to the previous planet. */
function contentKey(parts) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  const text = parts.join("|");
  for (let i = 0; i < text.length; i++) {
    hash = ((hash ^ BigInt(text.charCodeAt(i) & 0xff)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
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
const tileSide = cells * 256;
const nodeRes = Math.floor(tileSide / NODES_PER_TILE);
const leafLod = level + Math.log2(NODES_PER_TILE);
const bakeDir = projectBakeDir(root, run.project, variantId);
const outPath = args.out
  || join(root, "bake", `${run.project}-${variantId}.planet`);

if (nodeRes * NODES_PER_TILE !== tileSide) {
  throw new Error(`tile ${tileSide}px does not divide into ${NODES_PER_TILE} nodes`);
}

console.log(`project ${run.project}  variant ${variantId}  radius ${radiusKm} km`);
console.log(`bake level ${level}, ${cells} cells/tile -> node ${nodeRes}px,`
  + ` leaf lod ${leafLod} (${1 << leafLod} nodes/face edge)`);
console.log(`dense to lod ${args.denseLod}, prune above at ${args.error} m`);

if (args.validate) {
  await validate(outPath);
  process.exit(0);
}

/* ---------------------------------------------------------------- sources */

const tiles = new Map();
async function tileRaster(face, i, j) {
  const name = Cube.tileName({face, level, i, j});
  if (tiles.has(name)) return tiles.get(name);
  let out = null;
  try {
    const dir = join(bakeDir, `crop-${name}`);
    const meta = JSON.parse(await readFile(join(dir, "output.elev.json"), "utf8"));
    const buf = await readFile(join(dir, "output.elev"));
    if (meta.width === tileSide) {
      out = {w: meta.width, h: meta.height,
        a: new Float32Array(buf.buffer, buf.byteOffset, meta.width * meta.height)};
    }
  } catch { out = null; }
  tiles.set(name, out);
  return out;
}

/*
 * The sketch, for ground the mask skipped. The package has no holes: a node
 * the bake never covered still exists, described at the grain the sketch
 * knows. That is the difference between "no more detail" and "no data", and
 * the format only admits the first.
 */
const sketches = new Map();
function sketchRaster(face, i, j) {
  const key = `${face}/${i}/${j}`;
  if (sketches.has(key)) return sketches.get(key);
  const tile = {face, level, i, j};
  const halo = TdTile.haloCellsFor(tile);
  const rect = Cube.tileBakeRect(tile, cells, 0, Object.values(halo).some(Boolean) ? halo : null);
  const raw = Planet.rasterizeBakeRect(planet.mesh, planet.map, tile, rect, 0);
  const m = new Float32Array(rect.width * rect.height);
  for (let k = 0; k < m.length; k++) m[k] = Tectonics.elevationToMeters(raw.elev[k]);
  const out = {rect, m};
  sketches.set(key, out);
  return out;
}

/*
 * One tile as int16 metres with a one-texel border already filled from its
 * four neighbours: `(tileSide + 2)²`, about 26 MB.
 *
 * Built once per tile so that carving out the 64 leaves is a pure sync slice
 * with no boundary logic and no I/O. Resolving the source per texel instead
 * would put an `await` inside a 450² loop run 24 576 times — five billion
 * promises, which is how the first cubemap builder came to need six hours.
 *
 * The border is what makes a leaf's skirt real data at a tile edge. Across a
 * cube fold it replicates instead: the neighbour is on another face's plane,
 * and resampling it here would reintroduce exactly the frame conversion this
 * format exists to avoid. A one-texel skirt at a fold is the seam we already
 * know about, not a new one.
 */
async function extendedTile(face, i, j) {
  const span = tileSide + 2;
  const out = new Int16Array(span * span);
  const n = 1 << level;
  const clamp = (v) => Math.max(-32767, Math.min(32767, Math.round(v)));
  const self = await tileRaster(face, i, j);
  let covered = !!self;

  const fill = async (di, dj) => {
    const ni = i + di, nj = j + dj;
    if (ni < 0 || nj < 0 || ni >= n || nj >= n) return null;   // fold: replicate
    return await tileRaster(face, ni, nj);
  };
  const east = await fill(1, 0), west = await fill(-1, 0);
  const north = await fill(0, 1), south = await fill(0, -1);

  const sketch = self ? null : sketchRaster(face, i, j);
  /*
   * The sketch fills ground the mask skipped, and it is read *bilinearly*.
   *
   * Nearest-neighbour turned one 23 km conditioning cell into a 240-texel
   * square of constant height, so the abyss came out as a staircase — and,
   * worse, unprunable: a parent's bilinear prediction cannot follow a step
   * edge, so max-abs error stayed enormous and every one of those nodes was
   * kept. 135 of 384 tiles are sketch-only here, so a third of the planet was
   * being stored at leaf resolution to describe a flat plain.
   */
  const readSelf = (x, y) => {
    if (self) return self.a[y * self.w + x];
    const w = sketch.rect.width, h = sketch.rect.height;
    const fx = Math.min(w - 1.001, Math.max(0, x / tileSide * w - 0.5));
    const fy = Math.min(h - 1.001, Math.max(0, y / tileSide * h - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    return (sketch.m[y0 * w + x0] * (1 - tx) + sketch.m[y0 * w + x1] * tx) * (1 - ty)
      + (sketch.m[y1 * w + x0] * (1 - tx) + sketch.m[y1 * w + x1] * tx) * ty;
  };
  for (let y = 0; y < tileSide; y++) {
    const row = (y + 1) * span;
    for (let x = 0; x < tileSide; x++) out[row + x + 1] = clamp(readSelf(x, y));
  }
  /* Tile row 0 is north, so the north neighbour supplies the top border from
   * its own last row, and the south neighbour the bottom from its first. */
  for (let x = 0; x < tileSide; x++) {
    out[x + 1] = north ? clamp(north.a[(north.h - 1) * north.w + x]) : out[span + x + 1];
    out[(span - 1) * span + x + 1] = south
      ? clamp(south.a[x]) : out[(span - 2) * span + x + 1];
  }
  for (let y = 0; y < tileSide; y++) {
    const row = (y + 1) * span;
    out[row] = west ? clamp(west.a[y * west.w + west.w - 1]) : out[row + 1];
    out[row + span - 1] = east ? clamp(east.a[y * east.w]) : out[row + span - 2];
  }
  /* Corners are one texel each and never carry a normal on their own. */
  out[0] = out[span + 1];
  out[span - 1] = out[span + span - 2];
  out[(span - 1) * span] = out[(span - 2) * span + 1];
  out[span * span - 1] = out[(span - 1) * span - 2];
  return {ext: out, span, covered};
}

/* A leaf is a window on the extended tile, offset by one so the skirt lands
 * on the border the tile already carries. */
function leafFrom(ext, span, sx, sy) {
  const side = nodeRes + 2;
  const out = new Int16Array(side * side);
  for (let y = 0; y < side; y++) {
    const src = (sy * nodeRes + y) * span + sx * nodeRes;
    out.set(ext.subarray(src, src + side), y * side);
  }
  return out;
}

/* Exact 2:1 box average of four children, skirts re-derived from the
 * children's interiors so a parent's skirt is real data, not a copy. */
function reduce(children) {
  const side = nodeRes + 2;
  const out = new Int16Array(side * side);
  const at = (qx, qy, ix, iy) => {
    const child = children[qy * 2 + qx];
    if (!child) return 0;
    const cx = Math.min(nodeRes - 1, Math.max(0, ix));
    const cy = Math.min(nodeRes - 1, Math.max(0, iy));
    return child[(cy + 1) * side + (cx + 1)];
  };
  for (let y = -1; y <= nodeRes; y++) {
    for (let x = -1; x <= nodeRes; x++) {
      const sx = Math.min(nodeRes * 2 - 1, Math.max(0, x * 2));
      const sy = Math.min(nodeRes * 2 - 1, Math.max(0, y * 2));
      let sum = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = sx + dx, py = sy + dy;
          sum += at(px >= nodeRes ? 1 : 0, py >= nodeRes ? 1 : 0, px % nodeRes, py % nodeRes);
        }
      }
      out[(y + 1) * side + (x + 1)] = Math.round(sum / 4);
    }
  }
  return out;
}

/* What the consumer would reconstruct for this node from its parent alone:
 * bilinear upsample of the parent's matching quadrant. The prune decision has
 * to measure the same thing the reader will do, or the declared error is
 * fiction. */
function predictFromParent(parent, quadX, quadY) {
  const side = nodeRes + 2;
  const out = new Int16Array(side * side);
  const half = nodeRes / 2;
  const p = (x, y) => {
    const cx = Math.min(nodeRes + 1, Math.max(0, x + 1));
    const cy = Math.min(nodeRes + 1, Math.max(0, y + 1));
    return parent[cy * side + cx];
  };
  for (let y = -1; y <= nodeRes; y++) {
    for (let x = -1; x <= nodeRes; x++) {
      const fx = quadX * half + (x + 0.5) / 2 - 0.5;
      const fy = quadY * half + (y + 0.5) / 2 - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const v = p(x0, y0) * (1 - tx) * (1 - ty) + p(x0 + 1, y0) * tx * (1 - ty)
        + p(x0, y0 + 1) * (1 - tx) * ty + p(x0 + 1, y0 + 1) * tx * ty;
      out[(y + 1) * side + (x + 1)] = Math.round(v);
    }
  }
  return out;
}

function maxAbsDiff(a, b) {
  let worst = 0;
  for (let k = 0; k < a.length; k++) {
    const d = Math.abs(a[k] - b[k]);
    if (d > worst) worst = d;
  }
  return worst;
}

/* ------------------------------------------------------------------ write */

const started = Date.now();
await mkdir(dirname(outPath), {recursive: true});
const handle = await open(outPath, "w");
let blobOffset = 0;
const index = [];

async function emit(face, lod, x, y, data, predictorError, residual = false) {
  const bytes = zstdCompressSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  await handle.write(bytes, 0, bytes.length, undefined);
  index.push({
    face, lod, x, y,
    offset: blobOffset,
    length: bytes.length,
    predictor_error_m: Math.round(predictorError),
    residual,
  });
  blobOffset += bytes.length;
}

/*
 * One bake tile at a time: build its 8x8 leaves, reduce to the tile root, and
 * decide presence on the way down. Everything coarser than a tile root is
 * assembled afterwards from the roots, which is small.
 */
const roots = new Map();
let emitted = 0, pruned = 0, sketchOnly = 0;
const n = 1 << level;

for (let face = 0; face < 6; face++) {
  for (let ti = 0; ti < n; ti++) {
    for (let tj = 0; tj < n; tj++) {
      const baseX = ti * NODES_PER_TILE;
      const baseY = (n - 1 - tj) * NODES_PER_TILE;
      /* lod -> Map(key -> payload) for this tile's subtree */
      const levels = new Map();
      const leaves = new Map();
      const {ext, span, covered} = await extendedTile(face, ti, tj);
      for (let dy = 0; dy < NODES_PER_TILE; dy++) {
        for (let dx = 0; dx < NODES_PER_TILE; dx++) {
          leaves.set(`${dx},${dy}`, leafFrom(ext, span, dx, dy));
        }
      }
      if (!covered) sketchOnly++;
      /* The rasters this tile needed are 51 MB each and the next tile shares
       * at most one of them. Holding them all would be 12.8 GB. */
      if (tiles.size > 12) tiles.clear();
      levels.set(leafLod, leaves);
      for (let lod = leafLod - 1; lod >= level; lod--) {
        const span = 1 << (lod - level);
        const cur = new Map();
        const child = levels.get(lod + 1);
        for (let dy = 0; dy < span; dy++) {
          for (let dx = 0; dx < span; dx++) {
            cur.set(`${dx},${dy}`, reduce([
              child.get(`${dx * 2},${dy * 2}`), child.get(`${dx * 2 + 1},${dy * 2}`),
              child.get(`${dx * 2},${dy * 2 + 1}`), child.get(`${dx * 2 + 1},${dy * 2 + 1}`),
            ]));
          }
        }
        levels.set(lod, cur);
      }
      roots.set(`${face}/${ti}/${tj}`, levels.get(level).get("0,0"));

      /*
       * Pruning cascades. A node is dropped when its parent already predicts
       * it within budget — and then everything below it goes too, whether or
       * not those children would have passed on their own.
       *
       * Deciding per node instead left 180 children whose parent was not in
       * the file. That is not a smaller package, it is a broken one: absence
       * has to mean exactly "the parent is good enough", so a reader that
       * stops descending when a node is missing must not be skipping detail
       * that exists further down. The validator's orphan check is what this
       * is answering.
       */
      /*
       * Pruning cascades, and above the dense base a node stores a residual.
       *
       * Both decisions come from the measured predictor error, not from
       * taste. A bilinear parent misses this terrain by a median 122 m at the
       * leaves and 565 m at p90, so no honest threshold prunes anything —
       * storing absolute heights meant keeping every node at full price, 3.4
       * GB. The residual is what the sparsity was supposed to buy.
       *
       * Prediction is closed-loop: the residual is taken against the parent
       * the *reader* will have reconstructed, not against the original, so
       * nothing drifts as levels stack. Since the residual is exact in i16,
       * reconstruction is lossless and `recon` equals the source.
       *
       * The cascade still matters: absence has to mean "the parent is good
       * enough", so a pruned node takes its subtree with it. Deciding per
       * node left 180 children with no parent in the file.
       */
      const prunedHere = new Set();
      const recon = new Map([[`${level}/0/0`, levels.get(level).get("0,0")]]);
      for (let lod = level + 1; lod <= leafLod; lod++) {
        const span = 1 << (lod - level);
        const scale = 1 << (lod - level);
        for (let dy = 0; dy < span; dy++) {
          for (let dx = 0; dx < span; dx++) {
            const parentKey = `${lod - 1}/${dx >> 1}/${dy >> 1}`;
            if (prunedHere.has(parentKey)) {
              prunedHere.add(`${lod}/${dx}/${dy}`);
              pruned++;
              continue;
            }
            const data = levels.get(lod).get(`${dx},${dy}`);
            const predicted = predictFromParent(recon.get(parentKey), dx & 1, dy & 1);
            const err = maxAbsDiff(data, predicted);
            if (lod > args.denseLod && err <= args.error) {
              prunedHere.add(`${lod}/${dx}/${dy}`);
              pruned++;
              continue;
            }
            const residual = lod > args.denseLod;
            let payload = data;
            if (residual) {
              payload = new Int16Array(data.length);
              for (let k = 0; k < data.length; k++) payload[k] = data[k] - predicted[k];
            }
            recon.set(`${lod}/${dx}/${dy}`, data);
            await emit(face, lod, baseX * scale / NODES_PER_TILE + dx,
              baseY * scale / NODES_PER_TILE + dy, payload, err, residual);
            emitted++;
          }
        }
      }
    }
    process.stdout.write(`\r  face ${face} column ${ti + 1}/${n}: ${emitted} nodes, ${pruned} pruned   `);
  }
}

/* Coarser than a tile root: reduce the roots themselves. Small enough to hold. */
let coarse = new Map();
for (const [key, data] of roots) {
  const [face, ti, tj] = key.split("/").map(Number);
  coarse.set(`${face}/${level}/${ti}/${(1 << level) - 1 - tj}`, data);
}
for (let lod = level; lod >= 0; lod--) {
  const span = 1 << lod;
  if (lod < level) {
    const next = new Map();
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < span; y++) {
        for (let x = 0; x < span; x++) {
          next.set(`${face}/${lod}/${x}/${y}`, reduce([
            coarse.get(`${face}/${lod + 1}/${x * 2}/${y * 2}`),
            coarse.get(`${face}/${lod + 1}/${x * 2 + 1}/${y * 2}`),
            coarse.get(`${face}/${lod + 1}/${x * 2}/${y * 2 + 1}`),
            coarse.get(`${face}/${lod + 1}/${x * 2 + 1}/${y * 2 + 1}`),
          ]));
        }
      }
    }
    for (const [k, v] of next) coarse.set(k, v);
  }
}
for (let lod = 0; lod <= level; lod++) {
  const span = 1 << lod;
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < span; y++) {
      for (let x = 0; x < span; x++) {
        const data = coarse.get(`${face}/${lod}/${x}/${y}`);
        if (!data) continue;
        await emit(face, lod, x, y, data, 0);
        emitted++;
      }
    }
  }
}
console.log();

const blobBytes = blobOffset;
const manifest = {
  format: "planetgen.planet",
  version: FORMAT_VERSION,
  body: run.project,
  variant: variantId,
  seed,
  radius_m: radiusKm * 1000,
  frame: "planetgen equal-angle cubesphere; see src/cubesphere.js",
  bake_level: level,
  tile_cells: cells,
  node_resolution: nodeRes,
  node_skirt: 1,
  node_stride: nodeRes + 2,
  leaf_lod: leafLod,
  dense_lod: args.denseLod,
  max_error_m: args.error,
  payload: "int16 little-endian, row-major, north first, zstd; absolute metres at"
    + " lod <= dense_lod, residual against the bilinear parent above it",
  residual_flag: "high bit of the lod byte in an index record",
  nodata: NODATA,
  node_count: index.length,
  pruned_count: pruned,
  content_key: contentKey([run.project, variantId, String(seed), String(level),
    String(cells), String(nodeRes), String(args.denseLod), String(args.error)]),
};

/* Header, manifest, fixed-size index, then the blobs already on disk. The
 * blobs were streamed first, so this writes the front matter to a second file
 * and concatenates — simpler than seeking back over a moving offset. */
const manifestBuf = Buffer.from(JSON.stringify(manifest), "utf8");
const RECORD = 24;
const indexBuf = Buffer.alloc(index.length * RECORD);
index.sort((a, b) => a.face - b.face || a.lod - b.lod || a.y - b.y || a.x - b.x);
index.forEach((node, k) => {
  const o = k * RECORD;
  indexBuf.writeUInt8(node.face, o);
  indexBuf.writeUInt8(node.lod | (node.residual ? 0x80 : 0), o + 1);
  indexBuf.writeUInt16LE(node.predictor_error_m > 65535 ? 65535 : node.predictor_error_m, o + 2);
  indexBuf.writeUInt32LE(node.x, o + 4);
  indexBuf.writeUInt32LE(node.y, o + 8);
  indexBuf.writeBigUInt64LE(BigInt(node.offset), o + 12);
  indexBuf.writeUInt32LE(node.length, o + 20);
});
const header = Buffer.alloc(32);
header.write(MAGIC, 0, "ascii");
header.writeUInt32LE(FORMAT_VERSION, 8);
header.writeUInt32LE(manifestBuf.length, 12);
header.writeUInt32LE(index.length, 16);
header.writeUInt32LE(RECORD, 20);
header.writeBigUInt64LE(BigInt(header.length + manifestBuf.length + indexBuf.length), 24);
await handle.close();

const blobs = await readFile(outPath);
await writeFile(outPath, Buffer.concat([header, manifestBuf, indexBuf, blobs]));

const size = (await stat(outPath)).size;
console.log(`\n${index.length} nodes, ${pruned} pruned, ${sketchOnly} tiles sketch-only`);
console.log(`${(size / 1e6).toFixed(1)} MB  (blobs ${(blobBytes / 1e6).toFixed(1)} MB)`
  + `  in ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(`wrote ${outPath}`);
console.log(`check it:  bun run build:package --project=${run.project}`
  + ` --variant-name=${args.variantName || ""} --validate`);

/* ----------------------------------------------------------------- verify */

/*
 * Read the file back the way a consumer would and hold it to its own claims.
 * Written with the format rather than after it, because on this pipeline the
 * obvious check has passed while the artifact was wrong more than once.
 */
async function validate(path) {
  const buf = await readFile(path);
  if (buf.toString("ascii", 0, 8) !== MAGIC) throw new Error("bad magic");
  const version = buf.readUInt32LE(8);
  const manifestLen = buf.readUInt32LE(12);
  const nodeCount = buf.readUInt32LE(16);
  const record = buf.readUInt32LE(20);
  const blobBase = Number(buf.readBigUInt64LE(24));
  const meta = JSON.parse(buf.toString("utf8", 32, 32 + manifestLen));
  console.log(`format v${version}, ${nodeCount} nodes, node ${meta.node_resolution}`
    + `+${meta.node_skirt} skirt, lod 0..${meta.leaf_lod}, key ${meta.content_key}`);

  const stride = meta.node_stride;
  const want = stride * stride * 2;
  const present = new Set();
  const problems = [];
  let decoded = 0, minM = Infinity, maxM = -Infinity, maxResidual = 0;
  for (let k = 0; k < nodeCount; k++) {
    const o = 32 + manifestLen + k * record;
    const face = buf.readUInt8(o), lodByte = buf.readUInt8(o + 1);
    const lod = lodByte & 0x7f, isResidual = (lodByte & 0x80) !== 0;
    const x = buf.readUInt32LE(o + 4), y = buf.readUInt32LE(o + 8);
    const off = Number(buf.readBigUInt64LE(o + 12)), len = buf.readUInt32LE(o + 20);
    const span = 1 << lod;
    if (face > 5 || lod > meta.leaf_lod || x >= span || y >= span) {
      problems.push(`node ${k}: address ${face}/${lod}/${x}/${y} out of range`);
      continue;
    }
    present.add(`${face}/${lod}/${x}/${y}`);
    let raw;
    try { raw = zstdDecompressSync(buf.subarray(blobBase + off, blobBase + off + len)); }
    catch (err) { problems.push(`node ${face}/${lod}/${x}/${y}: ${err.message}`); continue; }
    if (raw.length !== want) {
      problems.push(`node ${face}/${lod}/${x}/${y}: ${raw.length} bytes, expected ${want}`);
      continue;
    }
    const a = new Int16Array(raw.buffer, raw.byteOffset, stride * stride);
    if (isResidual !== (lod > meta.dense_lod)) {
      problems.push(`node ${face}/${lod}/${x}/${y}: residual flag disagrees with dense_lod`);
    }
    /* Absolute nodes carry heights; residual nodes carry differences, so only
     * the former say anything about the planet's range. */
    if (!isResidual) {
      for (let t = 0; t < a.length; t++) {
        if (a[t] < minM) minM = a[t];
        if (a[t] > maxM) maxM = a[t];
      }
    } else {
      for (let t = 0; t < a.length; t++) {
        const m = Math.abs(a[t]);
        if (m > maxResidual) maxResidual = m;
      }
    }
    decoded++;
  }
  /* The dense base is the promise that there are no holes. */
  let missing = 0;
  for (let lod = 0; lod <= meta.dense_lod; lod++) {
    const span = 1 << lod;
    for (let face = 0; face < 6; face++)
      for (let y = 0; y < span; y++)
        for (let x = 0; x < span; x++)
          if (!present.has(`${face}/${lod}/${x}/${y}`)) { missing++; }
  }
  if (missing) problems.push(`${missing} nodes missing below the dense lod ${meta.dense_lod}`);
  /* Every node above the dense base must have a parent to be predicted from. */
  let orphans = 0;
  for (const key of present) {
    const [face, lod, x, y] = key.split("/").map(Number);
    if (lod === 0) continue;
    if (!present.has(`${face}/${lod - 1}/${x >> 1}/${y >> 1}`)) orphans++;
  }
  if (orphans) problems.push(`${orphans} nodes have no parent in the file`);

  console.log(`decoded ${decoded}/${nodeCount} nodes, absolute heights ${minM}..${maxM} m,`
    + ` largest residual ${maxResidual} m`);
  console.log(missing ? `dense base incomplete` : `dense base complete to lod ${meta.dense_lod}`);
  console.log(orphans ? `orphans present` : `every node has a parent`);
  if (problems.length) {
    console.log(`\nFAILED:\n  ${problems.slice(0, 10).join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log(`\nok`);
  }
}
