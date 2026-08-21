#!/usr/bin/env bun
/**
 * Measure the climate model against Earth, without a browser.
 *
 *   bun run climate
 *   bun run climate --seeds=1,2,3 --moistureGain=1.5
 *
 * The headline number is the coast asymmetry. On Earth the subtropical dry
 * belt is not a girdle: at 15-30 degrees a continent's east coast is wet
 * (Florida, south-east China, south-east Brazil) and its west coast is dry
 * (Sahara's Atlantic shore, Namib, Atacama, Baja), because the trades blow
 * from the east. Between 40 and 60 the westerlies reverse it: wet west
 * (Pacific North-west, western Europe, southern Chile), drier east.
 *
 * A model that paints moisture on by latitude scores zero on both and can
 * never do otherwise. That is the thing to watch.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { makeRandFloat } = require('@redblobgames/prng');
const SphereMesh = require(join(root, 'sphere-mesh.js'));
const Tectonics = require(join(root, 'tectonics.js'));
const Climate = require(join(root, 'climate.js'));

const args = Object.fromEntries(
    process.argv.slice(2)
        .filter(a => a.startsWith('--'))
        .map(a => a.replace(/^--/, '').split('=')));

const N = Number(args.n ?? 10000);
const P = Number(args.p ?? 20);
const SEEDS = (args.seeds ?? '1,2,3,5,6,9').split(',').map(Number);
const OPTIONS = {};
for (const key of Object.keys(Climate.DEFAULTS)) {
    if (args[key] !== undefined) OPTIONS[key] = Number(args[key]);
}

function run(seed) {
    const { mesh, r_xyz } = SphereMesh.makeSphere(N, 0.75, makeRandFloat(seed));
    const map = { r_xyz, r_elevation: new Float32Array(mesh.numRegions) };
    Object.assign(map, Tectonics.generatePlates(mesh, P, seed));
    Tectonics.simulateTectonics(mesh, map, seed);
    const started = Date.now();
    const { r_moisture } = Climate.assignClimate(mesh, map, seed, OPTIONS);
    const ms = Date.now() - started;

    const n = mesh.numRegions;
    const land = [];
    for (let r = 0; r < n; r++) if (map.r_elevation[r] > 0) land.push(r);

    /* Coastal cells, split by whether the sea lies to their west or east.
     * "West coast" means the ocean is westward of the land. */
    const out_r = [];
    const bands = {
        trades: { west: [], east: [] },      // 15-30 deg, easterly winds
        westerly: { west: [], east: [] },    // 40-60 deg, westerly winds
    };
    for (const r of land) {
        const px = r_xyz[3 * r], py = r_xyz[3 * r + 1], pz = r_xyz[3 * r + 2];
        const deg = Math.abs(Math.asin(Math.max(-1, Math.min(1, pz)))) * 180 / Math.PI;
        const band = (deg >= 15 && deg < 30) ? bands.trades
            : (deg >= 40 && deg < 60) ? bands.westerly : null;
        if (!band) continue;

        /* eastward tangent, to tell which side the water is on */
        let ex = -py, ey = px;
        const len = Math.hypot(ex, ey);
        if (len < 1e-9) continue;
        ex /= len; ey /= len;

        let eastward = 0, westward = 0;
        mesh.r_circulate_r(out_r, r);
        for (const nb of out_r) {
            if (map.r_elevation[nb] >= 0) continue;
            const dx = r_xyz[3 * nb] - px, dy = r_xyz[3 * nb + 1] - py;
            const along = dx * ex + dy * ey;
            if (along > 0) eastward++; else westward++;
        }
        if (eastward === 0 && westward === 0) continue;   // not coastal
        if (eastward > westward) band.east.push(r);
        else if (westward > eastward) band.west.push(r);
    }

    const mean = (list) => list.length
        ? list.reduce((a, r) => a + r_moisture[r], 0) / list.length : NaN;

    const values = land.map(r => r_moisture[r]).sort((a, b) => a - b);
    const q = (p) => values.length ? values[Math.floor(p * (values.length - 1))] : NaN;
    const share = (t) => values.filter(v => v > t).length / Math.max(1, values.length);

    return {
        seed, ms,
        land: land.length / n,
        moisture: [0.1, 0.5, 0.9].map(q),
        vegetated: share(0.5),
        lush: share(0.8),
        tradesWest: mean(bands.trades.west),
        tradesEast: mean(bands.trades.east),
        westerlyWest: mean(bands.westerly.west),
        westerlyEast: mean(bands.westerly.east),
    };
}

const results = SEEDS.map(run);
const mean = (f) => {
    const vals = results.map(f).filter(Number.isFinite);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
};

for (const s of results) {
    console.log(`seed ${String(s.seed).padStart(3)}  moisture p10/50/90 ${s.moisture.map(v => v.toFixed(2)).join(' ')}` +
        `  vegetated ${(s.vegetated * 100).toFixed(0)}%  lush ${(s.lush * 100).toFixed(0)}%` +
        `  trades W/E ${s.tradesWest.toFixed(2)}/${s.tradesEast.toFixed(2)}` +
        `  westerly W/E ${s.westerlyWest.toFixed(2)}/${s.westerlyEast.toFixed(2)}`);
}

const tw = mean(s => s.tradesWest), te = mean(s => s.tradesEast);
const ww = mean(s => s.westerlyWest), we = mean(s => s.westerlyEast);

console.log(`\n=== mean over ${results.length} seeds ===`);
console.log(`  land                     ${(mean(s => s.land) * 100).toFixed(1)}%`);
console.log(`  moisture p10/50/90       ${[0, 1, 2].map(i => mean(s => s.moisture[i]).toFixed(2)).join('  ')}`);
console.log(`  vegetated (>0.5)         ${(mean(s => s.vegetated) * 100).toFixed(0)}%   Earth ~65% of land is not arid`);
console.log(`  lush (>0.8)              ${(mean(s => s.lush) * 100).toFixed(0)}%   Earth ~30% forest`);
console.log(`\n  coast asymmetry (the point of advecting moisture rather than painting it):`);
console.log(`  trades 15-30 deg   west ${tw.toFixed(2)}  east ${te.toFixed(2)}   east-west ${(te - tw >= 0 ? '+' : '')}${(te - tw).toFixed(2)}   Earth: east wetter`);
console.log(`  westerlies 40-60   west ${ww.toFixed(2)}  east ${we.toFixed(2)}   west-east ${(ww - we >= 0 ? '+' : '')}${(ww - we).toFixed(2)}   Earth: west wetter`);
console.log(`\n  climate solve            ${mean(s => s.ms).toFixed(0)} ms`);
