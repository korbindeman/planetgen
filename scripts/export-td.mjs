#!/usr/bin/env bun
/**
 * Export planetgen as terrain-diffusion conditioning GeoTIFFs.
 *
 * Usage:
 *   bun run export:td
 *   bun run export:td --seed=88 --scale=23
 *   bun run export:td --lon=90 --crops=3
 *
 * Writes preview/terrain-diffusion/:
 *   examples.png              world sketch + crop windows
 *   world/*.tif               full equirect (inspection only)
 *   crop-<name>/*.tif         regional tiles for `tiff-export`
 *
 * Feed a crop folder to terrain-diffusion:
 *   python -m terrain_diffusion xandergos/terrain-diffusion-90m \
 *     tiff-export preview/terrain-diffusion/crop-coast/ out.tif \
 *     --snr 0.2,0.2,1.0,0.2,1.0
 *
 * Do not tiff-export the whole world raster: the model upsamples 256×
 * on each axis. Regional mid-latitude crops are the Azgaar-equivalent.
 */
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Tectonics = require(join(root, "tectonics.js"));
const Planet = require(join(root, "planet.js"));
const Render = require(join(root, "software-render.js"));

const outDir = join(root, "preview", "terrain-diffusion");

const CHANNELS = [
  "heightmap",
  "temperature",
  "temperature_std",
  "precipitation",
  "precipitation_cv",
];

const TD_TEMP_SCALE = 40;
const TD_TEMP_OFFSET = -15;
const TD_PRECIP_MIN = 60;
const TD_PRECIP_RANGE = 3400;
const TD_PRECIP_POWER = 1.55;
const TD_EARTH_KM = 40075.017;
const PI = Math.PI;
const {elevationToMeters, clamp01} = Tectonics;

const { seed, lon0, scaleKm, crops, connectOceans, width, height } = parseArgs(
  process.argv.slice(2),
);

const planet = Planet.generatePlanet({
  seed: seed == null ? 88 : seed,
  connectOceans,
});

const lon0Rad = lon0 * PI / 180;
const cropW = 48;
const cropH = 32;
const cropCount = crops;

const rawWorld = Planet.rasterizeEquirect(planet.mesh, planet.map, width, height, lon0Rad);
const world = fieldsToTdLayers(rawWorld, width, height);
const overviewKm = TD_EARTH_KM / width;
const winW = Math.max(8, Math.round(cropW * scaleKm * width / TD_EARTH_KM));
const winH = Math.max(6, Math.round(cropH * scaleKm * 2 * height / TD_EARTH_KM));
const picks = pickTdCrops(world, {winW, winH, count: cropCount});

const cropRecords = picks.map((pick) => {
  const bounds = pixelBounds(pick.x, pick.y, pick.winW, pick.winH, width, height);
  const southRad = bounds.south * PI / 180;
  const northRad = bounds.north * PI / 180;
  const raw = Planet.rasterizeLonLatBox(
    planet.mesh, planet.map,
    bounds.west, bounds.south, bounds.east, bounds.north,
    cropW, cropH, lon0Rad,
  );
  const layers = fieldsToTdLayers(raw, cropW, cropH, (row) => (
    northRad - (row + 0.5) / cropH * (northRad - southRad)
  ));
  return {
    name: pick.name,
    x: pick.x,
    y: pick.y,
    winW: pick.winW,
    winH: pick.winH,
    landFrac: pick.landFrac,
    ...bounds,
    layers,
    previewPng: Render.drawCropPreview(layers, pick.name),
  };
});

await mkdir(outDir, { recursive: true });
const worldPreviewPng = Render.drawWorldSheet(world, picks, cropRecords.map((c) => c.layers));
await writeFile(join(outDir, "examples.png"), worldPreviewPng);

const worldBounds = {
  west: -180 + lon0,
  south: -90,
  east: 180 + lon0,
  north: 90,
};
await writeFolder(join(outDir, "world"), world, worldBounds);
await writeFile(join(outDir, "world", "preview.png"), worldPreviewPng);

