#!/usr/bin/env bun
/**
 * Capture planet views to preview/*.png so agents can Read the images.
 *
 * Software render — no browser, no Playwright. The same mesh and colormap
 * as the live globe, rasterized on the CPU.
 *
 * Usage:
 *   bun run preview                 globe 2x2 + equirect
 *   bun run preview globe
 *   bun run preview equirect
 *   bun run preview equirect --lon=90
 *   bun run preview --seed=42
 *   bun run preview --earth         present-day Earth fixture (not a numeric seed)
 *   bun run preview plates          globe + equirect with plates and motion arrows
 *   bun run preview plates equirect
 *   bun run preview crust           sea-floor age, orogeny and boundary types
 *   bun run preview climate         the moisture field on its own
 *   bun run preview --no-tectonics  the original 1843 distance-field blend, for comparison
 *   bun run preview --no-polar-straits
 *
 * Each view keeps preview/<name>.png, <name>-before.png, <name>-compare.png
 * (globe files are planet.png / compare.png; plate overlay is plates.png /
 * equirect-plates.png), plus preview/history/.
 */
import { createRequire } from "node:module";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Planet = require(join(root, "planet.js"));
const Render = require(join(root, "software-render.js"));

const previewDir = join(root, "preview");
const historyDir = join(previewDir, "history");

const GEOGRAPHY = {
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

const PLATES = {
  globe: {
    file: "plates.png",
    before: "plates-before.png",
    compare: "plates-compare.png",
    historyPrefix: "plates",
  },
  equirect: {
    file: "equirect-plates.png",
    before: "equirect-plates-before.png",
    compare: "equirect-plates-compare.png",
    historyPrefix: "equirect-plates",
  },
};

const CRUST = {
  globe: {
    file: "crust.png",
    before: "crust-before.png",
    compare: "crust-compare.png",
    historyPrefix: "crust",
  },
  equirect: {
    file: "equirect-crust.png",
    before: "equirect-crust-before.png",
    compare: "equirect-crust-compare.png",
    historyPrefix: "equirect-crust",
  },
};

const CLIMATE = {
  globe: {
    file: "climate.png",
    before: "climate-before.png",
    compare: "climate-compare.png",
    historyPrefix: "climate",
  },
  equirect: {
    file: "equirect-climate.png",
    before: "equirect-climate-before.png",
    compare: "equirect-climate-compare.png",
    historyPrefix: "equirect-climate",
  },
};

const OVERLAY_VIEWS = { plates: PLATES, crust: CRUST, climate: CLIMATE };

const { views, lon0, seed, overlay, connectOceans, noTectonics, noPolarStraits } = parseArgs(process.argv.slice(2));
const VIEWS = OVERLAY_VIEWS[overlay] ?? GEOGRAPHY;

const planet = Planet.generatePlanet({
  seed: seed == null ? 88 : seed,
  simulateTectonics: !noTectonics,
  polarStraits: !noPolarStraits,
  connectOceans,
});

await mkdir(historyDir, { recursive: true });
const stamp = timestamp();

for (const view of views) {
  const spec = VIEWS[view];
  const png = view === "globe"
    ? Render.captureGlobe(planet, { overlay })
    : Render.captureEquirect(planet, { lon0, overlay });
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
    await Bun.write(comparePath, Render.compareSheet(Buffer.from(await Bun.file(beforePath).arrayBuffer()), png));
    console.log(comparePath);
  }
  console.log(outPath);
}
if (overlay) console.log(`${overlay} overlay`);
if (seed != null) console.log(`seed ${seed}`);

function parseArgs(argv) {
  const views = [];
  let lon0 = 0;
  let seed;
  let overlay = null;
  let connectOceans = false;
  let noTectonics = false;
  let noPolarStraits = false;
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
    } else if (arg === "--earth") {
      seed = "earth";
    } else if (arg === "--seed") {
      const next = argv[++i];
      if (next == null) throw new Error(`${arg} needs a value`);
      if (String(next).toLowerCase() === "earth") seed = "earth";
      else if (Number.isNaN(Number(next))) throw new Error(`${arg} needs a number`);
      else seed = Number(next) | 0;
    } else if (arg.startsWith("--seed=")) {
      const raw = arg.slice("--seed=".length);
      if (raw.toLowerCase() === "earth") seed = "earth";
      else {
        seed = Number(raw) | 0;
        if (Number.isNaN(Number(raw))) throw new Error(`invalid ${arg}`);
      }
    } else if (arg === "plates" || arg === "--plates") {
      overlay = "plates";
    } else if (arg === "crust" || arg === "--crust") {
      overlay = "crust";
    } else if (arg === "climate" || arg === "--climate") {
      overlay = "climate";
    } else if (arg === "--connect-oceans") {
      connectOceans = true;
    } else if (arg === "--no-tectonics") {
      noTectonics = true;
    } else if (arg === "--no-polar-straits") {
      noPolarStraits = true;
    } else {
      throw new Error(
        `unknown preview arg: ${arg}\n` +
          "usage: bun run preview [globe|equirect|all|plates|crust|climate] [--lon=degrees] [--seed=n] [--earth] [--connect-oceans] [--no-polar-straits] [--no-tectonics]",
      );
    }
  }
  return {
    views: views.length ? [...new Set(views)] : ["globe", "equirect"],
    lon0,
    seed,
    overlay,
    connectOceans,
    noTectonics,
    noPolarStraits,
  };
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function bunFileExists(path) {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}
