#!/usr/bin/env bun
/**
 * Crop a preview PNG so a local feature can be judged at a useful size.
 *
 *   bun run crop preview/equirect.png --x=800 --y=200 --w=600 --h=400
 *   bun run crop preview/compare.png --x=100 --y=80 --w=500 --h=500
 *   bun run crop preview/equirect.png --x=800 --y=200 --w=600 --h=400 --out=preview/crop-coast.png
 *
 * Writes preview/crop.png unless --out is set. Coordinates are pixels from
 * the top-left of the source image.
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const { decodePng, encodePng } = require(join(root, "src", "png.js"));

const { src, x, y, w, h, out } = parseArgs(process.argv.slice(2));
const buf = Buffer.from(await Bun.file(src).arrayBuffer());
const img = decodePng(buf);
const left = clamp(x, 0, img.width - 1);
const top = clamp(y, 0, img.height - 1);
const width = clamp(w, 1, img.width - left);
const height = clamp(h, 1, img.height - top);
const rgba = Buffer.alloc(width * height * 4);
for (let row = 0; row < height; row++) {
  const srcOff = ((top + row) * img.width + left) * 4;
  img.rgba.copy(rgba, row * width * 4, srcOff, srcOff + width * 4);
}
await Bun.write(out, encodePng(rgba, width, height));
console.log(out);
console.log(`${width}x${height} from ${img.width}x${img.height} at ${left},${top}`);

function parseArgs(argv) {
  let src;
  let x = 0, y = 0, w, h;
  let out = join(root, "preview", "crop.png");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--x") x = nextNum(argv, ++i, arg);
    else if (arg.startsWith("--x=")) x = Number(arg.slice(4));
    else if (arg === "--y") y = nextNum(argv, ++i, arg);
    else if (arg.startsWith("--y=")) y = Number(arg.slice(4));
    else if (arg === "--w" || arg === "--width") w = nextNum(argv, ++i, arg);
    else if (arg.startsWith("--w=")) w = Number(arg.slice(4));
    else if (arg.startsWith("--width=")) w = Number(arg.slice(8));
    else if (arg === "--h" || arg === "--height") h = nextNum(argv, ++i, arg);
    else if (arg.startsWith("--h=")) h = Number(arg.slice(4));
    else if (arg.startsWith("--height=")) h = Number(arg.slice(9));
    else if (arg === "--out") out = resolveArg(argv[++i], arg);
    else if (arg.startsWith("--out=")) out = resolve(arg.slice(6));
    else if (arg.startsWith("-")) {
      throw new Error(
        `unknown crop arg: ${arg}\n` +
          "usage: bun run crop <png> --x=n --y=n --w=n --h=n [--out=path]",
      );
    } else if (src) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      src = resolve(arg);
    }
  }
  if (!src) throw new Error("crop needs a PNG path");
  if (w == null || h == null || Number.isNaN(w) || Number.isNaN(h)) {
    throw new Error("crop needs --w and --h (pixels)");
  }
  if ([x, y, w, h].some((n) => Number.isNaN(n))) {
    throw new Error("crop coordinates must be numbers");
  }
  return { src, x: x | 0, y: y | 0, w: w | 0, h: h | 0, out };
}

function nextNum(argv, i, flag) {
  const next = argv[i];
  if (next == null || Number.isNaN(Number(next))) {
    throw new Error(`${flag} needs a number`);
  }
  return Number(next);
}

function resolveArg(value, flag) {
  if (value == null) throw new Error(`${flag} needs a path`);
  return resolve(value);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
