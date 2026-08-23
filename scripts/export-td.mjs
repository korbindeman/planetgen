#!/usr/bin/env bun
/**
 * Export a project's terrain-diffusion conditioning GeoTIFFs.
 *
 * Usage:
 *   bun run export:td
 *   bun run export:td --seed=88 --scale=23
 *   bun run export:td --lon=90 --crops=3
 *   bun run export:td --earth
 *   bun run export:td --earth --size=16x12
 *   bun run export:td --earth --crop=norway:4,58,16,70
 *
 * Writes preview/<name>/:
 *   examples.png              world sketch + crop windows
 *   world/*.tif               full equirect (inspection only)
 *   crop-<name>/*.tif         regional tiles for `tiff-export`
 *
 * Do not tiff-export the whole world raster.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportProjectCrops, PREVIEW_CROP_H, PREVIEW_CROP_W } from "./export-project.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));

const {outDir, manifest} = await exportProjectCrops(root, {
  ...args,
  writeWorld: true,
});

for (const crop of manifest.crops) {
  console.log(join(outDir, crop.dir, "heightmap.tif"));
}
console.log(join(outDir, "examples.png"));
console.log(
  `project ${manifest.project}  seed ${manifest.seed}  scale ${manifest.scaleKm} km/px  ` +
    `crops ${manifest.crops.map((c) => `${c.name} ${c.width}x${c.height}`).join(", ")}`,
);

function parseCrop(spec) {
  const m = String(spec).match(
    /^([a-z0-9-]+):(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/i,
  );
  if (!m) {
    throw new Error(`crop needs name:west,south,east,north (got ${spec})`);
  }
  const west = Number(m[2]), south = Number(m[3]), east = Number(m[4]), north = Number(m[5]);
  if (east <= west || north <= south) {
    throw new Error(`crop ${m[1]} needs east > west and north > south`);
  }
  return {name: m[1], west, south, east, north};
}

function parseSize(spec) {
  const m = String(spec).match(/^(\d+)x(\d+)$/i);
  if (!m) throw new Error(`size needs WxH (got ${spec})`);
  return {cropW: Number(m[1]) | 0, cropH: Number(m[2]) | 0};
}

function parseSeed(raw) {
  if (String(raw).trim().toLowerCase() === "earth") return "earth";
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`seed needs a number or "earth" (got ${raw})`);
  return n | 0;
}

function parseArgs(argv) {
  let seed;
  let project;
  let lon0 = 0;
  let scaleKm = 23;
  let crops = 3;
  let connectOceans = false;
  let width = 720;
  let height = 360;
  let cropW = PREVIEW_CROP_W;
  let cropH = PREVIEW_CROP_H;
  const namedCrops = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const nextVal = (name) => {
      const next = argv[++i];
      if (next == null) throw new Error(`${name} needs a value`);
      return next;
    };
    const nextNum = (name) => {
      const n = Number(nextVal(name));
      if (Number.isNaN(n)) throw new Error(`${name} needs a number`);
      return n;
    };
    if (arg === "--earth") { seed = "earth"; project = "earth"; }
    else if (arg === "--project") project = nextVal(arg);
    else if (arg.startsWith("--project=")) project = arg.slice(10);
    else if (arg === "--seed") seed = parseSeed(nextVal(arg));
    else if (arg.startsWith("--seed=")) seed = parseSeed(arg.slice(7));
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
    else if (arg === "--size") {
      ({cropW, cropH} = parseSize(nextVal(arg)));
    } else if (arg.startsWith("--size=")) {
      ({cropW, cropH} = parseSize(arg.slice(7)));
    } else if (arg === "--crop") namedCrops.push(parseCrop(nextVal(arg)));
    else if (arg.startsWith("--crop=")) namedCrops.push(parseCrop(arg.slice(7)));
    else if (arg === "--connect-oceans") connectOceans = true;
    else {
      throw new Error(
        `unknown export-td arg: ${arg}\n` +
          "usage: bun run export:td [--seed=n] [--project=thalos|earth] [--earth] [--lon=deg] [--scale=km] [--size=WxH] [--crop=name:w,s,e,n] [--crops=n]",
      );
    }
  }
  if (seed === "earth" && !project) project = "earth";
  return {seed, project, lon0, scaleKm, crops, connectOceans, width, height, cropW, cropH, namedCrops};
}
