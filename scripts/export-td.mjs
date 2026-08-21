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
import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL = "1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "preview", "terrain-diffusion");
const port = 41000 + Math.floor(Math.random() * 1000);
const origin = `http://localhost:${port}`;

const CHANNELS = [
  "heightmap",
  "temperature",
  "temperature_std",
  "precipitation",
  "precipitation_cv",
];

const { seed, lon0, scaleKm, crops, connectOceans, width, height } = parseArgs(
  process.argv.slice(2),
);

const server = Bun.spawn(["bun", "--port", String(port), "index.html"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});

let browser;
try {
  await waitForServer(origin);
  await ensureChromium();
  browser = await chromium.launch({
    headless: true,
    args: ["--ignore-gpu-blocklist", "--enable-webgl", "--use-gl=angle"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1024 },
    deviceScaleFactor: 1,
  });
  const pageUrl = seed == null ? origin : `${origin}/?seed=${seed}`;
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => window.__PLANET_READY__ === true, null, {
    timeout: 60_000,
  });
  if (connectOceans) {
    await page.evaluate(() => window.setConnectOceans(true));
  }

  const payload = await page.evaluate(
    (opts) => window.exportTerrainDiffusion(opts),
    { lon0, scaleKm, crops, width, height },
  );
  if (!payload?.worldPreviewPng) {
    throw new Error("exportTerrainDiffusion did not return rasters");
  }

  await mkdir(outDir, { recursive: true });
  await writePng(join(outDir, "examples.png"), payload.worldPreviewPng);

  const worldBounds = {
    west: -180 + payload.lon0,
    south: -90,
    east: 180 + payload.lon0,
    north: 90,
  };
  await writeFolder(join(outDir, "world"), payload.world, worldBounds);
  await writePng(join(outDir, "world", "preview.png"), payload.worldPreviewPng);

  const manifest = {
    seed: payload.seed,
    n: payload.n,
    plates: payload.plates,
    scaleKm: payload.scaleKm,
    overviewKm: payload.overviewKm,
    lon0: payload.lon0,
    model: "xandergos/terrain-diffusion-90m",
    snr: "0.2,0.2,1.0,0.2,1.0",
    note:
      "Use crop-* folders with tiff-export. World TIFFs are the planetary sketch, not a single export job.",
    crops: [],
  };

  for (const crop of payload.crops) {
    const dir = join(outDir, `crop-${crop.name}`);
    const bounds = {
      west: crop.west,
      south: crop.south,
      east: crop.east,
      north: crop.north,
    };
    await writeFolder(dir, crop.layers, bounds);
    await writePng(join(dir, "preview.png"), crop.previewPng);
    manifest.crops.push({
      name: crop.name,
      dir: `crop-${crop.name}`,
      width: crop.width,
      height: crop.height,
      landFrac: crop.landFrac,
      ...bounds,
      outputPx: [crop.width * 256, crop.height * 256],
      coverageKm: [crop.width * payload.scaleKm, crop.height * payload.scaleKm],
    });
    console.log(join(dir, "heightmap.tif"));
  }

  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(join(outDir, "examples.png"));
  console.log(`seed ${payload.seed}  scale ${payload.scaleKm} km/px`);
} finally {
  await browser?.close();
  server.kill();
}

async function writeFolder(dir, layers, bounds) {
  await mkdir(dir, { recursive: true });
  for (const name of CHANNELS) {
    const data = b64ToF32(layers[name]);
    const tif = encodeFloat32GeoTiff(
      layers.width,
      layers.height,
      data,
      bounds,
    );
    await writeFile(join(dir, `${name}.tif`), tif);
  }
}

async function writePng(path, dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
    throw new Error(`expected png data URL for ${path}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(dataUrl.split(",")[1], "base64"));
}

function b64ToF32(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function encodeFloat32GeoTiff(width, height, data, bounds) {
  if (data.length !== width * height) {
    throw new Error(`tiff data length ${data.length} != ${width * height}`);
  }
  const imageBytes = width * height * 4;
  const sx = (bounds.east - bounds.west) / width;
  const sy = (bounds.north - bounds.south) / height;

  const tags = [];
  const extras = [];
  function addInline(id, type, value) {
    tags.push({ id, type, count: 1, value });
  }
  function addExtra(id, type, bytes) {
    tags.push({ id, type, count: bytes.length / (type === 12 ? 8 : 2), extra: extras.length });
    extras.push(bytes);
  }

  addInline(256, 4, width);
  addInline(257, 4, height);
  addInline(258, 3, 32);
  addInline(259, 3, 1);
  addInline(262, 3, 1);
  addInline(273, 4, 0);
  addInline(277, 3, 1);
  addInline(278, 4, height);
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
  // 1 directory + 3 keys, each 4 uint16
  const buf = Buffer.alloc(16 * 2);
  const keys = [
    1, 1, 0, 3,
    1024, 0, 1, 2, // GTModelType = Geographic
    1025, 0, 1, 1, // GTRasterType = PixelIsArea
    2048, 0, 1, 4326, // GeographicType = WGS84
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
    else if (arg.startsWith("--width=")) width = Number(arg.slice(8)) | 0;
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

async function ensureChromium() {
  if (await Bun.file(chromium.executablePath()).exists()) return;
  const install = Bun.spawnSync(
    ["bunx", "playwright-core", "install", "chromium"],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (install.exitCode !== 0) {
    throw new Error("failed to install headless Chromium");
  }
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (server.exitCode != null) {
      throw new Error(`preview server exited ${server.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(150);
  }
  throw lastError ?? new Error(`timed out waiting for ${url}`);
}
