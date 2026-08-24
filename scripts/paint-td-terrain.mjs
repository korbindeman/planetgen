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
const Tectonics = require(join(here, "..", "src", "tectonics.js"));
const {encodePng} = require(join(here, "..", "src", "png.js"));

const TD_TEMP_OFFSET = -15;
const TD_TEMP_SCALE = 40;
const TD_PRECIP_MIN = 60;
const TD_PRECIP_RANGE = 3400;
const TD_PRECIP_POWER = 1.55;

function tempCToT(c) {
  return (Number(c) - TD_TEMP_OFFSET) / TD_TEMP_SCALE;
}

function precipToM(mm) {
  const x = Math.max(0, (Number(mm) - TD_PRECIP_MIN) / TD_PRECIP_RANGE);
  return Math.pow(x, 1 / TD_PRECIP_POWER);
}

/* `x`,`y` in [0, 1] over the interior. Cube crops store a neighbour pad
 * around the GeoTIFF; skip it so climate lines up with the DEM. */
function sampleField(field, fw, fh, x, y, pad = 0) {
  const innerW = Math.max(1, fw - 2 * pad);
  const innerH = Math.max(1, fh - 2 * pad);
  const u = Math.max(0, Math.min(innerW - 1.001, pad + x * innerW));
  const v = Math.max(0, Math.min(innerH - 1.001, pad + y * innerH));
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const x1 = Math.min(fw - 1, x0 + 1), y1 = Math.min(fh - 1, y0 + 1);
  const tx = u - x0, ty = v - y0;
  const a = field[y0 * fw + x0], b = field[y0 * fw + x1];
  const c = field[y1 * fw + x0], d = field[y1 * fw + x1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

async function readChannel(dir, name) {
  try {
    return readFloat32GeoTiff(Buffer.from(await readFile(join(dir, `${name}.tif`))));
  } catch {
    return null;
  }
}

async function readPad(dir) {
  try {
    const tile = JSON.parse(await readFile(join(dir, "tile.json"), "utf8"));
    return Math.max(0, tile.padCells | 0);
  } catch {
    return 0;
  }
}

export async function paintCropTerrain(dir) {
  const meta = JSON.parse(await readFile(join(dir, "output.elev.json"), "utf8"));
  const w = meta.width | 0;
  const h = meta.height | 0;
  const raw = await readFile(join(dir, "output.elev"));
  if (raw.byteLength < w * h * 4) throw new Error(`elev dump is short in ${dir}`);
  const elevM = new Float32Array(raw.buffer, raw.byteOffset, w * h);
  const pad = await readPad(dir);

  const tempTiff = await readChannel(dir, "temperature");
  const precipTiff = await readChannel(dir, "precipitation");

  const e = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) e[i] = Tectonics.metersToElevation(elevM[i]);

  const fade = Math.max(6, Math.round(Math.min(w, h) * 0.04));
  const rgba = Buffer.alloc(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const fx = (x + 0.5) / w;
      const fy = (y + 0.5) / h;
      const temp = tempTiff
        ? tempCToT(sampleField(tempTiff.data, tempTiff.width, tempTiff.height, fx, fy, pad))
        : 0.85;
      const moist = precipTiff
        ? precipToM(sampleField(precipTiff.data, precipTiff.width, precipTiff.height, fx, fy, pad))
        : 0.55;
      const [r, g, b] = Look.surfaceAlbedo(e[i], moist, temp);
      const x0 = x === 0 ? x : x - 1;
      const x1 = x === w - 1 ? x : x + 1;
      const y0 = y === 0 ? y : y - 1;
      const y1 = y === h - 1 ? y : y + 1;
      const dedx = (e[y * w + x1] - e[y * w + x0]) / (x1 - x0);
      const dedy = (e[y1 * w + x] - e[y0 * w + x]) / (y1 - y0);
      const shade = Look.hillshade(dedx, dedy);
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
