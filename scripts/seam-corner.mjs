/**
 * Mosaic the tiles around one cube corner, painted the way the *studio*
 * paints them, so a fold seam can be looked at without a browser.
 *
 * This is deliberately paintTdSurface and not paintCropTerrain: the overlay
 * on the globe colours the float DEM live against this planet's climate, and
 * output.png is only the fallback. Reproducing the wrong one of those two is
 * how a seam gets diagnosed against a bug the app does not have.
 *
 * `--old` paints the way the overlay did before src/td-shade.js: hillshade
 * in the tile's own texel axes, and the climate read nearest-neighbour off
 * an unpadded grid. That is the before of the before/after pair.
 *
 * `--relief` uses the Relief look, where colour is elevation alone. Worth its
 * own flag: the surface look mixes in climate, so a seam that survives into
 * Relief is elevation or light and nothing else.
 *
 *   bun run seam <variant-dir> <tile> [<tile>...] [--old] [--relief]
 *   bun run seam preview/thalos/v/v1788473173180 f1l4x15y0 f2l4x0y0 f5l4x15y0
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolveRun } from "./project-run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(join(root, "package.json"));
const Cube = require(join(root, "src", "cubesphere.js"));
const Look = require(join(root, "src", "look.js"));
const Planet = require(join(root, "src", "planet.js"));
const Projects = require(join(root, "src", "projects"));
const Shade = require(join(root, "src", "td-shade.js"));
const TdTile = require(join(root, "src", "td-tile.js"));
const Tectonics = require(join(root, "src", "tectonics.js"));
const { encodePng } = require(join(root, "src", "png.js"));

/* Same grid and pad paintTdSurface asks tdClimateUnder for. */
const CLIMATE_CELLS = 32;
const CLIMATE_PAD = 1;

/* The shading this replaced: gradients in the tile's own texel axes. */
function rasterAxesShade(e, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = y === 0 ? y : y - 1;
    const y1 = y === h - 1 ? y : y + 1;
    for (let x = 0; x < w; x++) {
      const x0 = x === 0 ? x : x - 1;
      const x1 = x === w - 1 ? x : x + 1;
      out[y * w + x] = Look.hillshade(
        (e[y * w + x1] - e[y * w + x0]) / (x1 - x0),
        (e[y1 * w + x] - e[y0 * w + x]) / (y1 - y0),
      );
    }
  }
  return out;
}

/* The climate read this replaced: nearest cell of an unpadded grid. */
function nearest(field, n, fx, fy) {
  const gx = Math.min(n - 1, Math.floor(fx * n));
  const gy = Math.min(n - 1, Math.floor(fy * n));
  return field[gy * n + gx];
}

async function loadTile(dir, name) {
  const d = join(dir, `crop-${name}`);
  const meta = JSON.parse(await readFile(join(d, "output.elev.json"), "utf8"));
  const w = meta.width | 0, h = meta.height | 0;
  const raw = await readFile(join(d, "output.elev"));
  const elevM = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + w * h * 4));
  const info = JSON.parse(await readFile(join(d, "tile.json"), "utf8"));
  return {
    name, width: w, height: h, elevM,
    tile: {face: info.face, level: info.level, i: info.i, j: info.j},
    seed: info.seed, variant: info.variant, project: info.project,
  };
}

function paint(t, planet, old, relief) {
  const w = t.width, h = t.height;
  const e = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) e[i] = Tectonics.metersToElevation(t.elevM[i]);
  const shade = old ? rasterAxesShade(e, w, h) : Shade.cropShade(e, w, h, {tile: t.tile});
  const pad = old ? 0 : CLIMATE_PAD;
  const c = Planet.rasterizeCubeTile(
    planet.mesh, planet.map, t.tile, CLIMATE_CELLS, CLIMATE_CELLS, 0, pad,
  );
  const n = CLIMATE_CELLS + 2 * pad;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const fx = (x + 0.5) / w, fy = (y + 0.5) / h;
      let a;
      if (relief) {
        a = Look.reliefAlbedo(e[i]);
      } else {
        const moist = old ? nearest(c.moist, n, fx, fy) : TdTile.samplePadded(c.moist, n, n, fx, fy, pad);
        const temp = old ? nearest(c.temp, n, fx, fy) : TdTile.samplePadded(c.temp, n, n, fx, fy, pad);
        a = Look.surfaceAlbedo(e[i], moist, temp);
      }
      for (let k = 0; k < 3; k++) {
        rgb[i * 3 + k] = Math.max(0, Math.min(255, Math.round(a[k] * shade[i] * 255)));
      }
    }
  }
  return Object.assign({}, t, {rgb});
}

