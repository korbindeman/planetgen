#!/usr/bin/env bun
/**
 * Write the planet package the engine consumes.
 *
 *   bun run build:package --project=quarter --variant-name=glep
 *   bun run build:package --project=quarter --variant-name=glep --error=12
 *   bun run build:package ... --fraction-band=64
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
 * - Heights are int16 metres plus int8 centimetres within `--fraction-band`
 *   metres of sea level (default 64), so the coastline keeps the Float32
 *   source's sub-metre signs. The encoding is scripts/package-encoding.mjs.
 *
 * Memory is bounded by working one bake tile at a time. A tile's subtree is
 * 8x8 leaves and its three ancestors — tens of MB — where the whole leaf
 * level would be about 10 GB.
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectBakeDir } from "./td-overlays.mjs";
import { resolveRun } from "./project-run.mjs";
import { loadSavedPlanet } from "./saved-planet.mjs";
import { validatePlanet } from "./read-planet.mjs";
import { createPackageTerrain } from "./package-terrain.mjs";
import { buildPackage, NODES_PER_TILE } from "./package-build.mjs";
import { DEFAULT_FRACTION_BAND_M } from "./package-encoding.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Cube = require(join(root, "src", "cubesphere.js"));
const Projects = require(join(root, "src", "projects"));
const TdTile = require(join(root, "src", "td-tile.js"));

function parseArgs(argv) {
  const out = {denseLod: 4, absoluteLod: null, error: 12, validate: false, level: 3,
    fractionBand: DEFAULT_FRACTION_BAND_M};
  for (const arg of argv) {
    if (arg === "--validate") out.validate = true;
    else if (arg.startsWith("--project=")) out.project = arg.slice(10);
    else if (arg.startsWith("--variant=")) out.variant = arg.slice(10);
    else if (arg.startsWith("--variant-name=")) out.variantName = arg.slice(15);
    else if (arg.startsWith("--level=")) out.level = Number(arg.slice(8)) | 0;
    else if (arg.startsWith("--dense-lod=")) out.denseLod = Number(arg.slice(12)) | 0;
    else if (arg.startsWith("--absolute-lod=")) out.absoluteLod = Number(arg.slice(15)) | 0;
    else if (arg.startsWith("--error=")) out.error = Number(arg.slice(8));
    else if (arg.startsWith("--fraction-band=")) out.fractionBand = Number(arg.slice(16));
    else if (arg.startsWith("--out=")) out.out = arg.slice(6);
    else throw new Error(`unknown arg: ${arg}`);
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
  + ` prune above at ${args.error} m, centimetres within ${args.fractionBand} m of sea level`);

if (args.validate) {
  console.log(validatePlanet(outPath));
  process.exit(0);
}

/* ---------------------------------------------------------------- sources */

const terrain = await createPackageTerrain({
  bakeDir, planet, sketchFingerprint, level, cells, tileSide, nodeRes, leafLod,
});

const started = Date.now();
await mkdir(dirname(outPath), {recursive: true});
const stats = await buildPackage({
  terrain, outPath, level, nodeRes, leafLod,
  denseLod: args.denseLod, absoluteLod, errorM: args.error, fractionBandM: args.fractionBand,
  identity: {
    body: run.project, variant: variantId, seed, radius_m: radiusKm * 1000,
    tile_cells: cells, sketch_fingerprint: sketchFingerprint,
  },
  progress: (line) => process.stdout.write(line),
});
console.log();

const size = (await stat(outPath)).size;
console.log(`\n${stats.nodes} nodes, ${stats.pruned} pruned, ${stats.sketchOnly} tiles sketch-only,`
  + ` ${stats.fractional} with centimetres`);
console.log(`${(size / 1e6).toFixed(1)} MB  (blobs ${(stats.blobBytes / 1e6).toFixed(1)} MB)`
  + `  in ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(`wrote ${outPath}`);
console.log(`check it:  bun run build:package --project=${run.project}`
  + ` --variant-name=${args.variantName || ""} --validate`);
