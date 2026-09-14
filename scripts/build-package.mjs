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
 * - Nodes sit on **the bake's own cubesphere**, `(face, lod, x, y)`.
 *   Interior samples stay in that frame. Fold skirts sample neighbouring
 *   faces in the same spherical field.
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
import { mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { projectBakeDir } from "./td-overlays.mjs";
import { resolveRun } from "./project-run.mjs";
import { loadSavedPlanet } from "./saved-planet.mjs";
import { canPruneSubtree } from "./package-pruning.mjs";
import { createPackageOutput } from "./package-output.mjs";
import { validatePlanet } from "./read-planet.mjs";
import { createHash } from "node:crypto";
import { createPackageTerrain, reduceNodes, fillLevelSkirts } from "./package-terrain.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Cube = require(join(root, "src", "cubesphere.js"));
const Projects = require(join(root, "src", "projects"));
const TdTile = require(join(root, "src", "td-tile.js"));

const MAGIC = "PLANETPK";
const FORMAT_VERSION = 1;
/* A bake tile is this many nodes on a side. It is what makes the node grid a
 * power of two while the node itself need not be. */
const NODES_PER_TILE = 8;
const NODATA = -32768;

function parseArgs(argv) {
  const out = {denseLod: 4, absoluteLod: null, error: 12, validate: false, level: 3};
  for (const arg of argv) {
    if (arg === "--validate") out.validate = true;
    else if (arg.startsWith("--project=")) out.project = arg.slice(10);
    else if (arg.startsWith("--variant=")) out.variant = arg.slice(10);
    else if (arg.startsWith("--variant-name=")) out.variantName = arg.slice(15);
    else if (arg.startsWith("--level=")) out.level = Number(arg.slice(8)) | 0;
    else if (arg.startsWith("--dense-lod=")) out.denseLod = Number(arg.slice(12)) | 0;
    else if (arg.startsWith("--absolute-lod=")) out.absoluteLod = Number(arg.slice(15)) | 0;
    else if (arg.startsWith("--error=")) out.error = Number(arg.slice(8));
    else if (arg.startsWith("--out=")) out.out = arg.slice(6);
    else throw new Error(`unknown arg: ${arg}`);
  }
  return out;
}

/* Content identity covers metadata, the index and the actual encoded heights. */
function contentKey(manifest) {
  return createHash("sha256").update("planet-package-v1\0")
    .update(JSON.stringify(manifest)).digest("hex");
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

const {planet, fingerprint: sketchFingerprint} = await loadSavedPlanet(root, run.project, variantId);
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
/*
 * dense_lod used to mean two things — "every node exists" and "stored
 * absolute". Those are different questions: completeness bounds what absence
 * means, absoluteness bounds what the base costs. Split since the first
 * planet, whose absolute base was 341 MB over 2046 nodes. Defaults preserve
 * the old behaviour; pass --absolute-lod=0 (plus one keyframe level) to take
 * most of that base.
 */
const absoluteLod = args.absoluteLod ?? args.denseLod;
console.log(`dense to lod ${args.denseLod} (absolute to lod ${absoluteLod}),`
  + ` prune above at ${args.error} m`);

if (args.validate) {
  console.log(validatePlanet(outPath));
  process.exit(0);
}

/* ---------------------------------------------------------------- sources */

const terrain = await createPackageTerrain({
  bakeDir, planet, sketchFingerprint, level, cells, tileSide, nodeRes, leafLod,
});

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

/* Exact interiors; borders are filled from the completed neighbouring mip. */
function reduce(children) {
  return reduceNodes(children, nodeRes);
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
const output = await createPackageOutput(outPath);
try {
let blobOffset = 0;
const index = [];

async function emit(face, lod, x, y, data, predictorError, residual = false) {
  const bytes = zstdCompressSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  await output.append(bytes);
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
      let covered = false;
      for (let lod = leafLod; lod >= level; lod--) {
        const {ext, span, covered: baked} = await terrain.extendedTile(face, ti, tj, lod);
        covered = baked;
        const count = 1 << (lod - level), nodes = new Map();
        for (let dy = 0; dy < count; dy++) {
          for (let dx = 0; dx < count; dx++) {
            nodes.set(`${dx},${dy}`, leafFrom(ext, span, dx, dy));
          }
        }
        levels.set(lod, nodes);
      }
      if (!covered) sketchOnly++;
      roots.set(`${face}/${ti}/${tj}`, levels.get(level).get("0,0"));

      /* A missing node removes its complete subtree. Certify the retained
       * ancestor against every descendant's continuous source surface, and
       * keep mixed land/water regions regardless of the vertical tolerance.
       * Residual encoding still uses the exact rounded one-level predictor. */
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
            if (lod > args.denseLod && err <= args.error && canPruneSubtree({
              parent: recon.get(parentKey), resolution: nodeRes,
              parentLod: lod - 1, parentX: dx >> 1, parentY: dy >> 1,
              lod, x: dx, y: dy, leafLod, levels, maxErrorM: args.error,
            })) {
              prunedHere.add(`${lod}/${dx}/${dy}`);
              pruned++;
              continue;
            }
            const residual = lod > absoluteLod;
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
const coarseRecon = new Map();
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
    fillLevelSkirts(coarse, lod, nodeRes);
  }
}
for (let lod = 0; lod <= level; lod++) {
  const span = 1 << lod;
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < span; y++) {
      for (let x = 0; x < span; x++) {
        const data = coarse.get(`${face}/${lod}/${x}/${y}`);
        if (!data) continue;
        /* The coarse base is usually all absolute (lod <= absoluteLod), but
         * with --absolute-lod below the bake level it stores residuals here
         * too — predicted from the reconstructed parent, same closed loop as
         * the tile subtrees, so the chain stays exact. */
        const residual = lod > 0 && lod > absoluteLod;
        let payload = data, err = 0;
        if (residual) {
          const parent = coarseRecon.get(`${face}/${lod - 1}/${x >> 1}/${y >> 1}`);
          const predicted = predictFromParent(parent, x & 1, y & 1);
          err = maxAbsDiff(data, predicted);
          payload = new Int16Array(data.length);
          for (let k = 0; k < data.length; k++) payload[k] = data[k] - predicted[k];
        }
        coarseRecon.set(`${face}/${lod}/${x}/${y}`, data);
        await emit(face, lod, x, y, payload, err, residual);
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
  absolute_lod: absoluteLod,
  max_error_m: args.error,
  pruning: {method: "bilinear-subtree-v1", sea_level_m: 0, preserve_mixed_water: true},
  sketch_fingerprint: sketchFingerprint,
  terrain: {
    seam_mode: terrain.settings?.seamMode ?? "legacy",
    blend_km: terrain.settings?.blendKm ?? null,
    mask_key: terrain.fine?.maskKey ?? null,
    skirt_mode: "same-mip-spherical-neighbours-v1",
  },
  payload: "int16 little-endian, row-major, north first, zstd; absolute metres at"
    + " lod <= absolute_lod, residual against the bilinear parent above it",
  residual_flag: "high bit of the lod byte in an index record",
  nodata: NODATA,
  node_count: index.length,
  pruned_count: pruned,
  content_identity: "sha256-manifest-index-blobs-v1",
  blobs_sha256: output.digest(),
};

/* Header, manifest and index are small; stream the staged blobs after them. */
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
manifest.index_sha256 = createHash("sha256").update(indexBuf).digest("hex");
manifest.content_key = contentKey(manifest);
const manifestBuf = Buffer.from(JSON.stringify(manifest), "utf8");
const header = Buffer.alloc(32);
header.write(MAGIC, 0, "ascii");
header.writeUInt32LE(FORMAT_VERSION, 8);
header.writeUInt32LE(manifestBuf.length, 12);
header.writeUInt32LE(index.length, 16);
header.writeUInt32LE(RECORD, 20);
header.writeBigUInt64LE(BigInt(header.length + manifestBuf.length + indexBuf.length), 24);
await output.commit([header, manifestBuf, indexBuf], validatePlanet);

const size = (await stat(outPath)).size;
console.log(`\n${index.length} nodes, ${pruned} pruned, ${sketchOnly} tiles sketch-only`);
console.log(`${(size / 1e6).toFixed(1)} MB  (blobs ${(blobBytes / 1e6).toFixed(1)} MB)`
  + `  in ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(`wrote ${outPath}`);
console.log(`check it:  bun run build:package --project=${run.project}`
  + ` --variant-name=${args.variantName || ""} --validate`);

} catch (error) {
  await output.abort();
  throw error;
}
