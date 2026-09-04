#!/usr/bin/env bun
/**
 * Reference reader for a `.planet` package. Standalone on purpose.
 *
 *   bun read-planet.mjs planet.planet --info
 *   bun read-planet.mjs planet.planet --lat=12.3 --lon=-45.6
 *   bun read-planet.mjs planet.planet --lat=12.3 --lon=-45.6 --lod=4
 *   bun read-planet.mjs planet.planet --selftest
 *
 * This imports nothing from planetgen and depends on nothing but `node:zlib`,
 * so it can be copied next to the package and run anywhere. It exists to be
 * read and ported: the format doc (docs/ref/planet-package.md) says what the
 * bytes mean, and this says it again in code you can diff your reader against.
 *
 * Two details cost a day if you get them wrong, so they are called out where
 * they happen: the frame is z-up, and the predictor's rounding must break ties
 * toward +infinity, which is not what `round()` does in most languages.
 */
import { readFileSync, openSync, readSync, closeSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const QUARTER = Math.PI / 4;

/* Face basis: normal, then the two tangents. Same table as the writer. */
const FACES = [
  {n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1]},
  {n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1]},
  {n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1]},
  {n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1]},
  {n: [0, 0, 1], u: [0, 1, 0], v: [-1, 0, 0]},
  {n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0]},
];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/*
 * z-up. Latitude maps to z and +z is the north pole. This is not the OpenGL
 * cubemap convention. If your engine is y-up, rotate at the boundary with
 * (x, -z, y); (x, z, y) is a mirror and flips the handedness of the world.
 */
function lonLatToXyz(lonDeg, latDeg) {
  const lon = lonDeg * Math.PI / 180, lat = latDeg * Math.PI / 180;
  const c = Math.cos(lat);
  return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
}

function faceOf(p) {
  const ax = Math.abs(p[0]), ay = Math.abs(p[1]), az = Math.abs(p[2]);
  if (ax >= ay && ax >= az) return p[0] >= 0 ? 0 : 2;
  if (ay >= az) return p[1] >= 0 ? 1 : 3;
  return p[2] >= 0 ? 4 : 5;
}

/* Inverse of dir = normalize(n + tan(a*PI/4)*u + tan(b*PI/4)*v). */
function faceCoords(face, p) {
  const f = FACES[face];
  const w = dot(p, f.n);
  if (!(w > 1e-9)) return null;
  return {a: Math.atan(dot(p, f.u) / w) / QUARTER, b: Math.atan(dot(p, f.v) / w) / QUARTER};
}

/* Ties toward +infinity. `Math.round` in JS already does this; `round()` in
 * Rust, C and C++ does not — it breaks ties away from zero, so round(-2.5) is
 * -3 there and -2 here. Prediction is closed-loop, so one differing tie at a
 * coarse lod propagates into every descendant. */
const roundHalfUp = (v) => Math.floor(v + 0.5);

export function openPlanet(path) {
  const fd = openSync(path, "r");
  const head = Buffer.alloc(32);
  readSync(fd, head, 0, 32, 0);
  if (head.toString("ascii", 0, 8) !== "PLANETPK") throw new Error("not a .planet file");
  const version = head.readUInt32LE(8);
  const manifestLen = head.readUInt32LE(12);
  const nodeCount = head.readUInt32LE(16);
  const recordLen = head.readUInt32LE(20);
  const blobBase = Number(head.readBigUInt64LE(24));

  const front = Buffer.alloc(manifestLen + nodeCount * recordLen);
  readSync(fd, front, 0, front.length, 32);
  const manifest = JSON.parse(front.toString("utf8", 0, manifestLen));

  const index = new Map();
  for (let k = 0; k < nodeCount; k++) {
    const o = manifestLen + k * recordLen;
    const face = front.readUInt8(o);
    const lodByte = front.readUInt8(o + 1);
    const lod = lodByte & 0x7f;
    index.set(`${face}/${lod}/${front.readUInt32LE(o + 4)}/${front.readUInt32LE(o + 8)}`, {
      residual: (lodByte & 0x80) !== 0,
      predictorErrorM: front.readUInt16LE(o + 2),
      offset: blobBase + Number(front.readBigUInt64LE(o + 12)),
      length: front.readUInt32LE(o + 20),
    });
  }
  return {fd, version, manifest, index, close: () => closeSync(fd)};
}

function rawNode(planet, entry) {
  const buf = Buffer.alloc(entry.length);
  readSync(planet.fd, buf, 0, entry.length, entry.offset);
  const out = zstdDecompressSync(buf);
  const stride = planet.manifest.node_stride;
  if (out.length !== stride * stride * 2) {
    throw new Error(`node payload is ${out.length} bytes, expected ${stride * stride * 2}`);
  }
  return new Int16Array(out.buffer, out.byteOffset, stride * stride);
}

/* Bilinear upsample of the parent's quadrant, over the stored array including
 * its skirt. Must match the writer exactly or residuals drift. */
function predict(planet, parent, qx, qy) {
  const {node_resolution: R, node_stride: stride} = planet.manifest;
  const out = new Int16Array(stride * stride);
  const half = R / 2;
  const P = (x, y) => parent[
    Math.min(R + 1, Math.max(0, y + 1)) * stride + Math.min(R + 1, Math.max(0, x + 1))
  ];
  for (let py = -1; py <= R; py++) {
    for (let px = -1; px <= R; px++) {
      const fx = qx * half + (px + 0.5) / 2 - 0.5;
      const fy = qy * half + (py + 0.5) / 2 - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      out[(py + 1) * stride + (px + 1)] = roundHalfUp(
        P(x0, y0) * (1 - tx) * (1 - ty) + P(x0 + 1, y0) * tx * (1 - ty)
        + P(x0, y0 + 1) * (1 - tx) * ty + P(x0 + 1, y0 + 1) * tx * ty,
      );
    }
  }
  return out;
}

