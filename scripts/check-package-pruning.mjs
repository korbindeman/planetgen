import assert from "node:assert/strict";
import { canPruneSubtree } from "./package-pruning.mjs";

const R = 4, stride = R + 2;
const fill = (h) => new Float32Array(stride ** 2).fill(h);
function tree() {
  return new Map([1,2,3].map(level => [level,
    new Map(Array.from({length:4 ** (level-1)}, (_, i) => {
      const span = 2 ** (level-1);
      return [`${i % span},${Math.floor(i / span)}`, fill(100)];
    }))]));
}
const test = (levels, extras = {}) => canPruneSubtree({parent:fill(100), resolution:R,
  parentLod:0,parentX:0,parentY:0,lod:1,x:0,y:0,leafLod:3,levels,maxErrorM:12,...extras});

assert.equal(test(tree()), true, "a constant dry subtree is prunable");
{
  const levels = tree();
  levels.get(3).get("3,3")[2 * stride + 2] = 160;
  assert.equal(test(levels), false, "a flat parent must not erase a fine ridge");
}
{
  const levels = tree();
  for (const nodes of levels.values()) for (const data of nodes.values()) data.fill(-2);
  levels.get(3).get("1,1")[2 * stride + 2] = 2;
  assert.equal(test(levels, {parent:fill(-2)}), false,
    "an island below the vertical budget still requires shoreline retention");
}
{
  const levels = tree();
  levels.get(3).get("0,0").fill(113);
  assert.equal(test(levels), false, "total ancestor error, not one-level residual, owns pruning");
  levels.get(3).get("0,0").fill(112);
  assert.equal(test(levels), true, "the inclusive error boundary is accepted");
}
{
  // Float source: a 0.3 m flat beside a parent decoded at sea level. The
  // vertical error is tiny, but the parent would turn the land into water.
  const levels = tree();
  for (const nodes of levels.values()) for (const data of nodes.values()) data.fill(0.3);
  assert.equal(test(levels, {parent:new Float64Array(stride ** 2).fill(0)}), false,
    "a sub-metre height cannot be pruned onto the other side of sea level");
  assert.equal(test(levels, {parent:new Float64Array(stride ** 2).fill(0.01)}), true);
}
{
  const levels = tree(); levels.get(2).delete("0,0");
  assert.throws(() => test(levels), /missing source node/, "incomplete source cannot certify a subtree");
}
{
  // The parent has a kink between two child centres. Checking only the
  // child's samples reports 0 m; the actual error at the kink is 5 m.
  const parent = fill(100), child = fill(100);
  for (let y = 0; y < stride; y++) {
    parent[y * stride + 2] = 120;
    child[y * stride + 3] = 115;
    child[y * stride + 4] = 115;
    child[y * stride + 5] = 105;
    child[y * stride + 2] = 105;
  }
  const levels = new Map([[1,new Map([["0,0",child]])]]);
  assert.equal(test(levels, {parent,leafLod:1,maxErrorM:4.9}), false,
    "continuous bilinear error includes ancestor cell boundaries");
  assert.equal(test(levels, {parent,leafLod:1,maxErrorM:5}), true);
}
console.log("package pruning: constant fields, descendant ridge, small island, sub-metre sign, cumulative error, missing source and cell knots pass");
