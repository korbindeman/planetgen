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
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL = "1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const previewDir = join(root, "preview");
const port = 42000 + Math.floor(Math.random() * 1000);
const origin = `http://localhost:${port}`;

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

const server = Bun.spawn(["bun", "--port", String(port), "index.html"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});

let browser;
try {
  await waitForServer(origin);
  browser = await chromium.launch({
    headless: true,
    args: ["--ignore-gpu-blocklist", "--enable-webgl", "--use-gl=angle"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1024 },
    deviceScaleFactor: 1,
  });
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => window.__PLANET_READY__ === true, null, { timeout: 60_000 });
  if (noTectonics) await page.evaluate(() => window.setSimulateTectonics(false));

  const tiles = [];
  for (const seed of seeds) {
    await page.evaluate((s) => window.setSeed(s), seed);
    const dataUrl = await page.evaluate(
      ({ view, overlay }) => window.exportPreview(view, { overlay }),
      { view, overlay },
    );
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
      throw new Error(`exportPreview failed for seed ${seed}`);
    }
    tiles.push({ seed, dataUrl });
    console.log(`seed ${seed}`);
  }

  const sheetUrl = await page.evaluate(drawSheet, { tiles, view });
  await mkdir(previewDir, { recursive: true });
  const out = join(previewDir, "seed-sheet.png");
  await Bun.write(out, Buffer.from(sheetUrl.split(",")[1], "base64"));
  console.log(out);
} finally {
  await browser?.close();
  server.kill();
}

function drawSheet({ tiles, view }) {
  const load = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("failed to load tile"));
      img.src = src;
    });
  return Promise.all(tiles.map((t) => load(t.dataUrl))).then((images) => {
    const tileW = view === "globe" ? 420 : 640;
    const aspect = images[0].height / images[0].width;
    const tileH = Math.round(tileW * aspect);
    const labelH = 24;
    const cols = Math.min(3, images.length);
    const rows = Math.ceil(images.length / cols);
    const canvas = document.createElement("canvas");
    canvas.width = cols * tileW;
    canvas.height = rows * (tileH + labelH);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textBaseline = "middle";
    ctx.font = "600 15px ui-sans-serif, system-ui, sans-serif";
    images.forEach((img, i) => {
      const x = (i % cols) * tileW;
      const y = Math.floor(i / cols) * (tileH + labelH);
      ctx.fillStyle = "#111111";
      ctx.fillText(`seed ${tiles[i].seed}`, x + 8, y + labelH / 2);
      ctx.drawImage(img, x, y + labelH, tileW, tileH);
    });
    return canvas.toDataURL("image/png");
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error(`preview server exited ${server.exitCode}`);
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