const manifest = {
  seed: planet.seed,
  n: planet.n,
  plates: planet.p,
  scaleKm,
  overviewKm,
  lon0,
  model: "xandergos/terrain-diffusion-90m",
  snr: "0.2,0.2,1.0,0.2,1.0",
  note:
    "Use crop-* folders with tiff-export. World TIFFs are the planetary sketch, not a single export job.",
  crops: [],
};

for (const crop of cropRecords) {
  const dir = join(outDir, `crop-${crop.name}`);
  const bounds = {
    west: crop.west + lon0,
    south: crop.south,
    east: crop.east + lon0,
    north: crop.north,
  };
  await writeFolder(dir, crop.layers, bounds);
  await writeFile(join(dir, "preview.png"), crop.previewPng);
  manifest.crops.push({
    name: crop.name,
    dir: `crop-${crop.name}`,
    width: cropW,
    height: cropH,
    landFrac: crop.landFrac,
    ...bounds,
    outputPx: [cropW * 256, cropH * 256],
    coverageKm: [cropW * scaleKm, cropH * scaleKm],
  });
  console.log(join(dir, "heightmap.tif"));
}

await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(join(outDir, "examples.png"));
console.log(`seed ${planet.seed}  scale ${scaleKm} km/px`);

async function writeFolder(dir, layers, bounds) {
  await mkdir(dir, { recursive: true });
  for (const name of CHANNELS) {
    const tif = encodeFloat32GeoTiff(
      layers.width,
      layers.height,
      layers[name],
      bounds,
    );
    await writeFile(join(dir, `${name}.tif`), tif);
  }
}

function temperatureToC(t) {
  return Math.max(-40, Math.min(40, TD_TEMP_SCALE * t + TD_TEMP_OFFSET));
}

function moistureToPrecipMm(m) {
  return TD_PRECIP_MIN + TD_PRECIP_RANGE * Math.pow(clamp01(m), TD_PRECIP_POWER);
}

function temperatureStdC(moisture, elevationM, latRad) {
  const mid = Math.sin(2 * Math.abs(latRad));
  const inland = elevationM >= 0 ? (1 - clamp01(moisture)) : 0.12;
  return 2.4 + 14 * mid * mid * (0.35 + 0.65 * inland);
}

function precipitationCvPct(moisture, latRad) {
  const dry = 1 - clamp01(moisture);
  const seasonal = 0.45 + 0.55 * Math.abs(Math.sin(2 * latRad));
  return 16 + 58 * dry * seasonal;
}

function latOfRow(y, height) {
  return (PI / 2) - (y + 0.5) / height * PI;
}

function fieldsToTdLayers(fields, w, h, latAtRow) {
  const n = w * h;
  const heightmap = new Float32Array(n);
  const temperature = new Float32Array(n);
  const temperatureStd = new Float32Array(n);
  const precipitation = new Float32Array(n);
  const precipitationCv = new Float32Array(n);
  const rowLat = latAtRow || ((y) => latOfRow(y, h));
  for (let y = 0; y < h; y++) {
    const lat = rowLat(y);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const eM = elevationToMeters(fields.elev[i]);
      const tC = temperatureToC(fields.temp[i]);
      const m = fields.moist[i];
      heightmap[i] = eM;
      temperature[i] = tC;
      temperatureStd[i] = temperatureStdC(m, eM, lat);
      precipitation[i] = moistureToPrecipMm(m);
      precipitationCv[i] = precipitationCvPct(m, lat);
    }
  }
  return {
    heightmap,
    temperature,
    temperature_std: temperatureStd,
    precipitation,
    precipitation_cv: precipitationCv,
    width: w,
    height: h,
  };
}

