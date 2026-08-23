/*
 * Headless planet: mesh helpers, 1843 blend, overlay colours, and rasterizers.
 * Generation itself is `packages/pipeline` — generatePlanet is a thin entry
 * so the app and the scripts keep one call. Free of WebGL and DOM.
 */
'use strict';

const SimplexNoise = require('simplex-noise');
const {vec3} = require('gl-matrix');
const {makeRandInt, makeRandFloat} = require('@redblobgames/prng');
const SphereMesh = require('./sphere-mesh');
const Tectonics = require('./tectonics');
const EarthFixture = require('./earth-fixture');
const Look = require('./look');
const {BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM} = Tectonics;

const {clamp01} = Tectonics;

const COLLISION_THRESHOLD = 0.75;
const STRAIT = -0.05;
const LAKE_FILL = 0.08;
const persistence = 2 / 3;
const amplitudes = Array.from({length: 5}, (_, octave) => Math.pow(persistence, octave));

function makeFbm(seed) {
    const noise = new SimplexNoise(makeRandFloat(EarthFixture.numericSeed(seed)));
    return (nx, ny, nz) => {
        let sum = 0, sumOfAmplitudes = 0;
        for (let octave = 0; octave < amplitudes.length; octave++) {
            const frequency = 1 << octave;
            sum += amplitudes[octave] * noise.noise3D(nx * frequency, ny * frequency, nz * frequency);
            sumOfAmplitudes += amplitudes[octave];
        }
        return sum / sumOfAmplitudes;
    };
}

function generateTriangleCenters(mesh, {r_xyz}) {
    const {numTriangles} = mesh;
    const t_xyz = new Float32Array(3 * numTriangles);
    for (let t = 0; t < numTriangles; t++) {
        const a = mesh.s_begin_r(3 * t),
            b = mesh.s_begin_r(3 * t + 1),
            c = mesh.s_begin_r(3 * t + 2);
        t_xyz[3 * t] = (r_xyz[3 * a] + r_xyz[3 * b] + r_xyz[3 * c]) / 3;
        t_xyz[3 * t + 1] = (r_xyz[3 * a + 1] + r_xyz[3 * b + 1] + r_xyz[3 * c + 1]) / 3;
        t_xyz[3 * t + 2] = (r_xyz[3 * a + 2] + r_xyz[3 * b + 2] + r_xyz[3 * c + 2]) / 3;
    }
    return t_xyz;
}

function buildQuadGeometry(mesh, {r_xyz, t_xyz, r_elevation, t_elevation, r_moisture, t_moisture, r_temperature, t_temperature}, log) {
    const {numSides, numRegions, numTriangles} = mesh;
    const I = new Int32Array(3 * numSides);
    const xyz = new Float32Array(3 * (numRegions + numTriangles));
    const tm = new Float32Array(3 * (numRegions + numTriangles));
    xyz.set(r_xyz);
    xyz.set(t_xyz, r_xyz.length);

    let p = 0;
    for (let r = 0; r < numRegions; r++) {
        tm[p++] = r_elevation[r];
        tm[p++] = r_moisture[r];
        tm[p++] = r_temperature[r];
    }
    for (let t = 0; t < numTriangles; t++) {
        tm[p++] = t_elevation[t];
        tm[p++] = t_moisture[t];
        tm[p++] = t_temperature[t];
    }

    let i = 0, count_valley = 0, count_ridge = 0;
    for (let s = 0; s < numSides; s++) {
        const opposite_s = mesh.s_opposite_s(s),
            r1 = mesh.s_begin_r(s),
            r2 = mesh.s_begin_r(opposite_s),
            t1 = mesh.s_inner_t(s),
            t2 = mesh.s_inner_t(opposite_s);
        const coast = r_elevation[r1] < 0.0 || r_elevation[r2] < 0.0;
        if (coast) {
            I[i++] = r1; I[i++] = numRegions + t2; I[i++] = numRegions + t1;
            count_valley++;
        } else {
            I[i++] = r1; I[i++] = r2; I[i++] = numRegions + t1;
            count_ridge++;
        }
    }
    if (log) console.log('ridge=', count_ridge, ', valley=', count_valley);
    return {xyz, tm, I};
}

