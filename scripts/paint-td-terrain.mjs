/**
 * Paint a baked DEM with the globe's surface look.
 *
 * The overlay replaces that lon/lat box. It has to be the same picture
 * the mesh uses — albedo + lighting — or the tile reads as another map.
 * Hypsometric ramps and a grey multiply layer are both the wrong picture.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFloat32GeoTiff } from "./td-geotiff.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));
const Look = require(join(here, "..", "src", "look.js"));
const Shade = require(join(here, "..", "src", "td-shade.js"));
const TdTile = require(join(here, "..", "src", "td-tile.js"));
const Tectonics = require(join(here, "..", "src", "tectonics.js"));
const {encodePng} = require(join(here, "..", "src", "png.js"));

/* The inverse of the export's conversions, and it has to stay the inverse:
 * colouring a tile on a different scale from the one it was conditioned on is
 * a whole-crop colour error. So the constants come from there. */
const {
  TEMP_OFFSET, TEMP_SCALE, PRECIP_MIN, PRECIP_RANGE, PRECIP_POWER,
} = require(join(here, "..", "src", "td-export.js"));

function tempCToT(c) {
  return (Number(c) - TEMP_OFFSET) / TEMP_SCALE;
}

function precipToM(mm) {
  const x = Math.max(0, (Number(mm) - PRECIP_MIN) / PRECIP_RANGE);
  return Math.pow(x, 1 / PRECIP_POWER);
}

async function readChannel(dir, name) {
  try {
    return readFloat32GeoTiff(Buffer.from(await readFile(join(dir, `${name}.tif`))));
  } catch {
    return null;
  }
}

/* padCells, and where on the sphere this crop sits — the shading frame
 * needs the latter or the tile is lit in its own texel axes. */
async function readCropMeta(dir) {
  try {
    const meta = JSON.parse(await readFile(join(dir, "tile.json"), "utf8"));
    const {face, level, i, j} = meta;
    const tile = [face, level, i, j].every(Number.isInteger) ? {face, level, i, j} : null;
    return {pad: Math.max(0, meta.padCells | 0), tile, ...(meta.nominalBounds || {})};
  } catch {
    return {pad: 0, tile: null};
  }
}

export async function paintCropTerrain(dir) {
  const meta = JSON.parse(await readFile(join(dir, "output.elev.json"), "utf8"));
  const w = meta.width | 0;
  const h = meta.height | 0;
  const raw = await readFile(join(dir, "output.elev"));
  if (raw.byteLength < w * h * 4) throw new Error(`elev dump is short in ${dir}`);
  const elevM = new Float32Array(raw.buffer, raw.byteOffset, w * h);
  const crop = await readCropMeta(dir);
  const pad = crop.pad;

  const tempTiff = await readChannel(dir, "temperature");
  const precipTiff = await readChannel(dir, "precipitation");

  const e = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) e[i] = Tectonics.metersToElevation(elevM[i]);
  const shading = Shade.cropShade(e, w, h, crop);

  const fade = Math.max(6, Math.round(Math.min(w, h) * 0.04));
  const rgba = Buffer.alloc(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const fx = (x + 0.5) / w;
      const fy = (y + 0.5) / h;
      const temp = tempTiff
        ? tempCToT(TdTile.samplePadded(tempTiff.data, tempTiff.width, tempTiff.height, fx, fy, pad))
        : 0.85;
      const moist = precipTiff
        ? precipToM(TdTile.samplePadded(precipTiff.data, precipTiff.width, precipTiff.height, fx, fy, pad))
        : 0.55;
      const [r, g, b] = Look.surfaceAlbedo(e[i], moist, temp);
      const shade = shading[i];
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
      const alpha = edge >= fade ? 255 : Math.round(255 * (edge / fade));
      rgba[i * 4] = Math.round(r * shade * 255);
      rgba[i * 4 + 1] = Math.round(g * shade * 255);
      rgba[i * 4 + 2] = Math.round(b * shade * 255);
      rgba[i * 4 + 3] = alpha;
    }
  }

  const png = encodePng(rgba, w, h);
  await writeFile(join(dir, "output.png"), png);
  return join(dir, "output.png");
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: bun scripts/paint-td-terrain.mjs <crop-dir>");
    process.exit(2);
  }
  const out = await paintCropTerrain(dir);
  console.log(out);
}
