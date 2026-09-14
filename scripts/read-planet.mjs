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
import { readFileSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

import { createHash } from "node:crypto";

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

function readExact(fd, buffer, offset) {
  let done = 0;
  while (done < buffer.length) {
    const n = readSync(fd, buffer, done, buffer.length - done, offset + done);
    if (!n) throw new Error("truncated package read");
    done += n;
  }
}

const caches = new WeakMap();
export function openPlanet(path) {
  const fd = openSync(path, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const head = Buffer.alloc(32); readExact(fd, head, 0);
    if (head.toString("ascii", 0, 8) !== "PLANETPK") throw new Error("not a .planet file");
    const version = head.readUInt32LE(8);
    if (version !== 1) throw new Error(`unsupported package version ${version}`);
    const manifestLen = head.readUInt32LE(12), nodeCount = head.readUInt32LE(16);
    const recordLen = head.readUInt32LE(20), blobBase = Number(head.readBigUInt64LE(24));
    const frontLen = manifestLen + nodeCount * recordLen;
    if (recordLen < 24 || !Number.isSafeInteger(frontLen + 32)
      || !Number.isSafeInteger(blobBase) || 32 + frontLen > blobBase || blobBase > fileSize) {
      throw new Error("package metadata lies outside the file");
    }
    const front = Buffer.alloc(frontLen); readExact(fd, front, 32);
    const manifest = JSON.parse(front.toString("utf8", 0, manifestLen));
    const {node_resolution:R,node_stride:S,node_skirt,leaf_lod,dense_lod,radius_m,max_error_m=0} = manifest;
    if (!Number.isInteger(R) || R <= 0 || R % 2 || node_skirt !== 1 || S !== R + 2 || S * S * 2 > 64 * 1024 * 1024) {
      throw new Error("invalid package node layout");
    }
    if (!Number.isInteger(leaf_lod) || leaf_lod < 0 || leaf_lod > 25 || !Number.isInteger(dense_lod) || dense_lod < 0 || dense_lod > leaf_lod
      || !Number.isFinite(radius_m) || radius_m <= 0 || !Number.isFinite(max_error_m) || max_error_m < 0) {
      throw new Error("invalid package levels, radius or error");
    }
    const index = new Map(), intervals = [];
    let previous = [-1,0,0,0], denseCount = 0;
    for (let k = 0; k < nodeCount; k++) {
      const o = manifestLen + k * recordLen;
      const face = front.readUInt8(o), lodByte = front.readUInt8(o + 1), lod = lodByte & 0x7f;
      const x = front.readUInt32LE(o + 4), y = front.readUInt32LE(o + 8), residual = (lodByte & 0x80) !== 0;
      const key = `${face}/${lod}/${x}/${y}`;
      if (face >= 6 || lod > leaf_lod || x >= 2 ** lod || y >= 2 ** lod) throw new Error(`invalid node address ${key}`);
      const order = face - previous[0] || lod - previous[1] || y - previous[2] || x - previous[3];
      if (order <= 0) throw new Error(`duplicate or unsorted node ${key}`);
      previous = [face,lod,y,x];
      if (lod === 0 && residual) throw new Error(`root cannot be a residual: ${key}`);
      if (lod > 0 && !index.has(`${face}/${lod-1}/${x >> 1}/${y >> 1}`)) throw new Error(`node has no parent: ${key}`);
      const offset = blobBase + Number(front.readBigUInt64LE(o + 12)), length = front.readUInt32LE(o + 20);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(offset + length) || !length || offset < blobBase || offset + length > fileSize) {
        throw new Error(`node blob lies outside the file: ${key}`);
      }
      index.set(key,{residual,predictorErrorM:front.readUInt16LE(o+2),offset,length});
      intervals.push([offset,offset+length]);
      if (lod <= dense_lod) denseCount++;
    }
    let expected = 0; for (let level=0;level<=dense_lod;level++) expected += 6 * 4 ** level;
    if (denseCount !== expected) throw new Error("incomplete dense base");
    intervals.sort((a,b)=>a[0]-b[0]);
    for (let i=1;i<intervals.length;i++) if (intervals[i][0] < intervals[i-1][1]) throw new Error("overlapping node blobs");
    const indexHash = createHash("sha256").update(front.subarray(manifestLen)).digest("hex");
    const planet = {fd,version,manifest,index,blobBase,fileSize,indexHash,close() {
      if (caches.has(planet)) { caches.delete(planet); closeSync(fd); }
    }};
    caches.set(planet,new Map());
    return planet;
  } catch (error) { closeSync(fd); throw error; }
}

function rawNode(planet, entry) {
  const buf = Buffer.alloc(entry.length);
  readExact(planet.fd, buf, entry.offset);
  const stride = planet.manifest.node_stride;
  const out = zstdDecompressSync(buf, {maxOutputLength: stride * stride * 2 + 1});
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

export function reconstruct(planet, face, lod, x, y) {
  const cache = caches.get(planet);
  if (!cache) throw new Error("package is closed");
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

/** Independently read every compressed node before publishing a package.
 * Checks container integrity; source fidelity needs a source comparison too.
 */
export function validatePlanet(path) {
  const planet = openPlanet(path);
  try {
    let nodes = 0;
    for (const [key,entry] of planet.index) {
      rawNode(planet,entry); nodes++;
      const lod = Number(key.split("/")[1]);
      if (entry.residual !== (lod > (planet.manifest.absolute_lod ?? planet.manifest.dense_lod))) {
        throw new Error(`residual flag disagrees with absolute_lod: ${key}`);
      }
    }
    let integrity = "legacy package without content digests";
    const {content_key, ...meta} = planet.manifest;
    if (meta.content_identity !== undefined) {
      if (meta.content_identity !== "sha256-manifest-index-blobs-v1") throw new Error("unsupported content identity");
      if (meta.index_sha256 !== planet.indexHash) throw new Error("index checksum mismatch");
      const hash = createHash("sha256"), chunk = Buffer.alloc(8 * 1024 * 1024);
      for (let offset=planet.blobBase;offset<planet.fileSize;offset+=chunk.length) {
        const part = chunk.subarray(0,Math.min(chunk.length,planet.fileSize-offset));
        readExact(planet.fd,part,offset); hash.update(part);
      }
      if (hash.digest("hex") !== meta.blobs_sha256) throw new Error("blob checksum mismatch");
      const expected = createHash("sha256").update("planet-package-v1\0").update(JSON.stringify(meta)).digest("hex");
      if (expected !== content_key) throw new Error("manifest content identity mismatch");
      integrity = "verified SHA-256 manifest, index and blobs";
    }
    return {nodes,integrity};
  } finally { planet.close(); }
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
    console.log(`${planet.index.size} nodes, lod 0..${m.leaf_lod}, dense to ${m.dense_lod}`
      + `, absolute to ${m.absolute_lod ?? m.dense_lod}`);
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
    const report = validatePlanet(path);
    console.log(`\nselftest: ${report.nodes} nodes decoded; complete base, reachable nodes, checked ranges and payloads`);
    console.log(`integrity: ${report.integrity}`);
    console.log("ok");
  }
  planet.close();
}
