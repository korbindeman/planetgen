#!/usr/bin/env bun
/**
 * Contact sheet of many seeds in one image, so a whole batch can be judged
 * at a glance instead of one capture at a time.
 *
 *   bun run sheet                       12 seeds, equirect
 *   bun run sheet --seeds=1,2,3         specific seeds
 *   bun run sheet --count=16 --from=200
 *   bun run sheet --view=globe
 *   bun run sheet --overlay=plates
 *   bun run sheet --no-tectonics
 *
 * Writes preview/seed-sheet.png.
 */
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Planet = require(join(root, "planet.js"));
const Render = require(join(root, "software-render.js"));

const previewDir = join(root, "preview");

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => a.replace(/^--/, "").split("=")),
);

const view = args.view ?? "equirect";
const overlay = args.overlay ?? null;
const noTectonics = "no-tectonics" in args;
const count = Number(args.count ?? 12);
const from = Number(args.from ?? 1);
const seeds = args.seeds
  ? String(args.seeds).split(",").map(Number)
  : Array.from({ length: count }, (_, i) => from + i);

const tiles = [];
for (const seed of seeds) {
  const planet = Planet.generatePlanet({
    seed,
    simulateTectonics: !noTectonics,
  });
  const png = view === "globe"
    ? Render.captureGlobe(planet, { overlay })
    : Render.captureEquirect(planet, { overlay });
  tiles.push({ seed, png });
  console.log(`seed ${seed}`);
}

await mkdir(previewDir, { recursive: true });
const out = join(previewDir, "seed-sheet.png");
await Bun.write(out, Render.seedSheet(tiles, view));
console.log(out);
