/*
 * Hillshade for a baked crop, lit in one frame for the whole sphere.
 *
 * The old code shaded in the raster's own texel axes: dE/dx was "per column"
 * and dE/dy "per row", and the light sat at a fixed angle in that grid. On a
 * cubesphere those axes are a different frame on every face. Measured on the
 * level-4 tiles that meet at one cube corner, the raster +x of two tiles
 * across an equatorial fold point 57 deg apart, and across a polar fold 118
 * deg. Same ground, same sun, two different light directions - so a fold read
 * as a hard tone break even where the elevations agreed to a few metres, and
 * no amount of stitching the DEM could have closed it.
 *
 * So convert the texel gradient into the local east/north frame first and
 * light that. Neighbours then agree by construction, across a fold or not.
 *
 * The scale is the crop's *nominal* texel, not its real one. Equal-angle
 * tiles stretch by up to ~1.3x across a face, so shading at the true metres
 * would drift the relief strength within a face; the nominal keeps the
 * picture the per-texel shading already had. It also means the planet radius
 * cancels - the nominal texel is (pi/2) / (2^level * width) radians and the
 * Jacobian is in radians too, so only their ratio is ever used.
 *
 * East and north have no direction at a pole. A tile that contains one gets
 * the light spiralling around it, the way any equirect hillshade does. The
 * frame falls back to the face's own axis there rather than dividing by zero.
 */
'use strict';

const Cube = require('./cubesphere');
const Look = require('./look');

const DEG = Math.PI / 180;
/* Nodes across the crop where the frame is solved; bilinear in between. The
 * projection is smooth, so this is exact to ~1e-4 away from a pole. */
const FRAME_STEPS = 32;

