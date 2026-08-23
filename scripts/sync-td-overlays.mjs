/**
 * Point the live app at baked crop output.png files when the bake
 * server is down. bun --hot ./index.html will not serve preview/, so
 * this writes a small catalog the bundler can require.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listTdOverlays } from "./td-overlays.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src", ".td-overlays");

const listed = await listTdOverlays(root);
await mkdir(outDir, {recursive: true});

const lines = [
  `"use strict";`,
  `module.exports = {`,
  `  seed: ${JSON.stringify(listed.seed)},`,
  `  lon0: ${JSON.stringify(listed.lon0)},`,
  `  crops: [`,
];
for (const crop of listed.crops) {
  /*
   * PNG only, and only where one really exists. This file is the offline
   * fallback and its images get bundled, so it cannot carry the raw float
   * DEM — megabytes per tile — and it must not `require` a PNG that was
   * never written. A crop counts as baked on its elevation dump alone now,
   * so `crop.baked` is not the right test here; a real image url is.
   */
  if (!crop.image || !crop.image.startsWith("/preview/")) continue;
  const rel = `../../${crop.image.slice(1)}`;
  lines.push(`    {`);
  lines.push(`      name: ${JSON.stringify(crop.name)},`);
  lines.push(`      dir: ${JSON.stringify(crop.dir)},`);
  lines.push(`      project: ${JSON.stringify(crop.project)},`);
  lines.push(`      seed: ${JSON.stringify(crop.seed)},`);
  if (crop.tile) lines.push(`      tile: ${JSON.stringify(crop.tile)},`);
  lines.push(`      west: ${crop.west},`);
  lines.push(`      south: ${crop.south},`);
  lines.push(`      east: ${crop.east},`);
  lines.push(`      north: ${crop.north},`);
  lines.push(`      image: require(${JSON.stringify(rel)}),`);
  lines.push(`    },`);
}
lines.push(`  ],`);
lines.push(`};`);
lines.push(``);

await writeFile(join(outDir, "catalog.js"), lines.join("\n"));
const names = listed.crops.filter((c) => c.baked).map((c) => `${c.project}/${c.name}`);
console.log(names.length ? `td overlays  ${names.join(", ")}` : "td overlays  none (no crop-*/output.png)");