function plateCentroids(mesh, r_xyz, plates, r_plate) {
    const centroid = plates.map(() => [0, 0, 0]);
    for (let r = 0; r < mesh.numRegions; r++) {
        const c = centroid[r_plate[r]];
        c[0] += r_xyz[3 * r]; c[1] += r_xyz[3 * r + 1]; c[2] += r_xyz[3 * r + 2];
    }
    for (const c of centroid) vec3.normalize(c, c);
    return centroid;
}

function plateVectorsFromPoles(mesh, r_xyz, plates, r_plate) {
    const centroid = plateCentroids(mesh, r_xyz, plates, r_plate);
    const plate_vec = [];
    for (let p = 0; p < plates.length; p++) {
        plate_vec[p] = Tectonics.plateVelocity([], plates[p].pole, plates[p].omega, centroid[p]);
        const speed = vec3.length(plate_vec[p]);
        if (speed > 1e-12) vec3.scale(plate_vec[p], plate_vec[p], 1 / speed);
    }
    return plate_vec;
}

function mergeOceanPlates(mesh, r_plate, plate_is_ocean) {
    const parent = new Map();
    const find = (p) => { while (parent.has(p) && parent.get(p) !== p) p = parent.get(p); return p; };
    for (const p of plate_is_ocean) parent.set(p, p);

    const out_r = [];
    for (let r = 0; r < mesh.numRegions; r++) {
        const p = r_plate[r];
        if (!plate_is_ocean.has(p)) continue;
        mesh.r_circulate_r(out_r, r);
        for (const n of out_r) {
            const q = r_plate[n];
            if (q === p || !plate_is_ocean.has(q)) continue;
            const a = find(p), b = find(q);
            if (a !== b) parent.set(b, a);
        }
    }
    for (let r = 0; r < mesh.numRegions; r++) {
        if (plate_is_ocean.has(r_plate[r])) r_plate[r] = find(r_plate[r]);
    }
    const nextOcean = new Set();
    for (const p of plate_is_ocean) nextOcean.add(find(p));
    return {plate_is_ocean: nextOcean};
}

function assignDistanceField(mesh, seeds_r, stop_r, seed) {
    const randInt = makeRandInt(EarthFixture.numericSeed(seed));
    const {numRegions} = mesh;
    const r_distance = new Float32Array(numRegions);
    r_distance.fill(Infinity);
    const queue = [];
    for (const r of seeds_r) {
        queue.push(r);
        r_distance[r] = 0;
    }
    const out_r = [];
    for (let queue_out = 0; queue_out < queue.length; queue_out++) {
        const pos = queue_out + randInt(queue.length - queue_out);
        const current_r = queue[pos];
        queue[pos] = queue[queue_out];
        mesh.r_circulate_r(out_r, current_r);
        for (const neighbor_r of out_r) {
            if (r_distance[neighbor_r] === Infinity && !stop_r.has(neighbor_r)) {
                r_distance[neighbor_r] = r_distance[current_r] + 1;
                queue.push(neighbor_r);
            }
        }
    }
    return r_distance;
}

function findCollisions(mesh, r_xyz, plate_is_ocean, r_plate, plate_vec) {
    const deltaTime = 1e-2;
    const {numRegions} = mesh;
    const mountain_r = new Set(),
        coastline_r = new Set(),
        ocean_r = new Set();
    const r_out = [];
    for (let current_r = 0; current_r < numRegions; current_r++) {
        let bestCompression = Infinity, best_r = -1;
        mesh.r_circulate_r(r_out, current_r);
        for (const neighbor_r of r_out) {
            if (r_plate[current_r] !== r_plate[neighbor_r]) {
                const current_pos = r_xyz.slice(3 * current_r, 3 * current_r + 3),
                    neighbor_pos = r_xyz.slice(3 * neighbor_r, 3 * neighbor_r + 3);
                const distanceBefore = vec3.distance(current_pos, neighbor_pos),
                    distanceAfter = vec3.distance(
                        vec3.add([], current_pos, vec3.scale([], plate_vec[r_plate[current_r]], deltaTime)),
                        vec3.add([], neighbor_pos, vec3.scale([], plate_vec[r_plate[neighbor_r]], deltaTime)));
                const compression = distanceBefore - distanceAfter;
                if (compression < bestCompression) {
                    best_r = neighbor_r;
                    bestCompression = compression;
                }
            }
        }
        if (best_r !== -1) {
            const collided = bestCompression > COLLISION_THRESHOLD * deltaTime;
            const current_plate = r_plate[current_r],
                best_plate = r_plate[best_r];
            if (plate_is_ocean.has(current_plate) && plate_is_ocean.has(best_plate)) {
                (collided ? coastline_r : ocean_r).add(current_r);
            } else if (!plate_is_ocean.has(current_plate) && !plate_is_ocean.has(best_plate)) {
                if (collided) mountain_r.add(current_plate);
            } else {
                (collided ? mountain_r : coastline_r).add(current_r);
            }
        }
    }
    return {mountain_r, coastline_r, ocean_r};
}

