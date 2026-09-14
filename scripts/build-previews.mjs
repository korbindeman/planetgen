#!/usr/bin/env bun
/**
 * Write the small DEM the web app drapes, one per baked tile.
 *
 *   bun run build:previews --project=quarter --variant-name=glep
 *   bun run build:previews --project=quarter --variant-name=glep --res=448
 *
 * The studio keeps a float DEM *and* a painted canvas for every crop, and
 * colours the DEM on the main thread. At 3584² that is 51 MB and 12.85 Mpx a
 * tile, so a 250-tile planet asks the browser for 12.8 GB twice over. It
 * stops responding long before the planet draws.
 *
 * ## Why this filters rather than box-averaging
 *
 * Hillshading is not linear, so `shade(downsample(h))` is not
 * `downsample(shade(h))`. Rendered side by side at the same size, a tile
 * shaded at 3584² and then reduced looks soft and finely detailed; the same
 * tile reduced to 448² by box average and *then* shaded looks harsh and
 * faceted — every surviving feature becomes a hard edge, because averaging
 * strips the fine structure that would have softened a slope while keeping
 * the large step between neighbouring coarse texels.
 *
 * A box average is also a poor low-pass: it leaves aliasing that the shader
 * then amplifies. So the reduction here is a **separable Gaussian** sampled
 * at the destination centres, sigma tied to the decimation ratio. It cannot
 * make a coarse DEM shade like a fine one — only rendering near-native does
 * that, which is the LOD work — but it takes out the aliasing and most of
 * the hard-edged look.
 *
 * This reads the tile raster rather than the package's pyramid. The package's
 * levels must stay exact box reductions, because its parent predictor depends
 * on them; a preview is a picture and wants the filter that looks right. They
 * are allowed to differ, because nothing reconstructs anything from a preview.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectBakeDir } from "./td-overlays.mjs";
import { resolveRun } from "./project-run.mjs";
import { campaignHalo } from "./preview-halo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Cube = require(join(root, "src", "cubesphere.js"));
const Projects = require(join(root, "src", "projects"));
const PreviewDem = require(join(root, "src", "preview-dem"));

const DEFAULT_RES = 896;

function parseArgs(argv) {
  const out = {res: DEFAULT_RES};
  for (const arg of argv) {
    if (arg.startsWith("--project=")) out.project = arg.slice(10);
    else if (arg.startsWith("--variant=")) out.variant = arg.slice(10);
    else if (arg.startsWith("--variant-name=")) out.variantName = arg.slice(15);
    else if (arg.startsWith("--res=")) out.res = Number(arg.slice(6)) | 0;
    else if (arg.startsWith("--tiles=")) out.tiles = arg.slice(8).split(",").map((name) => {
      if (!Cube.parseTileName(name)) throw new Error(`invalid tile: ${name}`);
      return `crop-${name}`;
    });
    else throw new Error(`unknown arg: ${arg}`);
  }
  if (!(out.res > 0)) throw new Error("--res must be positive");
  return out;
}

const args = parseArgs(process.argv.slice(2));
const run = await resolveRun(root, Projects, args.project, null, args.variant);
let variantId = run.variant;
if (args.variantName) {
  const raw = JSON.parse(await readFile(join(root, Projects.catalogPath(run.project)), "utf8"));
  const catalog = Projects.parseCatalog(raw, run.project);
  const want = args.variantName.toLowerCase();
  const found = Projects.Variants.live(catalog.variants)
    .find((v) => String(v.name || "").toLowerCase() === want);
  if (!found) throw new Error(`no live variant named "${args.variantName}"`);
  variantId = found.id;
}

const bakeDir = projectBakeDir(root, run.project, variantId);
const R = args.res;
const padded = await campaignHalo(bakeDir);
console.log(`writing ${R}x${R} previews into ${bakeDir}`);

const { readdir } = await import("node:fs/promises");
const folders = (await readdir(bakeDir, {withFileTypes: true}))
  .filter((e) => e.isDirectory() && e.name.startsWith("crop-"))
  .map((e) => e.name)
  .filter((name) => !args.tiles || args.tiles.includes(name));

let written = 0, skipped = 0, srcSide = 0, bytes = 0;
for (const folder of folders) {
  const dir = join(bakeDir, folder);
  let meta, src;
  try {
    meta = JSON.parse(await readFile(join(dir, "output.elev.json"), "utf8"));
    const buf = await readFile(join(dir, "output.elev"));
    src = new Float32Array(buf.buffer, buf.byteOffset, meta.width * meta.height);
  } catch {
    skipped++;
    continue;
  }
  srcSide = meta.width;
  if (meta.width <= R) { skipped++; continue; }   // already small enough
  const tile = Cube.parseTileName(folder.slice(5));
  // Keep two filtered neighbour pixels for both the painter's derivative and
  // bilinear texture sampling at the nominal tile edge.
  const outPad = padded && tile ? 2 : 0;
  const pad = outPad ? PreviewDem.haloSize(meta.width, meta.height, R, R, outPad) : 0;
  const input = pad ? await padded(tile, src, meta.width, meta.height, pad) : src;
  const out = PreviewDem.downsample(input, meta.width, meta.height, R, R, pad, outPad);
  await writeFile(join(dir, "preview.elev"),
    Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  await writeFile(join(dir, "preview.elev.json"), JSON.stringify({
    width: R + 2 * outPad, height: R + 2 * outPad, padPixels: outPad,
  }));
  bytes += out.byteLength;
  written++;
  if (written % 25 === 0) process.stdout.write(`\r  ${written}/${folders.length}   `);
}

const mb = bytes / 1e6;
console.log(`\rwrote ${written} previews${skipped ? `, skipped ${skipped}` : ""}`);
console.log(`${mb.toFixed(0)} MB of DEM (from ${(written * srcSide * srcSide * 4 / 1e9).toFixed(1)} GB)`);
/* The overlay caches a painted canvas per crop as well, so the browser holds
 * roughly twice this. Worth saying out loud before it is discovered. */
console.log(`the studio will hold ~${(mb * 2 / 1000).toFixed(1)} GB with paint caches;`
  + ` drop --res if that is too much`);
