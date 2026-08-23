import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Look = require("./src/look.js");
const {encodePng} = require("./src/png.js");

export const CHANNELS = [
  "heightmap",
  "temperature",
  "temperature_std",
  "precipitation",
  "precipitation_cv",
];

export function encodeFloat32GeoTiff(w, h, data, bounds) {
  if (data.length !== w * h) {
    throw new Error(`tiff data length ${data.length} != ${w * h}`);
  }
  const imageBytes = w * h * 4;
  const sx = (bounds.east - bounds.west) / w;
  const sy = (bounds.north - bounds.south) / h;

  const tags = [];
  const extras = [];
  function addInline(id, type, value) {
    tags.push({id, type, count: 1, value});
  }
  function addExtra(id, type, bytes) {
    tags.push({id, type, count: bytes.length / (type === 12 ? 8 : 2), extra: extras.length});
    extras.push(bytes);
  }

  addInline(256, 4, w);
  addInline(257, 4, h);
  addInline(258, 3, 32);
  addInline(259, 3, 1);
  addInline(262, 3, 1);
  addInline(273, 4, 0);
  addInline(277, 3, 1);
  addInline(278, 4, h);
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
    if (tag.id === 273) buf.writeUInt32LE(imageStart, at + 8);
    else if (tag.extra != null) buf.writeUInt32LE(extraOffsets[tag.extra], at + 8);
    else buf.writeUInt32LE(tag.value, at + 8);
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
  const buf = Buffer.alloc(16 * 2);
  const keys = [
    1, 1, 0, 3,
    1024, 0, 1, 2,
    1025, 0, 1, 1,
    2048, 0, 1, 4326,
  ];
  for (let i = 0; i < keys.length; i++) buf.writeUInt16LE(keys[i], i * 2);
  return buf;
}

export async function writeTdFolder(dir, layers, bounds) {
  await mkdir(dir, {recursive: true});
  for (const name of CHANNELS) {
    const tif = encodeFloat32GeoTiff(layers.width, layers.height, layers[name], bounds);
    await writeFile(join(dir, `${name}.tif`), tif);
  }
}

export function hillshadePng(heightmap, width, height) {
  const shade = Look.hillshadeField(heightmap, width, height);
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b] = Look.elevRgb(heightmap[i]);
    const s = shade[i];
    rgba[i * 4] = Math.round(r * s);
    rgba[i * 4 + 1] = Math.round(g * s);
    rgba[i * 4 + 2] = Math.round(b * s);
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(rgba, width, height);
}

export function b64ToF32(s) {
  const buf = Buffer.from(s, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/* Our own uncompressed float32 GeoTIFFs (the conditioning channels). */
export function readFloat32GeoTiff(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 16 || buf.toString("ascii", 0, 2) !== "II" || buf.readUInt16LE(2) !== 42) {
    return null;
  }
  const ifd = buf.readUInt32LE(4);
  if (ifd + 2 > buf.length) return null;
  const n = buf.readUInt16LE(ifd);
  let w = 0, h = 0, bits = 0, sample = 0, strip = 0;
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12;
    if (o + 12 > buf.length) return null;
    const id = buf.readUInt16LE(o);
    const value = buf.readUInt32LE(o + 8);
    if (id === 256) w = value;
    else if (id === 257) h = value;
    else if (id === 258) bits = value;
    else if (id === 339) sample = value;
    else if (id === 273) strip = value;
  }
  if (!w || !h || bits !== 32 || sample !== 3 || !strip) return null;
  const bytes = w * h * 4;
  if (strip + bytes > buf.length) return null;
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = buf.readFloatLE(strip + i * 4);
  return {width: w, height: h, data};
}