function assignRegionElevation(mesh, map, seed, plateCount, fbm, log) {
    const {r_xyz, plate_is_ocean, r_plate, plate_vec, extra_ocean_seeds, r_elevation} = map;
    const epsilon = 1e-3;
    const {numRegions} = mesh;
    const {mountain_r, coastline_r, ocean_r} = findCollisions(
        mesh, r_xyz, plate_is_ocean, r_plate, plate_vec);

    for (let r = 0; r < numRegions; r++) {
        if (r_plate[r] === r) {
            (plate_is_ocean.has(r) ? ocean_r : coastline_r).add(r);
        }
    }
    if (extra_ocean_seeds) {
        for (const r of extra_ocean_seeds) ocean_r.add(r);
    }

    const stop_r = new Set();
    for (const r of mountain_r) stop_r.add(r);
    for (const r of coastline_r) stop_r.add(r);
    for (const r of ocean_r) stop_r.add(r);

    if (log) {
        console.log('seeds mountain/coastline/ocean:', mountain_r.size, coastline_r.size, ocean_r.size,
            'plate_is_ocean', plate_is_ocean.size, '/', plateCount);
    }
    const r_distance_a = assignDistanceField(mesh, mountain_r, ocean_r, seed);
    const r_distance_b = assignDistanceField(mesh, ocean_r, coastline_r, seed);
    const r_distance_c = assignDistanceField(mesh, coastline_r, stop_r, seed);

    for (let r = 0; r < numRegions; r++) {
        const a = r_distance_a[r] + epsilon,
            b = r_distance_b[r] + epsilon,
            c = r_distance_c[r] + epsilon;
        if (a === Infinity && b === Infinity) {
            r_elevation[r] = 0.1;
        } else {
            r_elevation[r] = (1 / a - 1 / b) / (1 / a + 1 / b + 1 / c);
        }
        r_elevation[r] += 0.1 * fbm(r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2]);
    }
}

function labelOceanComponents(mesh, r_elevation) {
    const {numRegions} = mesh;
    const comp = new Int32Array(numRegions);
    comp.fill(-1);
    const r_out = [];
    const sizes = [];
    let ncomp = 0;
    for (let s = 0; s < numRegions; s++) {
        if (r_elevation[s] >= 0 || comp[s] !== -1) continue;
        const q = [s];
        comp[s] = ncomp;
        let sz = 1;
        for (let i = 0; i < q.length; i++) {
            mesh.r_circulate_r(r_out, q[i]);
            for (const n of r_out) {
                if (r_elevation[n] < 0 && comp[n] === -1) {
                    comp[n] = ncomp;
                    q.push(n);
                    sz++;
                }
            }
        }
        sizes.push(sz);
        ncomp++;
    }
    let main = 0;
    for (let i = 1; i < ncomp; i++) {
        if (sizes[i] > sizes[main]) main = i;
    }
    return {comp, ncomp, sizes, main};
}

function heapPush(h, node) {
    h.push(node);
    let i = h.length - 1;
    while (i > 0) {
        const p = (i - 1) >> 1;
        if (h[p].key <= h[i].key) break;
        const t = h[p];
        h[p] = h[i];
        h[i] = t;
        i = p;
    }
}

function heapPop(h) {
    const out = h[0];
    const last = h.pop();
    if (!h.length) return out;
    h[0] = last;
    let i = 0;
    for (;;) {
        const l = i * 2 + 1, rgt = l + 1;
        let s = i;
        if (l < h.length && h[l].key < h[s].key) s = l;
        if (rgt < h.length && h[rgt].key < h[s].key) s = rgt;
        if (s === i) break;
        const t = h[s];
        h[s] = h[i];
        h[i] = t;
        i = s;
    }
    return out;
}

