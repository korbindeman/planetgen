#!/usr/bin/env bun
/**
 * Measure the tectonic model against Earth, without a browser.
 *
 *   bun run scripts/tectonics-stats.mjs
 *   bun run scripts/tectonics-stats.mjs --seeds=1,2,3 --steps=20
 *
 * Reported against these reference values for Earth:
 *   land 29% of the surface, continental crust ~41%
 *   plate areas   top-1 20%   top-3 49%   top-7 90%
 *   sea floor     age 0-180 Myr, depth 2600 m at the ridge to ~5700 m
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { makeRandFloat } = require('@redblobgames/prng');
const SphereMesh = require(join(root, 'sphere-mesh.js'));
const Tectonics = require(join(root, 'tectonics.js'));

const args = Object.fromEntries(
    process.argv.slice(2)
        .filter(a => a.startsWith('--'))
        .map(a => a.replace(/^--/, '').split('=')));

const N = Number(args.n ?? 10000);
const P = Number(args.p ?? 20);
const JITTER = 0.75;
const SEEDS = (args.seeds ?? '123,42,7,2024,99').split(',').map(Number);
const OPTIONS = {};
/* every key in DEFAULTS is overridable from the command line, so a sweep
 * never silently does nothing because the list here fell behind */
for (const key of Object.keys(Tectonics.DEFAULTS)) {
    if (args[key] !== undefined) OPTIONS[key] = Number(args[key]);
}

const EARTH_PLATE_AREAS = [20.3, 14.9, 13.3, 12.0, 11.9, 9.2, 8.6, 3.3, 3.1, 2.3,
                           1.1, 1.0, 0.65, 0.57, 0.31, 0.22, 0.1, 0.05, 0.04, 0.03];
const topN = (a, n) => a.slice(0, n).reduce((x, y) => x + y, 0);

function run(seed) {
    const started = Date.now();
    const { mesh, r_xyz } = SphereMesh.makeSphere(N, JITTER, makeRandFloat(seed));
    const map = { r_xyz, r_elevation: new Float32Array(mesh.numRegions) };
    Object.assign(map, Tectonics.generatePlates(mesh, P, seed));
    Tectonics.simulateTectonics(mesh, map, seed, OPTIONS);
    const ms = Date.now() - started;

    const n = mesh.numRegions;
    const areaOf = new Float64Array(map.plates.length);
    for (let r = 0; r < n; r++) areaOf[map.r_plate[r]]++;
    const areas = [...areaOf].sort((a, b) => b - a).map(v => v / n * 100);

    let land = 0, continental = 0, submergedContinental = 0, ages = [], depths = [];
    for (let r = 0; r < n; r++) {
        if (map.r_elevation[r] > 0) land++;
        if (map.r_crust_type[r] === Tectonics.CRUST_CONTINENTAL) {
            continental++;
            if (map.r_elevation[r] <= 0) submergedContinental++;
        } else {
            ages.push(map.r_crust_age[r]);
            depths.push(-Tectonics.elevationToMeters(map.r_elevation[r]));
        }
    }
    ages.sort((a, b) => a - b);
    depths.sort((a, b) => a - b);
    const q = (arr, p) => arr.length ? arr[Math.floor(p * (arr.length - 1))] : NaN;

    const boundary = { convergent: 0, divergent: 0, transform: 0 };
    for (let r = 0; r < n; r++) {
        if (map.r_boundary[r] === Tectonics.BOUNDARY_CONVERGENT) boundary.convergent++;
        else if (map.r_boundary[r] === Tectonics.BOUNDARY_DIVERGENT) boundary.divergent++;
        else if (map.r_boundary[r] === Tectonics.BOUNDARY_TRANSFORM) boundary.transform++;
    }
    const boundaryTotal = boundary.convergent + boundary.divergent + boundary.transform || 1;

    /* Is each plate one coherent body with a boundary a sane length, or a
     * scatter of pieces with an edge that wanders at cell scale? Raggedness
     * compares a plate's boundary to the shortest one a body of that area
     * could have. A perfect great-circle split of this mesh scores 1.42, so
     * that is the floor here, not 1.0. */
    const plateArea = new Int32Array(map.plates.length);
    const platePerimeter = new Int32Array(map.plates.length);
    const out_r = [];
    for (let r = 0; r < n; r++) {
        const p = map.r_plate[r];
        plateArea[p]++;
        mesh.r_circulate_r(out_r, r);
        for (const nb of out_r) if (map.r_plate[nb] !== p) platePerimeter[p]++;
    }
    const comp = new Int32Array(n).fill(-1);
    const fragments = new Int32Array(map.plates.length);
    for (let r = 0; r < n; r++) {
        if (comp[r] !== -1) continue;
        const p = map.r_plate[r];
        const queue = [r];
        comp[r] = 1;
        for (let h = 0; h < queue.length; h++) {
            mesh.r_circulate_r(out_r, queue[h]);
            for (const nb of out_r) if (comp[nb] === -1 && map.r_plate[nb] === p) { comp[nb] = 1; queue.push(nb); }
        }
        fragments[p]++;
    }
    let weight = 0, ragged = 0, pieces = 0;
    for (let p = 0; p < map.plates.length; p++) {
        const a = plateArea[p];
        if (a < 60) continue;
        ragged += a * (platePerimeter[p] / (2 * Math.sqrt(Math.PI * a) * 1.1));
        pieces += a * fragments[p];
        weight += a;
    }

    /* how much of the surface is high ground, and is it in belts? */
    let mountains = 0;
    for (let r = 0; r < n; r++) if (Tectonics.elevationToMeters(map.r_elevation[r]) > 2000) mountains++;

    return {
        seed, ms, plates: areas.length, areas,
        land: land / n * 100,
        continental: continental / n * 100,
        submerged: continental ? submergedContinental / continental * 100 : 0,
        ageMedian: q(ages, 0.5), ageMax: q(ages, 1),
        depthP10: q(depths, 0.1), depthMedian: q(depths, 0.5), depthP90: q(depths, 0.9),
        mountains: mountains / n * 100,
        raggedness: weight ? ragged / weight : NaN,
        fragments: weight ? pieces / weight : NaN,
        named: map.plates.filter(p => plateArea[map.plates.indexOf(p)] / n > 0.01).length,
        boundary: {
            convergent: boundary.convergent / boundaryTotal * 100,
            divergent: boundary.divergent / boundaryTotal * 100,
            transform: boundary.transform / boundaryTotal * 100,
        },
    };
}

