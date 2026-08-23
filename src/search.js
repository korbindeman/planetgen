/*
 * Interactive range search — the breeding math.
 *
 * A generation is a sheet of planets. Each tile is a fresh seed plus a
 * draw from the current freeable ranges. Liked tiles reshape those
 * ranges; the next sheet is drawn from the new box. Seed is never a
 * gene. Pins and DEFAULTS are not touched.
 *
 * Browser-free, so `bun run check:search` can hold the loop to its
 * invariants without opening the app.
 */
'use strict';

const Params = require('./params');

const SHEET_SIZE = 16;
const RANGE_K = 2;
const MIN_SIGMA_FRAC = 0.08;
const INFLATE = 0.5;
const INTEGER_UNITS = new Set(['count', 'step', 'index']);


function rngFrom(seed) {
    let a = (seed >>> 0) || 1;
    return function next() {
        a |= 0;
        a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}


function genesFor(values) {
    const pinned = new Set(Object.keys(values || {}));
    return Params.freeable().filter((name) => !pinned.has(name));
}


function currentRanges(genes) {
    const out = {};
    for (const name of genes) out[name] = Params.rangeOf(name);
    return out;
}


function vouchedRanges(genes) {
    const out = {};
    for (const name of genes) out[name] = Params.vouchedRange(name);
    return out;
}


function unitOf(name) {
    return Params.all()[name].unit;
}


function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}


function quantize(name, value, range) {
    const [lo, hi] = range;
    let v = clamp(value, lo, hi);
    if (INTEGER_UNITS.has(unitOf(name))) v = Math.round(v);
    if (unitOf(name) === 'frac') v = clamp(v, 0, 1);
    return v;
}


function snapRange(name, range, vouched) {
    let [lo, hi] = clipRange(range, vouched);
    if (INTEGER_UNITS.has(unitOf(name))) {
        lo = Math.floor(lo);
        hi = Math.ceil(hi);
        if (lo > hi) lo = hi;
        return clipRange([lo, hi], vouched);
    }
    return [lo, hi];
}


function clipRange(range, vouched) {
    let lo = Math.max(range[0], vouched[0]);
    let hi = Math.min(range[1], vouched[1]);
    if (lo > hi) {
        const mid = clamp((range[0] + range[1]) / 2, vouched[0], vouched[1]);
        lo = hi = mid;
    }
    return [lo, hi];
}


function shuffleInPlace(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = (rng() * (i + 1)) | 0;
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
}


function freshSeed(rng) {
    return 1 + ((rng() * 0x7ffffffe) | 0);
}


function latinHypercube(genes, ranges, count, rng) {
    const strata = {};
    for (const name of genes) {
        const idx = Array.from({length: count}, (_, i) => i);
        shuffleInPlace(idx, rng);
        strata[name] = idx;
    }
    const pop = [];
    for (let i = 0; i < count; i++) {
        const values = {};
        for (const name of genes) {
            const [lo, hi] = ranges[name];
            const u = count <= 1 ? rng() : (strata[name][i] + rng()) / count;
            values[name] = quantize(name, lo + u * (hi - lo), ranges[name]);
        }
        pop.push({seed: freshSeed(rng), values});
    }
    return pop;
}


function meanStd(xs) {
    const n = xs.length;
    let mu = 0;
    for (const x of xs) mu += x;
    mu /= n;
    if (n < 2) return {mu, sigma: 0};
    let v = 0;
    for (const x of xs) v += (x - mu) * (x - mu);
    return {mu, sigma: Math.sqrt(v / (n - 1))};
}


function gaussian(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}


function sampleGaussian(genes, ranges, stats, count, rng) {
    const pop = [];
    for (let i = 0; i < count; i++) {
        const values = {};
        for (const name of genes) {
            const range = ranges[name];
            const st = stats[name];
            const x = st
                ? st.mu + st.sigma * gaussian(rng)
                : range[0] + rng() * (range[1] - range[0]);
            values[name] = quantize(name, x, range);
        }
        pop.push({seed: freshSeed(rng), values});
    }
    return pop;
}


function likedOf(population, liked) {
    return (liked || []).map((i) => population[i]).filter(Boolean);
}


function fitRanges(genes, likedValues, vouched) {
    const next = {};
    for (const name of genes) {
        const v = vouched[name];
        const xs = likedValues.map((ind) => ind.values[name]);
        const {mu, sigma} = meanStd(xs);
        const floor = MIN_SIGMA_FRAC * (v[1] - v[0]);
        const s = Math.max(sigma, floor);
        next[name] = snapRange(name, [mu - RANGE_K * s, mu + RANGE_K * s], v);
    }
    return next;
}


function inflateRanges(current, vouched, genes) {
    const next = {};
    for (const name of genes) {
        const [c0, c1] = current[name];
        const [v0, v1] = vouched[name];
        next[name] = snapRange(name, [
            c0 - INFLATE * (c0 - v0),
            c1 + INFLATE * (v1 - c1),
        ], vouched[name]);
    }
    return next;
}


function likeStats(genes, likedValues, vouched) {
    const stats = {};
    for (const name of genes) {
        const xs = likedValues.map((ind) => ind.values[name]);
        const {mu, sigma} = meanStd(xs);
        const floor = MIN_SIGMA_FRAC * (vouched[name][1] - vouched[name][0]);
        stats[name] = {mu, sigma: Math.max(sigma, floor)};
    }
    return stats;
}


function initialPopulation({values, count = SHEET_SIZE, rng} = {}) {
    const genes = genesFor(values);
    const ranges = currentRanges(genes);
    const rand = typeof rng === 'function' ? rng : rngFrom(rng == null ? 1 : rng);
    return {
        genes,
        ranges,
        vouched: vouchedRanges(genes),
        population: latinHypercube(genes, ranges, count, rand),
    };
}


function nextGeneration({
    genes, ranges, vouched, population, liked, count = SHEET_SIZE, rng,
}) {
    const rand = typeof rng === 'function' ? rng : rngFrom(rng == null ? 1 : rng);
    const likedInds = likedOf(population, liked);
    if (likedInds.length === 0) {
        const nextRanges = inflateRanges(ranges, vouched, genes);
        return {
            genes,
            ranges: nextRanges,
            vouched,
            population: latinHypercube(genes, nextRanges, count, rand),
        };
    }
    const nextRanges = fitRanges(genes, likedInds, vouched);
    return {
        genes,
        ranges: nextRanges,
        vouched,
        population: sampleGaussian(
            genes, nextRanges, likeStats(genes, likedInds, vouched), count, rand,
        ),
    };
}


/* Done with likes still on the sheet: fold them in. No likes keeps the
 * working box — leaving search is not the same as rejecting the pocket. */
function rangesFromLikes({genes, vouched, population, liked, ranges}) {
    const likedInds = likedOf(population, liked);
    if (!likedInds.length) return ranges;
    return fitRanges(genes, likedInds, vouched);
}


function formatRange(name, range) {
    if (!range) return '';
    const [lo, hi] = range;
    const unit = unitOf(name);
    if (INTEGER_UNITS.has(unit)) return `${lo}–${hi}`;
    const digits = unit === 'frac' ? 2 : 2;
    return `${lo.toFixed(digits)}–${hi.toFixed(digits)}`;
}


module.exports = {
    SHEET_SIZE,
    RANGE_K,
    MIN_SIGMA_FRAC,
    INFLATE,
    genesFor,
    currentRanges,
    vouchedRanges,
    quantize,
    latinHypercube,
    fitRanges,
    inflateRanges,
    initialPopulation,
    nextGeneration,
    rangesFromLikes,
    formatRange,
    rngFrom,
};