function connectWorldOcean(mesh, r_elevation) {
    const {numRegions} = mesh;
    let labeled = labelOceanComponents(mesh, r_elevation);
    if (labeled.ncomp <= 1) return;

    const fillMax = Math.max(36, (labeled.sizes[labeled.main] * 0.08) | 0);
    for (let r = 0; r < numRegions; r++) {
        const c = labeled.comp[r];
        if (c >= 0 && c !== labeled.main && labeled.sizes[c] <= fillMax) {
            r_elevation[r] = LAKE_FILL;
        }
    }

    const r_out = [];
    for (let guard = 0; guard < 24; guard++) {
        labeled = labelOceanComponents(mesh, r_elevation);
        if (labeled.ncomp <= 1) return;
        const {comp, main} = labeled;

        const d = new Float32Array(numRegions);
        d.fill(Infinity);
        const parent = new Int32Array(numRegions);
        parent.fill(-1);
        const heap = [];
        for (let r = 0; r < numRegions; r++) {
            if (comp[r] === main) {
                d[r] = -1;
                heapPush(heap, {r, key: -1});
            }
        }

        let hit = -1;
        while (heap.length) {
            const {r, key} = heapPop(heap);
            if (key > d[r]) continue;
            if (comp[r] >= 0 && comp[r] !== main) {
                hit = r;
                break;
            }
            mesh.r_circulate_r(r_out, r);
            for (const n of r_out) {
                const step = r_elevation[n] < 0 ? d[r] : Math.max(d[r], r_elevation[n]);
                if (step < d[n]) {
                    d[n] = step;
                    parent[n] = r;
                    heapPush(heap, {r: n, key: step});
                }
            }
        }
        if (hit < 0) return;

        let p = hit;
        let carved = false;
        while (p !== -1) {
            if (r_elevation[p] >= 0) {
                r_elevation[p] = STRAIT;
                carved = true;
            }
            if (comp[p] === main) break;
            p = parent[p];
        }
        if (!carved) return;
    }
}

function oceanicPlates(mesh, {r_plate, r_crust_type, plates}) {
    const total = new Int32Array(plates.length);
    const continental = new Int32Array(plates.length);
    for (let r = 0; r < mesh.numRegions; r++) {
        total[r_plate[r]]++;
        if (r_crust_type[r] === Tectonics.CRUST_CONTINENTAL) continental[r_plate[r]]++;
    }
    const ocean = new Set();
    for (let p = 0; p < plates.length; p++) {
        if (continental[p] / Math.max(1, total[p]) < 0.5) ocean.add(p);
    }
    return ocean;
}

function assignTriangleValues(mesh, {r_elevation, r_moisture, r_temperature, t_elevation, t_moisture, t_temperature}) {
    const {numTriangles} = mesh;
    for (let t = 0; t < numTriangles; t++) {
        const s0 = 3 * t;
        const r1 = mesh.s_begin_r(s0),
            r2 = mesh.s_begin_r(s0 + 1),
            r3 = mesh.s_begin_r(s0 + 2);
        t_elevation[t] = 1 / 3 * (r_elevation[r1] + r_elevation[r2] + r_elevation[r3]);
        t_moisture[t] = 1 / 3 * (r_moisture[r1] + r_moisture[r2] + r_moisture[r3]);
        t_temperature[t] = 1 / 3 * (r_temperature[r1] + r_temperature[r2] + r_temperature[r3]);
    }
}

function hsvRgb(h, s, v) {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: return [v, t, p];
        case 1: return [q, v, p];
        case 2: return [p, v, t];
        case 3: return [p, q, v];
        case 4: return [t, p, v];
        default: return [v, p, q];
    }
}

function colorForPlate(index, ocean) {
    const h = (index * Look.PLATE.hueStep) % 1;
    const sv = ocean ? Look.PLATE.ocean : Look.PLATE.land;
    return hsvRgb(h, sv.s, sv.v);
}