const results = SEEDS.map(run);
for (const s of results) {
    console.log(`\n=== seed ${s.seed} (${s.ms} ms) ===`);
    console.log(`plates ${s.plates}  areas: ${s.areas.slice(0, 10).map(a => a.toFixed(1)).join(' ')}`);
    console.log(`  top1 ${s.areas[0].toFixed(0)}%  top3 ${topN(s.areas, 3).toFixed(0)}%  top7 ${topN(s.areas, 7).toFixed(0)}%`);
    console.log(`  land ${s.land.toFixed(1)}%  continental crust ${s.continental.toFixed(1)}% (${s.submerged.toFixed(0)}% of it submerged)`);
    console.log(`  sea floor age median ${s.ageMedian.toFixed(0)} max ${s.ageMax.toFixed(0)} Myr`);
    console.log(`  ocean depth p10 ${s.depthP10.toFixed(0)} median ${s.depthMedian.toFixed(0)} p90 ${s.depthP90.toFixed(0)} m`);
    console.log(`  above 2000 m: ${s.mountains.toFixed(1)}% of surface`);
    console.log(`  boundaries  convergent ${s.boundary.convergent.toFixed(0)}%  divergent ${s.boundary.divergent.toFixed(0)}%  transform ${s.boundary.transform.toFixed(0)}%`);
}

const mean = (f) => results.reduce((a, s) => a + f(s), 0) / results.length;
console.log(`\n=== mean over ${results.length} seeds ===`);
const rows = [
    ['land %', mean(s => s.land), '29'],
    ['continental crust %', mean(s => s.continental), '41'],
    ['continental submerged %', mean(s => s.submerged), '30'],
    ['plate top-1 %', mean(s => s.areas[0]), EARTH_PLATE_AREAS[0].toFixed(0)],
    ['plate top-3 %', mean(s => topN(s.areas, 3)), topN(EARTH_PLATE_AREAS, 3).toFixed(0)],
    ['plate top-7 %', mean(s => topN(s.areas, 7)), topN(EARTH_PLATE_AREAS, 7).toFixed(0)],
    ['sea floor max age', mean(s => s.ageMax), '180'],
    ['ocean depth median m', mean(s => s.depthMedian), '~4000'],
    ['surface above 2000 m %', mean(s => s.mountains), '~5'],
    ['plate count', mean(s => s.plates), '~15 major+minor'],
    ['boundary raggedness', mean(s => s.raggedness), '~1.2-1.5 (1.42 = a clean split on this mesh)'],
    ['pieces per plate', mean(s => s.fragments), '1.0 - a plate is one body'],
    ['runtime ms', mean(s => s.ms), ''],
];
for (const [label, value, earth] of rows) {
    console.log(`  ${label.padEnd(24)} ${value.toFixed(1).padStart(7)}   Earth ${earth}`);
}
