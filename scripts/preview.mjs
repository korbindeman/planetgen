#!/usr/bin/env bun
/**
 * Render the planet to preview/planet.png so agents can Read the image.
 * Uses Playwright's headless Chromium — never the desktop Chrome app.
 *
 * Usage: bun run preview
 */
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL = "1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "preview", "planet.png");
const port = 41000 + Math.floor(Math.random() * 1000);
const origin = `http://localhost:${port}`;

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
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => window.__PLANET_READY__ === true, null, {
    timeout: 60_000,
  });
  const dataUrl = await page.evaluate(() => window.exportPlanetPreview());
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
    throw new Error("exportPlanetPreview did not return a PNG");
  }
  await mkdir(dirname(outPath), { recursive: true });
  await Bun.write(outPath, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(outPath);
} finally {
  await browser?.close();
  server.kill();
}

async function ensureChromium() {
  if (await bunFileExists(chromium.executablePath())) return;
  const install = Bun.spawnSync(
    ["bunx", "playwright-core", "install", "chromium"],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (install.exitCode !== 0) {
    throw new Error("failed to install headless Chromium");
  }
}

async function bunFileExists(path) {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
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