function crustColorForRegion(r, map) {
    const {r_crust_type, r_crust_age, r_orogeny, r_arc, r_boundary} = map;
    const C = Look.CRUST;
    if (r_boundary && r_boundary[r] === BOUNDARY_DIVERGENT) return C.ridge;
    if (r_boundary && r_boundary[r] === BOUNDARY_CONVERGENT) return C.trench;
    if (r_boundary && r_boundary[r] === BOUNDARY_TRANSFORM) return C.transform;
    if (r_crust_type && r_crust_type[r] === Tectonics.CRUST_CONTINENTAL) {
        const relief = clamp01(r_orogeny[r] * C.orogenyW + r_arc[r] * C.arcW);
        const {base, relief: d} = C.continent;
        return [base[0] + d[0] * relief, base[1] + d[1] * relief, base[2] + d[2] * relief];
    }
    const young = 1 - clamp01((r_crust_age ? r_crust_age[r] : 0) / C.ageMyr);
    const {base, young: y} = C.ocean;
    return [base[0] + y[0] * young, base[1] + y[1] * young, base[2] + y[2] * young];
}

function climateColorForRegion(r, map) {
    if (map.r_elevation[r] <= 0) return Look.CLIMATE_OCEAN;
    const m = clamp01(map.r_moisture[r]);
    const stops = Look.CLIMATE_STOPS;
    for (let i = 1; i < stops.length; i++) {
        if (m <= stops[i][0] || i === stops.length - 1) {
            const [a, ca] = stops[i - 1], [b, cb] = stops[i];
            const t = clamp01((m - a) / (b - a));
            return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
        }
    }
    return stops[stops.length - 1][1];
}

function overlayColorForRegion(r, map, mode) {
    if (mode === 'crust') return crustColorForRegion(r, map);
    if (mode === 'climate') return climateColorForRegion(r, map);
    return colorForPlate(map.plates[map.r_plate[r]].id, map.r_elevation[r] < 0);
}

function buildOverlayColorTm(mesh, map, mode) {
    const {r_plate, r_elevation} = map;
    const {numRegions, numTriangles} = mesh;
    const rgb = new Float32Array(3 * (numRegions + numTriangles));
    const regionColor = [];
    for (let r = 0; r < numRegions; r++) {
        const c = overlayColorForRegion(r, map, mode);
        regionColor[r] = c;
        rgb[3 * r] = c[0];
        rgb[3 * r + 1] = c[1];
        rgb[3 * r + 2] = c[2];
    }
    for (let t = 0; t < numTriangles; t++) {
        const r1 = mesh.s_begin_r(3 * t),
            r2 = mesh.s_begin_r(3 * t + 1),
            r3 = mesh.s_begin_r(3 * t + 2);
        const a = regionColor[r1], b = regionColor[r2], c = regionColor[r3];
        const p = 3 * (numRegions + t);
        rgb[p] = (a[0] + b[0] + c[0]) / 3;
        rgb[p + 1] = (a[1] + b[1] + c[1]) / 3;
        rgb[p + 2] = (a[2] + b[2] + c[2]) / 3;
    }
    return rgb;
}

function emptySimMap(mesh, r_xyz, t_xyz) {
    return {
        r_elevation: new Float32Array(mesh.numRegions),
        t_elevation: new Float32Array(mesh.numTriangles),
        r_moisture: new Float32Array(mesh.numRegions),
        t_moisture: new Float32Array(mesh.numTriangles),
        r_temperature: new Float32Array(mesh.numRegions),
        t_temperature: new Float32Array(mesh.numTriangles),
        r_xyz,
        t_xyz,
    };
}

function ensureSimMesh(opts, cache) {
    const n = opts.n | 0;
    const jitter = opts.jitter;
    const seed = opts.seed;
    if (cache.sim && cache.sim.n === n && cache.sim.jitter === jitter && cache.sim.seed === seed) {
        return cache.sim;
    }
    const result = SphereMesh.makeSphere(n, jitter, makeRandFloat(EarthFixture.numericSeed(seed)));
    cache.sim = {
        n, jitter, seed,
        mesh: result.mesh,
        r_xyz: result.r_xyz,
        t_xyz: generateTriangleCenters(result.mesh, {r_xyz: result.r_xyz}),
    };
    return cache.sim;
}

function ensureDetailMesh(detailN, jitter, cache) {
    if (cache.detail && cache.detail.n === detailN && cache.detail.jitter === jitter) {
        return cache.detail;
    }
    const result = SphereMesh.makeSphere(
        detailN, jitter, makeRandFloat(0x9e3779b9), {lat: [], lon: []});
    const r_xyz = Float32Array.from(result.r_xyz);
    cache.detail = {
        n: detailN,
        jitter,
        mesh: result.mesh,
        r_xyz,
        t_xyz: generateTriangleCenters(result.mesh, {r_xyz}),
    };
    return cache.detail;
}

