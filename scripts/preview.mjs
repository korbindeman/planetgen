#!/usr/bin/env bun
/**
 * Capture planet views to preview/*.png so agents can Read the images.
 *
 * Usage:
 *   bun run preview                 globe 2x2 + equirect
 *   bun run preview globe
 *   bun run preview equirect
 *   bun run preview equirect --lon=90
 *   bun run preview --seed=42
 *
 * Each view keeps preview/<name>.png, <name>-before.png, <name>-compare.png
 * (globe files are planet.png / compare.png), plus preview/history/.
 */
import { chromium } from "playwright-core";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL = "1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const previewDir = join(root, "preview");
const historyDir = join(previewDir, "history");
const port = 41000 + Math.floor(Math.random() * 1000);
const origin = `http://localhost:${port}`;

const VIEWS = {
  globe: {
    file: "planet.png",
    before: "planet-before.png",
    compare: "compare.png",
    historyPrefix: "planet",
  },
  equirect: {
    file: "equirect.png",
    before: "equirect-before.png",
    compare: "equirect-compare.png",
    historyPrefix: "equirect",
  },
};

const { views, lon0, seed } = parseArgs(process.argv.slice(2));

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

  await mkdir(historyDir, { recursive: true });
  const stamp = timestamp();

  for (const view of views) {
    const spec = VIEWS[view];
    const dataUrl = await page.evaluate(
      ({ view, lon0 }) => window.exportPreview(view, { lon0 }),
      { view, lon0 },
    );
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
      throw new Error(`exportPreview(${view}) did not return a PNG`);
    }
    const png = Buffer.from(dataUrl.split(",")[1], "base64");
    const outPath = join(previewDir, spec.file);
    const beforePath = join(previewDir, spec.before);
    const comparePath = join(previewDir, spec.compare);

    const hadPrevious = await bunFileExists(outPath);
    if (hadPrevious) {
      await copyFile(outPath, beforePath);
      const archived = (await readdir(historyDir)).some(
        (name) => name.startsWith(`${spec.historyPrefix}-`) && name.endsWith(".png"),
      );
      if (!archived) {
        await copyFile(beforePath, join(historyDir, `${spec.historyPrefix}-${stamp}-before.png`));
      }
    }
    await Bun.write(outPath, png);
    await Bun.write(join(historyDir, `${spec.historyPrefix}-${stamp}.png`), png);

    if (hadPrevious) {
      const beforeUrl = `data:image/png;base64,${Buffer.from(await Bun.file(beforePath).arrayBuffer()).toString("base64")}`;
      const compareUrl = await page.evaluate(drawCompare, {
        beforeUrl,
        afterUrl: dataUrl,
      });
      if (typeof compareUrl !== "string" || !compareUrl.startsWith("data:image/png")) {
        throw new Error(`${view} compare sheet did not return a PNG`);
      }
      await Bun.write(comparePath, Buffer.from(compareUrl.split(",")[1], "base64"));
      console.log(comparePath);
    }
      console.log(outPath);
    }
    if (seed != null) console.log(`seed ${seed}`);
} finally {
  await browser?.close();
  server.kill();
}

function parseArgs(argv) {
  const views = [];
  let lon0 = 0;
  let seed;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "all") {
      views.push("globe", "equirect");
    } else if (arg === "globe" || arg === "equirect") {
      views.push(arg);
    } else if (arg === "--lon" || arg === "--lon0") {
      const next = argv[++i];
      if (next == null || Number.isNaN(Number(next))) {
        throw new Error(`${arg} needs a number (degrees)`);
      }
      lon0 = Number(next);
    } else if (arg.startsWith("--lon=") || arg.startsWith("--lon0=")) {
      lon0 = Number(arg.slice(arg.indexOf("=") + 1));
      if (Number.isNaN(lon0)) throw new Error(`invalid ${arg}`);
    } else if (arg === "--seed") {
      const next = argv[++i];
      if (next == null || Number.isNaN(Number(next))) {
        throw new Error(`${arg} needs a number`);
      }
      seed = Number(next) | 0;
    } else if (arg.startsWith("--seed=")) {
      seed = Number(arg.slice("--seed=".length)) | 0;
      if (Number.isNaN(Number(arg.slice("--seed=".length)))) {
        throw new Error(`invalid ${arg}`);
      }
    } else {
      throw new Error(
        `unknown preview arg: ${arg}\n` +
          "usage: bun run preview [globe|equirect|all] [--lon=degrees] [--seed=n]",
      );
    }
  }
  return {
    views: views.length ? [...new Set(views)] : ["globe", "equirect"],
    lon0,
    seed,
  };
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function drawCompare({ beforeUrl, afterUrl }) {
  const load = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("failed to load compare image"));
      img.src = src;
    });
  return Promise.all([load(beforeUrl), load(afterUrl)]).then(([before, after]) => {
    const gap = 24;
    const labelH = 36;
    const canvas = document.createElement("canvas");
    canvas.width = before.width + gap + after.width;
    canvas.height = Math.max(before.height, after.height) + labelH;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111111";
    ctx.font = "600 18px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("Before", 10, labelH / 2);
    ctx.fillText("After", before.width + gap + 10, labelH / 2);
    ctx.drawImage(before, 0, labelH);
    ctx.drawImage(after, before.width + gap, labelH);
    return canvas.toDataURL("image/png");
  });
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