function windowStats(layers, x0, y0, winW, winH) {
  const {width, height, heightmap, temperature, precipitation} = layers;
  let land = 0, coast = 0, n = 0;
  let eSum = 0, eSum2 = 0, eMin = Infinity, eMax = -Infinity;
  let tMin = Infinity, tMax = -Infinity, pMin = Infinity, pMax = -Infinity;
  for (let y = y0; y < y0 + winH; y++) {
    for (let x = x0; x < x0 + winW; x++) {
      const i = y * width + x;
      const e = heightmap[i];
      n++;
      if (e >= 0) {
        land++;
        eSum += e;
        eSum2 += e * e;
        if (e < eMin) eMin = e;
        if (e > eMax) eMax = e;
      }
      const t = temperature[i];
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
      const p = precipitation[i];
      if (p < pMin) pMin = p;
      if (p > pMax) pMax = p;
      const left = x > 0 && heightmap[i - 1] >= 0;
      const right = x + 1 < width && heightmap[i + 1] >= 0;
      const up = y > 0 && heightmap[i - width] >= 0;
      const down = y + 1 < height && heightmap[i + width] >= 0;
      const here = e >= 0;
      if (here !== left || here !== right || here !== up || here !== down) coast++;
    }
  }
  const landFrac = land / n;
  const mean = land ? eSum / land : 0;
  const elevStd = land > 1 ? Math.sqrt(Math.max(0, eSum2 / land - mean * mean)) : 0;
  return {
    x: x0,
    y: y0,
    landFrac,
    coastFrac: coast / n,
    elevStd,
    elevRange: land ? eMax - eMin : 0,
    tempRange: tMax - tMin,
    precipRange: pMax - pMin,
  };
}

function pickTdCrops(layers, opts) {
  const {width, height} = layers;
  const winW = Math.max(8, Math.min(width, opts.winW));
  const winH = Math.max(6, Math.min(height, opts.winH));
  const stepX = Math.max(1, Math.floor(winW / 3));
  const stepY = Math.max(1, Math.floor(winH / 3));
  const yMargin = Math.floor(height * (40 / 180));
  const scored = [];
  for (let y = yMargin; y + winH <= height - yMargin; y += stepY) {
    for (let x = stepX; x + winW <= width - stepX; x += stepX) {
      const s = windowStats(layers, x, y, winW, winH);
      if (s.landFrac < 0.22 || s.landFrac > 0.92) continue;
      scored.push(s);
    }
  }
  if (!scored.length) return [];

  const picks = [];
  function takeBest(name, scoreFn) {
    let best = null, bestScore = -Infinity;
    for (const s of scored) {
      if (picks.some((p) => Math.abs(p.x - s.x) < winW * 0.85 && Math.abs(p.y - s.y) < winH * 0.85)) {
        continue;
      }
      const score = scoreFn(s);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best) picks.push({name, ...best, winW, winH});
  }

  takeBest("coast", (s) => (
    s.coastFrac * 2
    + Math.min(s.landFrac, 1 - s.landFrac) * 1.4
    + s.elevStd / 700
    + s.elevRange / 2800
  ));
  takeBest("mountains", (s) => s.elevStd / 800 + s.elevRange / 4000 + s.landFrac);
  takeBest("climate", (s) => s.tempRange / 20 + s.precipRange / 2500 + s.coastFrac + s.elevRange / 5000);
  return picks.slice(0, opts.count);
}

function pixelBounds(x, y, winW, winH, w, h) {
  const west = -180 + x / w * 360;
  const east = -180 + (x + winW) / w * 360;
  const north = 90 - y / h * 180;
  const south = 90 - (y + winH) / h * 180;
  return {west, south, east, north};
}