function runBlend1843(simMesh, simMap, seed, tectOpts, log, flags = {}) {
    simMap.boundaryWarp = Tectonics.makeBoundaryWarp(simMesh, simMap.r_xyz, seed, tectOpts);
    simMap.tectonicFieldsFor = `${simMesh.numRegions}:${seed}`;
    simMap.r_plate = Tectonics.plateOwnership(simMesh, simMap, tectOpts);
    simMap.plate_is_ocean = new Set();
    for (let pl = 0; pl < simMap.plates.length; pl++) {
        if (makeRandInt(simMap.plates[pl].id + 1)(10) < 5) simMap.plate_is_ocean.add(pl);
    }
    if (flags.mergeOcean) {
        simMap.plate_is_ocean = mergeOceanPlates(simMesh, simMap.r_plate, simMap.plate_is_ocean).plate_is_ocean;
    }
    simMap.extra_ocean_seeds = [];
    simMap.plate_vec = plateVectorsFromPoles(simMesh, simMap.r_xyz, simMap.plates, simMap.r_plate);
    assignRegionElevation(simMesh, simMap, seed, tectOpts.plates, makeFbm(seed), log);
    simMap.r_boundary = null;
    simMap.r_crust_age = null;
    simMap.r_meters = null;
    Tectonics.polarStraits(
        simMesh, simMap.r_xyz, simMap.r_elevation,
        Object.assign({}, tectOpts, {polarStraits: tectOpts.polarStraits}));
}


function generatePlanet(opts = {}, cache = {}) {
    return require('./pipeline').run(opts, cache);
}

const PI = Math.PI;
const TWO_PI = 2 * PI;

function lonLatOfRegion(map, r, lon0) {
    const x = map.r_xyz[3 * r], y = map.r_xyz[3 * r + 1], z = map.r_xyz[3 * r + 2];
    let lon = Math.atan2(y, x) - lon0;
    while (lon < -PI) lon += TWO_PI;
    while (lon > PI) lon -= TWO_PI;
    const lat = Math.asin(Math.max(-1, Math.min(1, z)));
    return {lon, lat, e: map.r_elevation[r], m: map.r_moisture[r], t: map.r_temperature[r]};
}

function unwrapTriangleLons(a, b, c) {
    const pts = [
        {lon: a.lon, lat: a.lat, e: a.e, m: a.m, t: a.t},
        {lon: b.lon, lat: b.lat, e: b.e, m: b.m, t: b.t},
        {lon: c.lon, lat: c.lat, e: c.e, m: c.m, t: c.t},
    ];
    for (let i = 1; i < 3; i++) {
        while (pts[i].lon - pts[0].lon > PI) pts[i].lon -= TWO_PI;
        while (pts[0].lon - pts[i].lon > PI) pts[i].lon += TWO_PI;
    }
    return pts;
}

function rasterizeFieldTriangle(elev, moist, temp, filled, width, height, toPixel, a, b, c) {
    const pa = toPixel(a), pb = toPixel(b), pc = toPixel(c);
    const minX = Math.max(0, Math.floor(Math.min(pa.x, pb.x, pc.x)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(pa.x, pb.x, pc.x)));
    const minY = Math.max(0, Math.floor(Math.min(pa.y, pb.y, pc.y)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(pa.y, pb.y, pc.y)));
    if (maxX < minX || maxY < minY) return;

    const v0x = pb.x - pa.x, v0y = pb.y - pa.y;
    const v1x = pc.x - pa.x, v1y = pc.y - pa.y;
    const den = v0x * v1y - v1x * v0y;
    if (Math.abs(den) < 1e-12) return;

    for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5;
            const v2x = px - pa.x, v2y = py - pa.y;
            const v = (v2x * v1y - v1x * v2y) / den;
            const w = (v0x * v2y - v2x * v0y) / den;
            const u = 1 - v - w;
            if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;
            const i = y * width + x;
            elev[i] = u * a.e + v * b.e + w * c.e;
            moist[i] = u * a.m + v * b.m + w * c.m;
            temp[i] = u * a.t + v * b.t + w * c.t;
            filled[i] = 1;
        }
    }
}

