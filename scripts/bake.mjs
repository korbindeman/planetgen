#!/usr/bin/env bun
/**
 * Headless bake entry for the home 4070 Ti box.
 *
 * Mac (here): `bun run bake --dry-run` locks the variant and validates the
 * conditioning path without a GPU. On the bake box after pull:
 * `bun run bake --shards=N --shard=i` writes that shard's tile list; each
 * shard is baked with the sibling terrain-diffusion checkout (TD_ROOT).
 *
 * Full 90 m planet bake is still open work (face raster + seams per
 * docs/stages/terrain.md). This entry exists so the variant lock, the
 * conditioning export, and the shard plan are already deterministic.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Projects = require(join(root, "src", "projects"));
const Cube = require(join(root, "src", "cubesphere.js"));
const { exportProjectCrops } = await import("./export-project.mjs");
const { projectBakeDir } = await import("./td-overlays.mjs");

const MODEL = "xandergos/terrain-diffusion-90m";
const SNR = "0.2,0.2,1.0,0.2,1.0";
const CHEAP_LEVEL = 2; // 6*4^2 = 96 tiles: whole-planet coarse pass
const FULL_LEVEL = 8; // 6*4^8 = 393k grid tiles at 90 m incl. ocean; land/shelf mask TBD

const args = parseArgs(process.argv.slice(2));
const project = Projects.byName(args.project || Projects.DEFAULT);

const catalog = await loadCatalog(project.name);
let variant = pickVariant(catalog, args);
if (!variant) variant = await loadVendored(project.name, args);
if (!variant) throw new Error(`no live variant matching ${args.variantName || args.variant || "(latest)"} and no vendored fallback`);

const slug = String(variant.name || variant.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || variant.id;
const bakeDir = join(root, "bake", `${project.name}-${slug}`);
await mkdir(bakeDir, { recursive: true });

const tileList = listTiles(args.level ?? CHEAP_LEVEL);
const shards = splitTiles(tileList, args.shards);
const shard = shards[args.shard] || [];

const manifest = {
  project: project.name,
  variant: variant.id,
  variantName: variant.name,
  seed: variant.seed,
  model: MODEL,
  snr: SNR,
  level: args.level ?? CHEAP_LEVEL,
  tiles: tileList.length,
  shards: args.shards,
  shard: args.shard,
  shardTiles: shard.map(Cube.tileName),
  tdRoot: process.env.TD_ROOT || "~/dev/terrain-diffusion",
  device: process.platform === "darwin" ? "mps" : "cuda",
  status: "face-raster-open",
};
await writeFile(join(bakeDir, "manifest.json"), JSON.stringify(manifest, null, 2));
await writeFile(join(bakeDir, `shard-${args.shard}-of-${args.shards}.json`), JSON.stringify(shard, null, 2));

if (args.dryRun) {
  const exported = await exportProjectCrops(root, {
    project: project.name,
    seed: variant.seed,
    values: Projects.recipeOf(variant, project.body),
    variant: variant.id,
  });
  console.log(`variant ${variant.name} (${variant.id}) seed ${exported.manifest.seed}`);
  console.log(`conditioning ok: ${exported.crops.length} crops under ${exported.outDir}`);
  console.log(`manifest: bake/${project.name}-${slug}/manifest.json`);
  console.log(`shard ${args.shard}/${args.shards}: ${shard.length} tiles at level ${manifest.level}`);
  console.log(`tile e.g.: ${shard.slice(0, 3).map(Cube.tileName).join(", ")}`);
} else {
  const dir = projectBakeDir(root, project.name, variant.id);
  console.log(`bake dir: ${dir}`);
  console.log(`shard file: bake/${project.name}-${slug}/shard-${args.shard}-of-${args.shards}.json`);
  console.log(`next on 4070 Ti box: TD_ROOT=~/dev/terrain-diffusion bun scripts/td-bake.py ... (face jobs land here once face raster lands)`);
}

function listTiles(level) {
  const n = 1 << level;
  const out = [];
  for (let face = 0; face < 6; face++)
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push({ face, level, i, j });
  return out;
}

function splitTiles(tiles, shards) {
  const parts = Array.from({ length: shards }, () => []);
  tiles.forEach((t, k) => parts[k % shards].push(t));
  return parts;
}

async function loadCatalog(name) {
  try {
    const raw = JSON.parse(await readFile(join(root, Projects.catalogPath(name)), "utf8"));
    return Projects.parseCatalog(raw, name);
  } catch {
    return null; // preview/ is gitignored; the bake box falls back to the vendored variant
  }
}

function pickVariant(catalog, { variant, variantName }) {
  if (!catalog) return null;
  const live = catalog.variants.filter((v) => !v.deleted);
  if (variant) return live.find((v) => v.id === variant) || null;
  if (variantName) {
    const want = variantName.toLowerCase();
    return live.find((v) => String(v.name || "").toLowerCase() === want)
      || live.find((v) => String(v.name || "").toLowerCase().includes(want)) || null;
  }
  return live[0] || null;
}

async function loadVendored(projectName, { variant, variantName }) {
  /*
   * preview/ is gitignored so the catalog does not travel. bake/<slug>/
   * vendors the one variant the bake needs; match by id or name.
   */
  const { readdir } = await import("node:fs/promises");
  let dirs;
  try {
    dirs = await readdir(join(root, "bake"));
  } catch {
    return null;
  }
  for (const dir of dirs) {
    if (!dir.startsWith(`${projectName}-`)) continue;
    try {
      const v = JSON.parse(await readFile(join(root, "bake", dir, "variant.json"), "utf8"));
      if (variant && v.id === variant) return v;
      if (variantName) {
        const want = variantName.toLowerCase();
        const name = String(v.name || "").toLowerCase();
        if (name === want || name.includes(want)) return v;
      } else if (!variant) return v;
    } catch { /* no vendored variant here */ }
  }
  return null;
}

function parseArgs(argv) {
  const out = { shards: 1, shard: 0, dryRun: false, level: CHEAP_LEVEL };
  for (const arg of argv) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--project=")) out.project = arg.slice(10);
    else if (arg.startsWith("--variant=")) out.variant = arg.slice(10);
    else if (arg.startsWith("--variant-name=")) out.variantName = arg.slice(15);
    else if (arg.startsWith("--shards=")) out.shards = Math.max(1, Number(arg.slice(9)) | 0);
    else if (arg.startsWith("--shard=")) out.shard = Math.max(0, Number(arg.slice(8)) | 0);
    else if (arg.startsWith("--level=")) out.level = Number(arg.slice(8)) | 0;
    else if (arg === "--full") out.level = FULL_LEVEL;
    else throw new Error(`unknown bake arg: ${arg}\nusage: bun run bake [--variant-name="south america"] [--dry-run] [--level=2|--full] [--shards=N --shard=i]`);
  }
  if (out.shard >= out.shards) throw new Error(`shard ${out.shard} out of range for ${out.shards} shards`);
  return out;
}
