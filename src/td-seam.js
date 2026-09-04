/*
 * Face-edge stitch for cubesphere preview tiles.
 *
 * Same-face neighbours already share a WorldPipeline plane, so their 90 m
 * pixels abut. A cube fold is a 90° turn in that plane: two native grids
 * sample the same ground, and no origin shift can make them adjacent cells.
 * The pad already carries real neighbour-face terrain; this module uses a
 * generated halo past the fold, resamples it into the other tile's UV, and
 * blends. Proven against a spherical field in `bun run check:tiles` — a
 * GPU bake is not required to know the warp is right.
 *
 * Now checked on a real pair, the three level-4 tiles at one cube corner.
 * The warp is right and the elevations meet to a few metres. What was left
 * was a resampling loss: a 90-degree turn puts every stitched pixel between
 * the neighbour's samples, so the stitched side arrives smoother than the
 * side it meets. That is why `sampleSrc` is bicubic and why check:tiles
 * measures detail retention on a rough field as well as a smooth one.
 *
 * What this cannot fix is that the two tiles are separate diffusions: their
 * terrain does not agree at the fold, only their elevations do. Same-face
 * neighbours do not have that problem — they share one bake-plane lattice,
 * so the bake hands them the same noise where they overlap. A fold has no
 * shared plane to share, so until the two sides of one are generated in a
 * single pass the fade is what hides the difference.
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

function catmullRom(t, a, b, c, d) {
    const t2 = t * t;
    return 0.5 * (2 * b + (c - a) * t
        + (2 * a - 5 * b + 4 * c - d) * t2
        + (3 * b - a - 3 * c + d) * t2 * t);
}

/*
 * The fold is a 90-degree turn, so every stitched pixel lands between the
 * neighbour's samples and the interpolator decides how much of its terrain
 * survives the trip. Measured on a real halo — 1792 samples of 180 m ground
 * across one level-4 fold — bilinear kept 58% of the along-seam roughness
 * and Catmull-Rom keeps 70%. The missing detail is what made the join read
 * as a line even once the elevations matched: one side of it was visibly
 * smoother than the other. `bun run check:tiles` pins the retention.
 */
function sampleBicubic(data, width, height, x, y) {
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
    const row = (iy) => catmullRom(
        tx, at(x0 - 1, iy), at(x0, iy), at(x0 + 1, iy), at(x0 + 2, iy),
    );
    return catmullRom(ty, row(y0 - 1), row(y0), row(y0 + 1), row(y0 + 2));
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
        return sampleBicubic(halo.data, halo.width, halo.height, x - tileW, y);
    }
    if (edge === 'west') {
        if (!(x < 0 && y >= 0 && y <= tileH)) return null;
        return sampleBicubic(halo.data, halo.width, halo.height, -x, y);
    }
    if (edge === 'south') {
        if (!(y > tileH && x >= 0 && x <= tileW)) return null;
        return sampleBicubic(halo.data, halo.width, halo.height, x, y - tileH);
    }
    if (edge === 'north') {
        if (!(y < 0 && x >= 0 && x <= tileW)) return null;
        return sampleBicubic(halo.data, halo.width, halo.height, x, -y);
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
        return sampleBicubic(src.elev, w, h, x, y);
    }
    if (!src.halo) return null;
    for (let i = 0; i < Cube.EDGES.length; i++) {
        const edge = Cube.EDGES[i];
        const v = sampleHalo(src.halo[edge], edge, x, y, w, h);
        if (v != null && Number.isFinite(v)) return v;
    }
    return null;
}

/*
 * A bake comes off the face's conformal plane; the drape, the exporter and
 * everything downstream want the tile's own raster. So put it back.
 *
 * `rect` is the *interior* lattice rectangle the bake covered — tileBakeRect
 * minus its pad — in bake-plane cells. Bicubic for the same reason the fold
 * stitch is: a resample between grids at an angle is where a bake loses the
 * detail that makes one side of a join look softer than the other.
 */
function bakeToTile(tile, rect, src, srcW, srcH, outW, outH) {
    const out = new Float32Array(outW * outH);
    const sx = srcW / rect.width;
    const sy = srcH / rect.height;
    for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
            const d = Cube.tileDirection(tile, (x + 0.5) / outW, (y + 0.5) / outH);
            const px = Cube.bakePixel(tile, rect, d);
            out[y * outW + x] = px
                ? sampleBicubic(src, srcW, srcH, px.x * sx, px.y * sy)
                : 0;
        }
    }
    return out;
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
    sampleBicubic,
    bakeToTile,
    rasterizeTile,
    rasterizeHalo,
    sampleSrc,
    blendPxFor,
    blendFromNeighbor,
};