function fillRasterHoles(elev, moist, temp, filled, width, height) {
    const q = [];
    for (let i = 0; i < filled.length; i++) {
        if (filled[i]) q.push(i);
    }
    if (!q.length) return;
    const dirs = [-1, 1, -width, width];
    for (let qi = 0; qi < q.length; qi++) {
        const i = q[qi];
        const x = i % width;
        for (const d of dirs) {
            if (d === -1 && x === 0) continue;
            if (d === 1 && x === width - 1) continue;
            const n = i + d;
            if (n < 0 || n >= filled.length || filled[n]) continue;
            elev[n] = elev[i];
            moist[n] = moist[i];
            temp[n] = temp[i];
            filled[n] = 1;
            q.push(n);
        }
    }
}

function rasterizeSphereGrid(mesh, map, width, height, toPixel, lon0, wrapShifts) {
    const elev = new Float32Array(width * height);
    const moist = new Float32Array(width * height);
    const temp = new Float32Array(width * height);
    const filled = new Uint8Array(width * height);
    const {numTriangles} = mesh;
    for (let t = 0; t < numTriangles; t++) {
        const r1 = mesh.s_begin_r(3 * t);
        const r2 = mesh.s_begin_r(3 * t + 1);
        const r3 = mesh.s_begin_r(3 * t + 2);
        const tri = unwrapTriangleLons(
            lonLatOfRegion(map, r1, lon0),
            lonLatOfRegion(map, r2, lon0),
            lonLatOfRegion(map, r3, lon0),
        );
        const minL = Math.min(tri[0].lon, tri[1].lon, tri[2].lon);
        const maxL = Math.max(tri[0].lon, tri[1].lon, tri[2].lon);
        const shifts = wrapShifts(minL, maxL);
        for (const shift of shifts) {
            const a = {lon: tri[0].lon + shift, lat: tri[0].lat, e: tri[0].e, m: tri[0].m, t: tri[0].t};
            const b = {lon: tri[1].lon + shift, lat: tri[1].lat, e: tri[1].e, m: tri[1].m, t: tri[1].t};
            const c = {lon: tri[2].lon + shift, lat: tri[2].lat, e: tri[2].e, m: tri[2].m, t: tri[2].t};
            rasterizeFieldTriangle(elev, moist, temp, filled, width, height, toPixel, a, b, c);
        }
    }
    fillRasterHoles(elev, moist, temp, filled, width, height);
    return {elev, moist, temp, width, height};
}

function rasterizeEquirect(mesh, map, width, height, lon0) {
    return rasterizeSphereGrid(mesh, map, width, height, (pt) => ({
        x: (pt.lon + PI) / TWO_PI * width,
        y: (PI / 2 - pt.lat) / PI * height,
    }), lon0, (minL, maxL) => {
        const shifts = [0];
        if (minL < -PI) shifts.push(TWO_PI);
        if (maxL > PI) shifts.push(-TWO_PI);
        return shifts;
    });
}

function rasterizeLonLatBox(mesh, map, westDeg, southDeg, eastDeg, northDeg, width, height, lon0) {
    const west = westDeg * PI / 180;
    const east = eastDeg * PI / 180;
    const south = southDeg * PI / 180;
    const north = northDeg * PI / 180;
    const lonSpan = east - west;
    const latSpan = north - south;
    return rasterizeSphereGrid(mesh, map, width, height, (pt) => ({
        x: (pt.lon - west) / lonSpan * width,
        y: (north - pt.lat) / latSpan * height,
    }), lon0, (minL, maxL) => {
        const shifts = [0];
        if (minL < west) shifts.push(TWO_PI);
        if (maxL > east) shifts.push(-TWO_PI);
        return shifts;
    });
}

module.exports = {
    generatePlanet,
    generateTriangleCenters,
    buildQuadGeometry,
    buildOverlayColorTm,
    overlayColorForRegion,
    crustColorForRegion,
    climateColorForRegion,
    colorForPlate,
    hsvRgb,
    plateCentroids,
    oceanicPlates,
    connectWorldOcean,
    assignTriangleValues,
    emptySimMap,
    ensureSimMesh,
    ensureDetailMesh,
    runBlend1843,
    rasterizeEquirect,
    rasterizeLonLatBox,
    BOUNDARY_CONVERGENT,
    BOUNDARY_DIVERGENT,
    BOUNDARY_TRANSFORM,
};
