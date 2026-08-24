/**
 * Write a project's regional conditioning crops.
 *
 * Shared by `bun run export:td` and the bake server. Crops land in
 * preview/<name>/, or preview/<name>/v/<id>/ when a variant is passed.
 * 16×12 at 23 km unless the caller says otherwise.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTdFolder } from "./td-geotiff.mjs";
import { projectBakeDir } from "./td-overlays.mjs";
import { resolveRun } from "./project-run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));
const Tectonics = require(join(here, "..", "src", "tectonics.js"));
const EarthFixture = require(join(here, "..", "src", "earth-fixture.js"));
const Planet = require(join(here, "..", "src", "planet.js"));
const Projects = require(join(here, "..", "src", "projects"));
const Render = require(join(here, "..", "src", "software-render.js"));

const TD_TEMP_SCALE = 40;
const TD_TEMP_OFFSET = -15;
const TD_PRECIP_MIN = 60;
const TD_PRECIP_RANGE = 3400;
const TD_PRECIP_POWER = 1.55;
const TD_EARTH_KM = 40075.017;
const PI = Math.PI;
const {elevationToMeters, clamp01} = Tectonics;

export const PREVIEW_CROP_W = 16;
export const PREVIEW_CROP_H = 12;

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

export function fieldsToTdLayers(fields, w, h, latAtRow) {
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

function wrapLon(lon) {
  let l = lon;
  while (l < -180) l += 360;
  while (l >= 180) l -= 360;
  return l;
}

function lonLatToPixel(lon, lat, width, height, lon0) {
  const l = wrapLon(lon - lon0);
  return {
    x: (l + 180) / 360 * width,
    y: (90 - lat) / 180 * height,
  };
}

function boxAround(name, lon, lat, cellsW, cellsH, scaleKm) {
  const kmPerDeg = TD_EARTH_KM / 360;
  const latSpan = cellsH * scaleKm / kmPerDeg;
  const lonSpan = cellsW * scaleKm / (kmPerDeg * Math.max(0.2, Math.cos(lat * PI / 180)));
  return {
    name,
    west: lon - lonSpan / 2,
    south: lat - latSpan / 2,
    east: lon + lonSpan / 2,
    north: lat + latSpan / 2,
  };
}

export function earthCrops(scaleKm) {
  return [
    Object.assign(boxAround("andes", -76.2, -34.4, 16, 12, scaleKm), {cropW: 16, cropH: 12}),
    Object.assign(boxAround("japan", 140.9, 35.6, 16, 12, scaleKm), {cropW: 16, cropH: 12}),
    Object.assign(boxAround("islands", 126.5, -2.5, 24, 16, scaleKm), {cropW: 24, cropH: 16}),
  ];
}

function namedPick(box, width, height, lon0) {
  const cellsW = box.cropW || PREVIEW_CROP_W;
  const cellsH = box.cropH || PREVIEW_CROP_H;
  const nw = lonLatToPixel(box.west, box.north, width, height, lon0);
  const se = lonLatToPixel(box.east, box.south, width, height, lon0);
  return {
    name: box.name,
    x: Math.round(nw.x),
    y: Math.round(nw.y),
    winW: Math.max(1, Math.round(se.x - nw.x)),
    winH: Math.max(1, Math.round(se.y - nw.y)),
    cropW: cellsW,
    cropH: cellsH,
    landFrac: 0,
    west: box.west - lon0,
    south: box.south,
    east: box.east - lon0,
    north: box.north,
  };
}

export async function exportProjectCrops(root, opts = {}) {
  const projectName = opts.project || Projects.DEFAULT;
  const run = await resolveRun(
    root,
    Projects,
    projectName,
    opts.seed,
    opts.variant && Projects.isVariantId(opts.variant) ? opts.variant : null,
  );
  const variant = run.variant;
  const seed = run.seed;
  const lon0 = opts.lon0 || 0;
  const scaleKm = opts.scaleKm || 23;
  const cropW = opts.cropW || PREVIEW_CROP_W;
  const cropH = opts.cropH || PREVIEW_CROP_H;
  const cropCount = opts.crops == null ? 3 : opts.crops | 0;
  const width = opts.width || 720;
  const height = opts.height || 360;
  const namedCrops = opts.namedCrops || [];
  const writeWorld = !!opts.writeWorld;

  const planet = Planet.generatePlanet({
    seed,
    project: projectName,
    values: opts.values != null ? opts.values : run.values,
    connectOceans: !!opts.connectOceans,
  });

  const lon0Rad = lon0 * PI / 180;
  const rawWorld = Planet.rasterizeEquirect(planet.mesh, planet.map, width, height, lon0Rad);
  const world = fieldsToTdLayers(rawWorld, width, height);
  const boxes = namedCrops.length
    ? namedCrops
    : (EarthFixture.isEarthSeed(planet.seed) ? earthCrops(scaleKm) : null);
  const picks = boxes
    ? boxes.map((box) => namedPick({
      ...box,
      cropW: box.cropW || cropW,
      cropH: box.cropH || cropH,
    }, width, height, lon0))
    : pickTdCrops(world, {
      winW: Math.max(8, Math.round(cropW * scaleKm * width / TD_EARTH_KM)),
      winH: Math.max(6, Math.round(cropH * scaleKm * 2 * height / TD_EARTH_KM)),
      count: cropCount,
    });

  const cropRecords = picks.map((pick) => {
    const w = pick.cropW || cropW;
    const h = pick.cropH || cropH;
    const bounds = pick.west != null
      ? {west: pick.west, south: pick.south, east: pick.east, north: pick.north}
      : pixelBounds(pick.x, pick.y, pick.winW, pick.winH, width, height);
    const southRad = bounds.south * PI / 180;
    const northRad = bounds.north * PI / 180;
    const raw = Planet.rasterizeLonLatBox(
      planet.mesh, planet.map,
      bounds.west, bounds.south, bounds.east, bounds.north,
      w, h, lon0Rad,
    );
    const layers = fieldsToTdLayers(raw, w, h, (row) => (
      northRad - (row + 0.5) / h * (northRad - southRad)
    ));
    return {
      name: pick.name,
      cropW: w,
      cropH: h,
      landFrac: pick.landFrac,
      ...bounds,
      layers,
      previewPng: Render.drawCropPreview(layers, pick.name),
    };
  });

  const outDir = projectBakeDir(root, projectName, variant);
  await mkdir(outDir, {recursive: true});

  if (writeWorld) {
    const worldPreviewPng = Render.drawWorldSheet(world, picks, cropRecords.map((c) => c.layers));
    await writeFile(join(outDir, "examples.png"), worldPreviewPng);
    await writeTdFolder(join(outDir, "world"), world, {
      west: -180 + lon0,
      south: -90,
      east: 180 + lon0,
      north: 90,
    });
    await writeFile(join(outDir, "world", "preview.png"), worldPreviewPng);
  }

  const manifest = {
    project: projectName,
    variant,
    seed: planet.seed,
    n: planet.n,
    plates: planet.p,
    scaleKm,
    lon0,
    model: "xandergos/terrain-diffusion-90m",
    snr: "0.2,0.2,1.0,0.2,1.0",
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
    await writeTdFolder(dir, crop.layers, bounds);
    await writeFile(join(dir, "preview.png"), crop.previewPng);
    manifest.crops.push({
      name: crop.name,
      dir: `crop-${crop.name}`,
      project: projectName,
      seed: planet.seed,
      width: crop.cropW,
      height: crop.cropH,
      landFrac: crop.landFrac,
      ...bounds,
      outputPx: [crop.cropW * 256, crop.cropH * 256],
      coverageKm: [crop.cropW * scaleKm, crop.cropH * scaleKm],
    });
  }

  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return {outDir, manifest, planet, crops: manifest.crops};
}