function cross(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function unit(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}

/* East and north at a unit direction. Degenerate only at the poles. */
function tangentFrame(p, fallbackEast) {
    const e = cross([0, 0, 1], p);
    const east = Math.hypot(e[0], e[1], e[2]) < 1e-7 ? unit(fallbackEast) : unit(e);
    return {east, north: cross(p, east)};
}

/*
 * Texel gradient -> lit gradient, as a 2x2 per node. Row 0 of the raster is
 * north, so the y row carries a sign flip: the caller's dE/dy counts
 * southward, which is what the old per-texel shading fed the light.
 */
function matricesFrom(width, height, steps, texAngle, dirAt, faceEast) {
    const n = steps + 1;
    const out = new Float32Array(n * n * 4);
    const hs = 0.5 / width;
    const ht = 0.5 / height;
    for (let gy = 0; gy < n; gy++) {
        const t = gy / steps;
        const t1 = Math.min(1, t + ht);
        const t0 = Math.max(0, t - ht);
        const sy = 1 / ((t1 - t0) * height);
        for (let gx = 0; gx < n; gx++) {
            const s = gx / steps;
            const s1 = Math.min(1, s + hs);
            const s0 = Math.max(0, s - hs);
            const sx = 1 / ((s1 - s0) * width);
            const p = dirAt(s, t);
            const px = dirAt(s1, t);
            const mx = dirAt(s0, t);
            const py = dirAt(s, t1);
            const my = dirAt(s, t0);
            const dx = [(px[0] - mx[0]) * sx, (px[1] - mx[1]) * sx, (px[2] - mx[2]) * sx];
            const dy = [(py[0] - my[0]) * sy, (py[1] - my[1]) * sy, (py[2] - my[2]) * sy];
            const {east, north} = tangentFrame(p, faceEast);
            /* J maps a geographic gradient to the texel gradient. */
            const j00 = dot(dx, east), j01 = dot(dx, north);
            const j10 = dot(dy, east), j11 = dot(dy, north);
            let det = j00 * j11 - j01 * j10;
            if (Math.abs(det) < 1e-18) det = det < 0 ? -1e-18 : 1e-18;
            const k = texAngle / det;
            const o = (gy * n + gx) * 4;
            /* texAngle * diag(1, -1) * inverse(J). */
            out[o] = k * j11;
            out[o + 1] = -k * j01;
            out[o + 2] = k * j10;
            out[o + 3] = -k * j00;
        }
    }
    return {steps, data: out};
}

/*
 * Nominal radians per texel. A face edge is a quarter great circle cut into
 * 2^level tiles, so this is the same number for every tile of a level and
 * the seam between two of them cannot see it.
 */
function tileTexelAngle(tile, width, height) {
    const n = 1 << tile.level;
    return (Math.PI / 2) / (n * Math.sqrt(Math.max(1, width) * Math.max(1, height)));
}

function tileMatrices(tile, width, height) {
    return matricesFrom(
        width, height, FRAME_STEPS,
        tileTexelAngle(tile, width, height),
        (s, t) => Cube.tileDirection(tile, s, t),
        Cube.FACES[tile.face].u,
    );
}

/* Legacy lon/lat crops. Same frame, so one sitting beside a tile matches. */
function boxMatrices(box, width, height) {
    let east = Number(box && box.east);
    const west = Number(box && box.west);
    const south = Number(box && box.south);
    const north = Number(box && box.north);
    if (![east, west, south, north].every(Number.isFinite)) return null;
    if (east < west) east += 360;
    const midLat = (north + south) / 2 * DEG;
    const stepX = Math.abs((east - west) * DEG) * Math.cos(midLat) / Math.max(1, width);
    const stepY = Math.abs((north - south) * DEG) / Math.max(1, height);
    return matricesFrom(
        width, height, FRAME_STEPS,
        Math.sqrt(Math.max(1e-12, stepX * stepY)),
        (s, t) => Cube.lonLatToXyz(west + (east - west) * s, north + (south - north) * t),
        [0, 1, 0],
    );
}

function matrixAt(mat, out, fx, fy) {
    const n = mat.steps + 1;
    const u = Math.max(0, Math.min(mat.steps - 1e-6, fx * mat.steps));
    const v = Math.max(0, Math.min(mat.steps - 1e-6, fy * mat.steps));
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const tx = u - x0;
    const ty = v - y0;
    const o00 = (y0 * n + x0) * 4;
    const o10 = (y0 * n + x0 + 1) * 4;
    const o01 = ((y0 + 1) * n + x0) * 4;
    const o11 = ((y0 + 1) * n + x0 + 1) * 4;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    for (let k = 0; k < 4; k++) {
        out[k] = mat.data[o00 + k] * w00 + mat.data[o10 + k] * w10
            + mat.data[o01 + k] * w01 + mat.data[o11 + k] * w11;
    }
    return out;
}

/*
 * `e` is elevation in the units Look speaks, not metres. Returns one shade
 * per sample, the same number Look.hillshade returned before.
 */
function shadeField(e, width, height, mat) {
    const out = new Float32Array(width * height);
    const m = [0, 0, 0, 0];
    for (let y = 0; y < height; y++) {
        const y0 = y === 0 ? y : y - 1;
        const y1 = y === height - 1 ? y : y + 1;
        const fy = (y + 0.5) / height;
        for (let x = 0; x < width; x++) {
            const x0 = x === 0 ? x : x - 1;
            const x1 = x === width - 1 ? x : x + 1;
            const gx = (e[y * width + x1] - e[y * width + x0]) / (x1 - x0);
            const gy = (e[y1 * width + x] - e[y0 * width + x]) / (y1 - y0);
            matrixAt(mat, m, (x + 0.5) / width, fy);
            out[y * width + x] = Look.hillshade(
                m[0] * gx + m[1] * gy,
                m[2] * gx + m[3] * gy,
            );
        }
    }
    return out;
}

/* No tile and no box: nothing says where this raster is, so light its own
 * axes. That is what every crop did before, seam and all. */
const RASTER_AXES = {steps: 1, data: new Float32Array([
    1, 0, 0, 1, 1, 0, 0, 1,
    1, 0, 0, 1, 1, 0, 0, 1,
])};

/*
 * The one entry point a painter needs: a crop's shade, lit like every other
 * crop on the planet. `crop` carries either a cube tile or a lon/lat box.
 */
function cropShade(e, width, height, crop) {
    const mat = (crop && crop.tile ? tileMatrices(crop.tile, width, height) : null)
        || boxMatrices(crop, width, height)
        || RASTER_AXES;
    return shadeField(e, width, height, mat);
}

module.exports = {
    FRAME_STEPS,
    tangentFrame,
    tileTexelAngle,
    tileMatrices,
    boxMatrices,
    matrixAt,
    shadeField,
    cropShade,
};
