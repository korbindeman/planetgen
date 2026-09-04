#!/usr/bin/env bun
/**
 * Put a bake that was left on the face's conformal plane back onto the tile
 * raster.
 *
 * A tile baked by a td-server older than the bake-plane change kept the raw
 * `td-preview.py` dump as its `output.elev`: cropW x cropH cells of the
 * face's lattice, not the tile's own square. Everything downstream — the
 * drape, the stitch, the painter — reads that file as the tile raster, so
 * the whole tile lands warped and its neighbours do not meet it.
 *
 * Same maths as `bakeBackOntoTile` in scripts/td-jobs.mjs. The difference is
 * where the rect comes from: there it is the live job, here it is recovered
 * from tile.json, and the recovery has to agree with `tileBakeRect` before
 * anything is written.
 *
 *   bun scripts/repair-tile-raster.mjs <variant-dir> <tile>...
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Cube = require(join(root, "src", "cubesphere.js"));
const Seam = require(join(root, "src", "td-seam.js"));
const TdTile = require(join(root, "src", "td-tile.js"));

const dir = process.argv[2];
const names = process.argv.slice(3);
if (!dir || !names.length) {
  console.error("usage: bun scripts/repair-tile-raster.mjs <variant-dir> <tile>...");
  process.exit(2);
}

for (const n of names) {
  const d = join(dir, `crop-${n}`);
  const t = JSON.parse(readFileSync(join(d, "tile.json"), "utf8"));
  if (t.bakeStep > 0) {
    console.log(`${n}: already on the tile raster, skipped`);
    continue;
  }
  const m = JSON.parse(readFileSync(join(d, "output.elev.json"), "utf8"));
  const srcW = m.width | 0;
  const srcH = m.height | 0;
  const tile = {face: t.face, level: t.level, i: t.i, j: t.j};
  /*
   * tile.json predates the bakeStep/tileCells fields, so recover the cell
   * count by finding the one whose bake rect reproduces the recorded origin
   * and the dump that is actually on disk. Self-verifying: no match, no write.
   */
  const halo = TdTile.haloCellsFor(tile);
  let tileCells = 0;
  let full = null;
  let cropW = 0;
  let cropH = 0;
  for (let c = TdTile.MIN_CELLS; c <= TdTile.MAX_CELLS; c++) {
    const r = Cube.tileBakeRect(tile, c, t.padCells, halo);
    const w = r.width - 2 * t.padCells;
    const h = r.height - 2 * t.padCells;
    if (r.originI === t.originI && r.originJ === t.originJ && w === t.cells
      && srcW === w * TdTile.TILE_PX_PER_CELL && srcH === h * TdTile.TILE_PX_PER_CELL) {
      tileCells = c;
      full = r;
      cropW = w;
      cropH = h;
      break;
    }
  }
  if (!full) {
    console.log(`${n}: no cell count reproduces origin ${t.originI},${t.originJ}`
      + ` and a ${srcW}x${srcH} dump — left alone`);
    continue;
  }
  const raw = readFileSync(join(d, "output.elev"));
  const src = new Float32Array(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + srcW * srcH * 4),
  );
  const rect = {
    step: full.step,
    originI: t.originI + t.padCells,
    originJ: t.originJ + t.padCells,
    width: cropW,
    height: cropH,
  };
  const side = Math.max(64, Math.round(tileCells * (srcW / cropW)));
  const out = Seam.bakeToTile(tile, rect, src, srcW, srcH, side, side);
  writeFileSync(join(d, "output.elev"), Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  writeFileSync(join(d, "output.elev.json"), JSON.stringify({width: side, height: side}));
  writeFileSync(join(d, "tile.json"), JSON.stringify({
    ...t,
    tileCells,
    bakeStep: full.step,
    haloCells: TdTile.SEAM_HALO_CELLS,
  }, null, 2));
  console.log(`${n}: ${srcW}x${srcH} of bake plane -> ${side}x${side} tile raster`
    + ` (${tileCells} cells, step ${full.step})`);
}