function sampleRgb(t, dir, out) {
  const ll = Cube.xyzToLonLat(dir);
  const px = Cube.tilePixel(t.tile, ll.lon, ll.lat, t.width, t.height);
  if (!px || px.x < 0 || px.x > t.width || px.y < 0 || px.y > t.height) return false;
  const x = Math.max(0, Math.min(t.width - 1, Math.floor(px.x)));
  const y = Math.max(0, Math.min(t.height - 1, Math.floor(px.y)));
  const i = (y * t.width + x) * 3;
  out[0] = t.rgb[i];
  out[1] = t.rgb[i + 1];
  out[2] = t.rgb[i + 2];
  return true;
}

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/*
 * Look straight down at the middle of the tiles, orthographic. A window in
 * one tile's own face space would show its neighbours through that face's
 * projection, which stretches them off toward the corner and hides the join
 * in the distortion — the globe does not do that, so neither does this.
 */
function camera(tiles) {
  let c = [0, 0, 0];
  for (const t of tiles) {
    const d = Cube.tileDirection(t.tile, 0.5, 0.5);
    c = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
  }
  const fwd = unit(c);
  const up = Math.abs(fwd[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const right = unit(cross(up, fwd));
  return {fwd, right, up: cross(fwd, right)};
}

function halfSpan(tiles, cam) {
  let m = 0;
  for (const t of tiles) {
    for (const [s, u] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const d = Cube.tileDirection(t.tile, s, u);
      m = Math.max(m, Math.abs(d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2]));
      m = Math.max(m, Math.abs(d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2]));
    }
  }
  return m * 1.12;
}

async function main() {
  const old = process.argv.includes("--old");
  const relief = process.argv.includes("--relief");
  const args = process.argv.slice(2).filter((a) => a !== "--old" && a !== "--relief");
  const dir = args[0];
  const names = args.slice(1);
  if (!dir || !names.length) {
    console.error("usage: bun run seam <variant-dir> <tile>... [--old]");
    return 2;
  }
  const loaded = [];
  for (const n of names) loaded.push(await loadTile(dir, n));

  const run = await resolveRun(root, Projects, loaded[0].project, undefined, loaded[0].variant);
  if (String(run.seed) !== String(loaded[0].seed)) {
    console.error(`variant ${loaded[0].variant} resolves to seed ${run.seed},`
        + ` crops were baked at ${loaded[0].seed} — the climate would not be theirs`);
    return 1;
  }
  const planet = Planet.generatePlanet({
    seed: run.seed, project: run.project, values: run.values,
    simulateTectonics: true, polarStraits: true, detailPass: true,
  });
  const tiles = loaded.map((t) => paint(t, planet, old, relief));

  const W = 1400, H = 1400;
  const cam = camera(tiles);
  const span = halfSpan(tiles, cam);
  const px = Buffer.alloc(W * H * 4);
  const out = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const v = span * (1 - 2 * (y + 0.5) / H);
    for (let x = 0; x < W; x++) {
      const u = span * (2 * (x + 0.5) / W - 1);
      const zz = 1 - u * u - v * v;
      const i = (y * W + x) * 4;
      px[i + 3] = 255;
      if (zz <= 0) { px[i] = 18; px[i + 1] = 18; px[i + 2] = 26; continue; }
      const w = Math.sqrt(zz);
      const dir = [
        cam.right[0] * u + cam.up[0] * v + cam.fwd[0] * w,
        cam.right[1] * u + cam.up[1] * v + cam.fwd[1] * w,
        cam.right[2] * u + cam.up[2] * v + cam.fwd[2] * w,
      ];
      let hit = false;
      for (const t of tiles) if (sampleRgb(t, dir, out)) { hit = true; break; }
      px[i] = hit ? out[0] : 18;
      px[i + 1] = hit ? out[1] : 18;
      px[i + 2] = hit ? out[2] : 26;
    }
  }
  const tag = relief ? "-relief" : "";
  const dst = join(dir, old ? `seam-corner${tag}-before.png` : `seam-corner${tag}.png`);
  await writeFile(dst, encodePng(px, W, H));
  console.log(dst);
  return 0;
}

process.exit(await main());