function encodeFloat32GeoTiff(w, h, data, bounds) {
  if (data.length !== w * h) {
    throw new Error(`tiff data length ${data.length} != ${w * h}`);
  }
  const imageBytes = w * h * 4;
  const sx = (bounds.east - bounds.west) / w;
  const sy = (bounds.north - bounds.south) / h;

  const tags = [];
  const extras = [];
  function addInline(id, type, value) {
    tags.push({ id, type, count: 1, value });
  }
  function addExtra(id, type, bytes) {
    tags.push({ id, type, count: bytes.length / (type === 12 ? 8 : 2), extra: extras.length });
    extras.push(bytes);
  }

  addInline(256, 4, w);
  addInline(257, 4, h);
  addInline(258, 3, 32);
  addInline(259, 3, 1);
  addInline(262, 3, 1);
  addInline(273, 4, 0);
  addInline(277, 3, 1);
  addInline(278, 4, h);
  addInline(279, 4, imageBytes);
  addInline(284, 3, 1);
  addInline(339, 3, 3);
  addExtra(33550, 12, doubles([sx, sy, 0]));
  addExtra(33922, 12, doubles([0, 0, 0, bounds.west, bounds.north, 0]));
  addExtra(34735, 3, geoKeys());

  tags.sort((a, b) => a.id - b.id);
  const header = 8;
  const ifdSize = 2 + tags.length * 12 + 4;
  const extraStart = header + ifdSize;
  const extraBytes = extras.reduce((n, b) => n + b.length, 0);
  const imageStart = extraStart + extraBytes;

  const buf = Buffer.alloc(imageStart + imageBytes);
  buf.write("II");
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(header, 4);
  buf.writeUInt16LE(tags.length, header);

  let extraOff = extraStart;
  const extraOffsets = extras.map((bytes) => {
    const at = extraOff;
    extraOff += bytes.length;
    return at;
  });

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const at = header + 2 + i * 12;
    buf.writeUInt16LE(tag.id, at);
    buf.writeUInt16LE(tag.type, at + 2);
    buf.writeUInt32LE(tag.count, at + 4);
    if (tag.id === 273) {
      buf.writeUInt32LE(imageStart, at + 8);
    } else if (tag.extra != null) {
      buf.writeUInt32LE(extraOffsets[tag.extra], at + 8);
    } else {
      buf.writeUInt32LE(tag.value, at + 8);
    }
  }
  buf.writeUInt32LE(0, header + 2 + tags.length * 12);

  extraOff = extraStart;
  for (const bytes of extras) {
    Buffer.from(bytes).copy(buf, extraOff);
    extraOff += bytes.length;
  }
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(buf, imageStart);
  return buf;
}

function doubles(values) {
  const buf = Buffer.alloc(values.length * 8);
  for (let i = 0; i < values.length; i++) buf.writeDoubleLE(values[i], i * 8);
  return buf;
}

function geoKeys() {
  const buf = Buffer.alloc(16 * 2);
  const keys = [
    1, 1, 0, 3,
    1024, 0, 1, 2,
    1025, 0, 1, 1,
    2048, 0, 1, 4326,
  ];
  for (let i = 0; i < keys.length; i++) buf.writeUInt16LE(keys[i], i * 2);
  return buf;
}

function parseArgs(argv) {
  let seed;
  let lon0 = 0;
  let scaleKm = 23;
  let crops = 3;
  let connectOceans = false;
  let width = 720;
  let height = 360;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const nextNum = (name) => {
      const next = argv[++i];
      if (next == null || Number.isNaN(Number(next))) {
        throw new Error(`${name} needs a number`);
      }
      return Number(next);
    };
    if (arg === "--seed") seed = nextNum(arg) | 0;
    else if (arg.startsWith("--seed=")) seed = Number(arg.slice(7)) | 0;
    else if (arg === "--lon" || arg === "--lon0") lon0 = nextNum(arg);
    else if (arg.startsWith("--lon=") || arg.startsWith("--lon0=")) {
      lon0 = Number(arg.slice(arg.indexOf("=") + 1));
    } else if (arg === "--scale") scaleKm = nextNum(arg);
    else if (arg.startsWith("--scale=")) scaleKm = Number(arg.slice(8));
    else if (arg === "--crops") crops = nextNum(arg) | 0;
    else if (arg.startsWith("--crops=")) crops = Number(arg.slice(8)) | 0;
    else if (arg === "--width") width = nextNum(arg) | 0;
    else if (arg.startsWith("--width=")) width = nextNum(arg) | 0;
    else if (arg === "--height") height = nextNum(arg) | 0;
    else if (arg.startsWith("--height=")) height = Number(arg.slice(9)) | 0;
    else if (arg === "--connect-oceans") connectOceans = true;
    else {
      throw new Error(
        `unknown export-td arg: ${arg}\n` +
          "usage: bun run export:td [--seed=n] [--lon=deg] [--scale=km] [--crops=n]",
      );
    }
  }
  return { seed, lon0, scaleKm, crops, connectOceans, width, height };
}