const cache = new Map();
export function reconstruct(planet, face, lod, x, y) {
  const key = `${face}/${lod}/${x}/${y}`;
  if (cache.has(key)) return cache.get(key);
  const entry = planet.index.get(key);
  if (!entry) return null;
  let data = rawNode(planet, entry);
  if (entry.residual) {
    const parent = reconstruct(planet, face, lod - 1, x >> 1, y >> 1);
    if (!parent) throw new Error(`node ${key} is a residual with no parent`);
    const predicted = predict(planet, parent, x & 1, y & 1);
    const out = new Int16Array(data.length);
    for (let k = 0; k < out.length; k++) out[k] = predicted[k] + data[k];
    data = out;
  }
  if (cache.size > 512) cache.clear();
  cache.set(key, data);
  return data;
}

/*
 * Height in metres at a direction, from the finest node present at or above
 * `maxLod`. Absence means the parent is already within budget, so walking
 * down and stopping at the first miss is the whole LOD rule.
 */
export function sampleHeight(planet, lonDeg, latDeg, maxLod = planet.manifest.leaf_lod) {
  const {node_resolution: R, node_stride: stride} = planet.manifest;
  const dir = lonLatToXyz(lonDeg, latDeg);
  const face = faceOf(dir);
  const fc = faceCoords(face, dir);
  if (!fc) return null;
  let best = null;
  for (let lod = 0; lod <= maxLod; lod++) {
    const N = 1 << lod;
    /* a runs west to east with x; b runs south to north, and y counts down
     * from the north edge, so y is derived from the far side of b. */
    const fx = (fc.a + 1) / 2 * N;
    const fy = (1 - fc.b) / 2 * N;
    const x = Math.min(N - 1, Math.max(0, Math.floor(fx)));
    const y = Math.min(N - 1, Math.max(0, Math.floor(fy)));
    const node = reconstruct(planet, face, lod, x, y);
    if (!node) break;
    const px = Math.min(R - 1, Math.max(0, Math.floor((fx - x) * R)));
    const py = Math.min(R - 1, Math.max(0, Math.floor((fy - y) * R)));
    best = {lod, x, y, px, py, metres: node[(py + 1) * stride + (px + 1)]};
  }
  return best;
}

/* -------------------------------------------------------------------- cli */

if (import.meta.main) {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("usage: bun read-planet.mjs <file.planet> [--info] [--lat=N --lon=N] [--lod=N] [--selftest]");
    process.exit(2);
  }
  const opt = (name, dflt) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.slice(name.length + 3)) : dflt;
  };
  const planet = openPlanet(path);
  const m = planet.manifest;

  if (args.includes("--info") || args.length === 1) {
    console.log(`${m.body} / ${m.variant}  seed ${m.seed}  radius ${(m.radius_m / 1000).toFixed(0)} km`);
    console.log(`format v${planet.version}  content key ${m.content_key}`);
    console.log(`${planet.index.size} nodes, lod 0..${m.leaf_lod}, dense to ${m.dense_lod}`);
    console.log(`node ${m.node_resolution} + ${m.node_skirt} skirt = ${m.node_stride} stride`);
    const edgeM = Math.PI / 2 * m.radius_m;
    console.log(`finest ground sample ~${(edgeM / ((1 << m.leaf_lod) * m.node_resolution)).toFixed(0)} m`);
  }

  if (args.some((a) => a.startsWith("--lat="))) {
    const lat = opt("lat", 0), lon = opt("lon", 0), lod = opt("lod", m.leaf_lod);
    const hit = sampleHeight(planet, lon, lat, lod);
    if (!hit) console.log("no node covers that direction");
    else {
      console.log(`lat ${lat} lon ${lon}: ${hit.metres} m`
        + `  (lod ${hit.lod}, node ${hit.x},${hit.y}, texel ${hit.px},${hit.py})`);
    }
  }

  /*
   * Walk every node, decode it, and hold the file to the invariants the doc
   * states. A port that passes --info but fails here has a real bug.
   */
  if (args.includes("--selftest")) {
    let decoded = 0, orphans = 0, badLen = 0, missing = 0;
    for (const [key, entry] of planet.index) {
      const [face, lod, x, y] = key.split("/").map(Number);
      try { rawNode(planet, entry); decoded++; } catch { badLen++; }
      if (lod > 0 && !planet.index.has(`${face}/${lod - 1}/${x >> 1}/${y >> 1}`)) orphans++;
      if (entry.residual !== (lod > m.dense_lod)) badLen++;
    }
    for (let lod = 0; lod <= m.dense_lod; lod++) {
      const N = 1 << lod;
      for (let face = 0; face < 6; face++)
        for (let y = 0; y < N; y++)
          for (let x = 0; x < N; x++)
            if (!planet.index.has(`${face}/${lod}/${x}/${y}`)) missing++;
    }
    console.log(`\nselftest: ${decoded} nodes decoded, ${badLen} malformed,`
      + ` ${orphans} orphaned, ${missing} missing from the dense base`);
    console.log(badLen || orphans || missing ? "FAILED" : "ok");
    if (badLen || orphans || missing) process.exitCode = 1;
  }
  planet.close();
}
