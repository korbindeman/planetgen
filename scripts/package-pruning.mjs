/** Source-fidelity certificates for dropping a complete height subtree.
 *
 * Compare each source node's continuous bilinear surface with the retained
 * ancestor directly. The maximum of their difference lies on the overlay of
 * their bilinear cell corners, not necessarily at the child's texel centres.
 * Quantized encoding and rounded residual prediction are separate operations.
 * A region containing both dry and wet source samples is never pruned: a
 * vertical error tolerance alone cannot certify its shoreline topology.
 */

function sample(data, resolution, x, y) {
  const stride = resolution + 2;
  const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy;
  const at = (i, j) => data[Math.max(0, Math.min(stride - 1, j + 1)) * stride
    + Math.max(0, Math.min(stride - 1, i + 1))];
  const a = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx;
  const b = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx;
  return a * (1 - ty) + b * ty;
}

function knots(resolution, scale, offset) {
  const values = [-0.5, resolution - 0.5];
  for (let i = 0; i < resolution; i++) values.push(i);
  const first = Math.ceil(offset / scale - 0.5);
  const last = Math.floor((offset + resolution) / scale - 0.5);
  for (let i = first; i <= last; i++) {
    const x = (i + 0.5) * scale - offset - 0.5;
    if (x > -0.5 && x < resolution - 0.5) values.push(x);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

export function canPruneSubtree({parent, resolution, parentLod, parentX, parentY,
  lod, x, y, leafLod, levels, maxErrorM, seaLevel = 0}) {
  if (!Number.isFinite(maxErrorM) || maxErrorM < 0 || !Number.isFinite(seaLevel)) {
    throw new Error("finite nonnegative error and finite sea level required");
  }
  const count = (resolution + 2) ** 2;
  if (!Number.isInteger(resolution) || resolution < 2 || resolution % 2 || parent.length !== count) {
    throw new Error("invalid node resolution or parent payload");
  }
  let wet = false, dry = false;
  const visit = (level, nx, ny) => {
    const data = levels.get(level)?.get(`${nx},${ny}`);
    if (!data || data.length !== count) throw new Error(`missing source node ${level}/${nx}/${ny}`);
    // Include the skirt: it participates in interpolation at the boundary.
    for (const h of data) {
      if (!Number.isFinite(h)) throw new Error("non-finite source height");
      wet ||= h <= seaLevel; dry ||= h > seaLevel;
      if (wet && dry) return false;
    }
    const scale = 2 ** (level - parentLod);
    const ox = (nx - parentX * scale) * resolution;
    const oy = (ny - parentY * scale) * resolution;
    const xs = knots(resolution, scale, ox), ys = knots(resolution, scale, oy);
    for (const py of ys) {
      for (const px of xs) {
        const actual = sample(data, resolution, px, py);
        const predicted = sample(parent, resolution,
          (ox + px + 0.5) / scale - 0.5, (oy + py + 0.5) / scale - 0.5);
        if ((actual > seaLevel) !== (predicted > seaLevel)
          || Math.abs(actual - predicted) > maxErrorM) return false;
      }
    }
    if (level === leafLod) return true;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      if (!visit(level + 1, nx * 2 + dx, ny * 2 + dy)) return false;
    }
    return true;
  };
  return visit(lod, x, y);
}
