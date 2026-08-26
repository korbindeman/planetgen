/*
 * Face-edge stitch for cubesphere preview tiles.
 *
 * Same-face neighbours already share a WorldPipeline plane, so their 90 m
 * pixels abut. A cube fold is a 90° turn in that plane: two native grids
 * sample the same ground, and no origin shift can make them adjacent cells.
 * The pad already carries real neighbour-face terrain; this module uses a
 * generated halo past the fold, resamples it into the other tile's UV, and
 * blends. Proven against a spherical field in `bun run check:tiles` — a
 * GPU bake is not required to know the warp is right. Still untested on
 * a real pair: bake two tiles that share a cube edge (not the same face)
 * and crop the join. A three-face corner is worse.
 *
 * The new tile conforms to whatever neighbour is already on disk. First
 * bake owns the edge; the join is still C0.
 */
'use strict';

const Cube = require('./cubesphere');

function sampleBilinear(data, width, height, x, y) {
    const u = x - 0.5;
    const v = y - 0.5;
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const tx = u - x0;
    const ty = v - y0;
    const at = (ix, iy) => data[
        Math.max(0, Math.min(height - 1, iy)) * width
        + Math.max(0, Math.min(width - 1, ix))
    ];
    return at(x0, y0) * (1 - tx) * (1 - ty)
        + at(x0 + 1, y0) * tx * (1 - ty)
        + at(x0, y0 + 1) * (1 - tx) * ty
        + at(x0 + 1, y0 + 1) * tx * ty;
}

function rasterizeTile(tile, width, height, field) {
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            out[y * width + x] = field(
                Cube.tileDirection(tile, (x + 0.5) / width, (y + 0.5) / height),
            );
        }
    }
    return out;
}

/*
 * Pixels past a tile edge, in that face's continuation. Index 0 is the
 * first sample over the line, so it is the same ground as the neighbour's
 * first interior column after a resample.
 */
function rasterizeHalo(tile, edge, width, height, haloPx, field) {
    if (edge === 'east' || edge === 'west') {
        const out = new Float32Array(haloPx * height);
        for (let y = 0; y < height; y++) {
            const t = (y + 0.5) / height;
            for (let x = 0; x < haloPx; x++) {
                const past = (x + 0.5) / width;
                const s = edge === 'east' ? 1 + past : -past;
                out[y * haloPx + x] = field(Cube.tileDirection(tile, s, t));
            }
        }
        return {data: out, width: haloPx, height};
    }
    const out = new Float32Array(width * haloPx);
    for (let y = 0; y < haloPx; y++) {
        const past = (y + 0.5) / height;
        const t = edge === 'south' ? 1 + past : -past;
        for (let x = 0; x < width; x++) {
            out[y * width + x] = field(
                Cube.tileDirection(tile, (x + 0.5) / width, t),
            );
        }
    }
    return {data: out, width, height: haloPx};
}

function sampleHalo(halo, edge, x, y, tileW, tileH) {
    if (!halo) return null;
    if (edge === 'east') {
        if (!(x > tileW && y >= 0 && y <= tileH)) return null;
        return sampleBilinear(halo.data, halo.width, halo.height, x - tileW, y);
    }
    if (edge === 'west') {
        if (!(x < 0 && y >= 0 && y <= tileH)) return null;
        return sampleBilinear(halo.data, halo.width, halo.height, -x, y);
    }
    if (edge === 'south') {
        if (!(y > tileH && x >= 0 && x <= tileW)) return null;
        return sampleBilinear(halo.data, halo.width, halo.height, x, y - tileH);
    }
    if (edge === 'north') {
        if (!(y < 0 && x >= 0 && x <= tileW)) return null;
        return sampleBilinear(halo.data, halo.width, halo.height, x, -y);
    }
    return null;
}

function sampleSrc(src, lon, lat) {
    const px = Cube.tilePixel(src.tile, lon, lat, src.width, src.height);
    if (!px) return null;
    const {x, y} = px;
    const w = src.width;
    const h = src.height;
    if (x >= 0 && x <= w && y >= 0 && y <= h) {
        return sampleBilinear(src.elev, w, h, x, y);
    }
    if (!src.halo) return null;
    for (let i = 0; i < Cube.EDGES.length; i++) {
        const edge = Cube.EDGES[i];
        const v = sampleHalo(src.halo[edge], edge, x, y, w, h);
        if (v != null && Number.isFinite(v)) return v;
    }
    return null;
}

function edgeDistPx(x, y, w, h, edge) {
    if (edge === 'east') return w - x;
    if (edge === 'west') return x;
    if (edge === 'south') return h - y;
    if (edge === 'north') return y;
    return Infinity;
}

function seamWeight(distPx, blend) {
    if (distPx >= blend) return 0;
    if (distPx <= 0) return 1;
    const t = distPx / blend;
    return 0.5 * (1 + Math.cos(Math.PI * t));
}

/* Halo is one coarse cell; only a few kilometres of that need to fade. */
function blendPxFor(width, height, haloPx) {
    return Math.min(haloPx, Math.max(8, Math.round(Math.min(width, height) * 0.025)));
}

function haloPxOf(halo, edge) {
    if (!halo) return 0;
    if (edge === 'east' || edge === 'west') return halo.width;
    return halo.height;
}

/*
 * Rewrites dest.elev along the shared cube edge so it follows src's halo.
 * Dest stays native past the fade. Returns how many dest pixels moved.
 */
function blendFromNeighbor(dest, src) {
    const destEdge = Cube.sharedEdge(dest.tile, src.tile);
    const srcEdge = Cube.sharedEdge(src.tile, dest.tile);
    if (!destEdge || !srcEdge) return 0;
    const halo = src.halo && src.halo[srcEdge];
    const haloPx = haloPxOf(halo, srcEdge);
    if (!(haloPx > 0)) return 0;
    const blend = blendPxFor(dest.width, dest.height, haloPx);
    let n = 0;
    for (let y = 0; y < dest.height; y++) {
        for (let x = 0; x < dest.width; x++) {
            const dist = edgeDistPx(x + 0.5, y + 0.5, dest.width, dest.height, destEdge);
            const wt = seamWeight(dist, blend);
            if (wt <= 0) continue;
            const d = Cube.tileDirection(
                dest.tile,
                (x + 0.5) / dest.width,
                (y + 0.5) / dest.height,
            );
            const ll = Cube.xyzToLonLat(d);
            const v = sampleSrc(src, ll.lon, ll.lat);
            if (v == null || !Number.isFinite(v)) continue;
            const i = y * dest.width + x;
            dest.elev[i] = dest.elev[i] * (1 - wt) + v * wt;
            n++;
        }
    }
    return n;
}

module.exports = {
    sampleBilinear,
    rasterizeTile,
    rasterizeHalo,
    sampleSrc,
    blendPxFor,
    blendFromNeighbor,
};
