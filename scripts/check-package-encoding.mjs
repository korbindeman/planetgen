import assert from "node:assert/strict";
import { metres, quantizeHeight, quantizeNode, decodeNode, nodePayload } from "./package-encoding.mjs";

assert.throws(() => metres(NaN), /Non-finite/);
assert.equal(metres(-40000), -32767); assert.equal(metres(40000), 32767);
assert.throws(() => quantizeHeight(Infinity, 64), /Non-finite/);
assert.throws(() => quantizeNode(new Float32Array(1), 0), /band/);

// Sweep through and beyond the band with an irrational step, so heights land
// everywhere between centimetres and on both sides of every rounding tie.
const band = 64;
let samples = 0, worstInside = 0, worstOutside = 0;
for (let h = -70; h <= 70; h += 0.000713) {
  const [m, c] = quantizeHeight(h, band);
  const decoded = (100 * m + c) / 100;
  assert.ok(Number.isInteger(m) && Number.isInteger(c), `${h}`);
  assert.equal(decoded > 0, h > 0, `decoded ${decoded} changes the side of sea level of ${h}`);
  assert.equal(m > 0, h > 0, `metre channel ${m} changes the side of sea level of ${h}`);
  if (Math.abs(h) < band) {
    assert.ok(c >= -99 && c <= 49, `${h}: ${c} cm`);
    worstInside = Math.max(worstInside, Math.abs(decoded - h));
  } else {
    assert.equal(c, 0, `${h} lies outside the band`);
    worstOutside = Math.max(worstOutside, Math.abs(decoded - h));
  }
  samples++;
}
// Rounding contributes half a centimetre; the land floor at +1 cm the rest.
assert.ok(worstInside <= 0.01 + 1e-9, `band error ${worstInside}`);
assert.ok(worstOutside <= 0.5 + 1e-9, `outside error ${worstOutside}`);
assert.deepEqual(quantizeHeight(0.001, band), [1, -99], "land just above sea level stays land");
assert.deepEqual(quantizeHeight(-0.001, band), [0, 0], "sea level itself is water");
assert.deepEqual(quantizeHeight(0, band), [0, 0]);
assert.deepEqual(quantizeHeight(0.3, band), [1, -70]);
assert.deepEqual(quantizeHeight(-0.3, band), [0, -30]);
assert.deepEqual(quantizeHeight(12.345, band), [12, 35]);
assert.deepEqual(quantizeHeight(64.4, band), [64, 0]);

// A node stores centimetres only where they change a height.
const flat = quantizeNode(Float32Array.of(5, -3, 100, -2000), band);
assert.equal(flat.centimetres, null);
assert.equal(nodePayload(flat.metres, flat.centimetres).length, 8);
const coast = quantizeNode(Float32Array.of(0.25, -0.4, 100.3, 7), band);
assert.deepEqual([...coast.metres], [1, 0, 100, 7]);
assert.deepEqual([...coast.centimetres], [-75, -40, 0, 0]);
assert.deepEqual([...decodeNode(coast.metres, coast.centimetres)], [0.25, -0.4, 100, 7]);
const payload = nodePayload(coast.metres, coast.centimetres);
assert.equal(payload.length, 12);
assert.equal(payload.readInt16LE(0), 1); assert.equal(payload.readInt8(8), -75);
console.log(`package encoding: ${samples} heights keep their side of sea level; band error ${worstInside.toFixed(4)} m, outside ${worstOutside.toFixed(3)} m`);
