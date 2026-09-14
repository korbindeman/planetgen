/* Gaussian DEM reduction at true destination pixel centres. A supplied halo
 * lets the filter cross tile/fold boundaries instead of flattening the edge. */
function kernel(ratio, centre) {
    const sigma = Math.max(0.5, ratio / 2), radius = Math.ceil(3 * sigma);
    const first = Math.ceil(centre - radius), last = Math.floor(centre + radius);
    const taps = []; let total = 0;
    for (let i = first; i <= last; i++) {
        const weight = Math.exp(-0.5 * ((i - centre) / sigma) ** 2);
        taps.push({i, weight}); total += weight;
    }
    for (const tap of taps) tap.weight /= total;
    return taps;
}

function haloSize(width, height, outWidth, outHeight, outPad = 0) {
    const ratio = Math.max(width / outWidth, height / outHeight);
    return Math.ceil(3 * Math.max(0.5, ratio / 2) + outPad * ratio);
}

function downsample(src, width, height, outWidth, outHeight, pad = 0, outPad = 0) {
    const stride = width + 2 * pad, rows = height + 2 * pad;
    if (src.length !== stride * rows) throw new Error('Preview DEM dimensions differ');
    const rx = width / outWidth, ry = height / outHeight;
    const destWidth = outWidth + 2 * outPad, destHeight = outHeight + 2 * outPad;
    const xTaps = Array.from({length: destWidth}, (_, x) => kernel(rx, (x - outPad + 0.5) * rx - 0.5 + pad));
    const yTaps = Array.from({length: destHeight}, (_, y) => kernel(ry, (y - outPad + 0.5) * ry - 0.5 + pad));
    const mid = new Float32Array(destWidth * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < destWidth; x++) {
        let z = 0;
        for (const {i, weight} of xTaps[x]) z += src[y * stride + Math.max(0, Math.min(stride - 1, i))] * weight;
        mid[y * destWidth + x] = z;
    }
    const out = new Float32Array(destWidth * destHeight);
    for (let y = 0; y < destHeight; y++) for (let x = 0; x < destWidth; x++) {
        let z = 0;
        for (const {i, weight} of yTaps[y]) z += mid[Math.max(0, Math.min(rows - 1, i)) * destWidth + x] * weight;
        out[y * destWidth + x] = z;
    }
    return out;
}

module.exports = {haloSize, downsample};
