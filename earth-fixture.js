/*
 * Frozen present-day Earth: authored plates, Euler poles and cratons, then
 * a one-shot kinematic paint for age and belts. The random generator is not
 * involved. WebGL-free, like tectonics.js.
 *
 * Poles and ω are NNR-MORVEL56 (Argus, Gordon, DeMets 2011). Sites are
 * hand-placed so Dijkstra ownership falls near Earth's trenches and ridges.
 * Minors are slivers that touch two majors, not enclaves.
 */
'use strict';

const {vec3} = require('gl-matrix');
const Tectonics = require('./tectonics');

const TOKEN = 'earth';
const MESH_SEED = 1843;

/* Present-day area knobs. The random path is born at 0.57 because the
 * 200 Myr run consumes crust; using that here would drown the map. */
const EARTH_OPTS = {
    continentFraction: 0.41,
    emergentFraction: 0.71,
    cratons: 7,
    paintPasses: 6,
    seafloorAgeCapMyr: 180,
};

const DEG = Math.PI / 180;


function isEarthSeed(value) {
    return String(value == null ? '' : value).trim().toLowerCase() === TOKEN;
}


function numericSeed(value) {
    return isEarthSeed(value) ? MESH_SEED : (value | 0);
}


function lonLatToXyz(lonDeg, latDeg) {
    const lon = lonDeg * DEG, lat = latDeg * DEG;
    const c = Math.cos(lat);
    return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
}


function omegaFromDeg(degPerMyr) {
    return degPerMyr * DEG;
}


function sitesFrom(pairs) {
    return pairs.map(([lon, lat]) => lonLatToXyz(lon, lat));
}


function tangentFrame(centre, toward) {
    let u = vec3.scaleAndAdd([], toward, centre, -vec3.dot(toward, centre));
    if (vec3.length(u) < 1e-9) {
        const ref = Math.abs(centre[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        u = vec3.cross([], centre, ref);
    }
    vec3.normalize(u, u);
    return {u, v: vec3.cross([], centre, u)};
}


function makePlate(id, name, poleLon, poleLat, omegaDeg, sitePairs) {
    return {
        id,
        name,
        sites: sitesFrom(sitePairs),
        pole: lonLatToXyz(poleLon, poleLat),
        omega: omegaFromDeg(omegaDeg),
        bornMyr: 0,
        parent: -1,
        scale: 1,
    };
}


/* ~15 NUVEL / NNR-MORVEL56 plates. Each has an interior point plus a ring
 * inset from the real margin. Minors hug the boundary between two majors. */
function earthPlates() {
    return [
        makePlate(0, 'Pacific', 114.70, -63.58, 0.651, [
            [-150, 5], [-165, 20], [175, -15], [-145, -25],
            [172, 51], [-168, 52], [-152, 51],
            [-138, 46], [-128, 32], [-118, 12],
            [-114, -2], [-116, -18], [-118, -34], [-125, -48],
            [-148, -58], [178, -56], [162, -48],
            [156, 42], [154, 28], [155, 12], [164, -4],
            [-168, -18], [-170, -34],
        ]),
        makePlate(1, 'North America', -80.64, -4.85, 0.209, [
            [-100, 46], [-110, 55], [-90, 38],
            [-152, 64], [-140, 68], [-120, 72], [-90, 78],
            [-45, 72], [-40, 64], [-62, 48],
            [-72, 36], [-82, 26], [-96, 22],
            [-118, 38], [-124, 48], [-128, 56],
            [170, 68], [-170, 66],
            [-50, 35], [-42, 42],
        ]),
        makePlate(2, 'South America', -112.83, -22.62, 0.109, [
            [-62, -14], [-58, 2],
            [-70, 6], [-68, -4], [-69, -16], [-69, -28], [-70, -38],
            [-68, -48], [-66, -54],
            [-52, -28], [-44, -20], [-38, -10], [-48, 0],
            [-71, -12], [-70, -24], [-71, -36],
        ]),
        makePlate(3, 'Eurasia', -106.50, 48.85, 0.223, [
            [40, 54], [10, 50], [70, 56],
            [-8, 52], [8, 58], [24, 64],
            [30, 42], [55, 44], [80, 36], [90, 48], [110, 58], [128, 60],
            [138, 42], [140, 36], [145, 44], [155, 52],
            [128, 32], [108, 26], [98, 20],
            [70, 32], [82, 30], [90, 30], [38, 44],
            [60, 72], [100, 72],
        ]),
        makePlate(4, 'Africa', -68.44, 47.68, 0.292, [
            [18, 6], [8, 22], [28, 18],
            [-8, 28], [2, 32], [22, 30], [32, 22],
            [38, 8], [32, -4], [28, -16], [24, -28],
            [18, -32], [12, -22], [4, -8], [-8, 4], [-14, 16],
            [-20, 0], [8, -8],
        ]),
        makePlate(5, 'Antarctica', -118.11, 65.42, 0.250, [
            [0, -84],
            [0, -72], [60, -72], [120, -72], [180, -72],
            [-120, -72], [-60, -72],
            [-58, -66], [80, -66], [-160, -66],
        ]),
        makePlate(6, 'Australia', 37.94, 33.86, 0.632, [
            [134, -24], [122, -24], [144, -24],
            [118, -32], [128, -34], [142, -36], [150, -28],
            [146, -16], [136, -12], [128, -14],
            [152, -8], [164, -22], [168, -36], [146, -42],
        ]),
        makePlate(7, 'Nazca', -101.06, 46.23, 0.696, [
            [-90, -18],
            [-104, -4], [-108, -16], [-110, -28], [-104, -38],
            [-78, -8], [-76, -18], [-75, -28], [-76, -38],
            [-88, -6], [-92, -32],
        ]),
        makePlate(8, 'India', -3.29, 50.37, 0.544, [
            [78, 18], [80, 24], [72, 20], [86, 20],
            [78, 10], [74, 8], [88, 12],
            [70, 14], [66, 8],
        ]),
        makePlate(9, 'Caribbean', -92.62, 35.20, 0.286, [
            [-76, 15], [-86, 16], [-68, 14],
            [-80, 12], [-72, 18], [-88, 13], [-64, 16],
        ]),
        makePlate(10, 'Cocos', -124.31, 26.93, 1.198, [
            [-96, 10], [-102, 12], [-90, 9],
            [-100, 6], [-94, 14], [-88, 12],
        ]),
        makePlate(11, 'Philippine Sea', -31.36, -46.02, 0.910, [
            [134, 16], [128, 22], [140, 18],
            [132, 8], [138, 26], [126, 14], [142, 10],
        ]),
        makePlate(12, 'Scotia', -106.15, 22.52, 0.146, [
            [-46, -56], [-32, -57], [-56, -57],
            [-40, -54], [-50, -59],
        ]),
        makePlate(13, 'Arabia', -8.49, 48.88, 0.559, [
            [46, 24], [40, 28], [52, 22],
            [44, 16], [50, 28], [38, 22],
        ]),
        makePlate(14, 'Juan de Fuca', 60.04, -38.31, 0.951, [
            [-128, 46], [-130, 48], [-126, 43],
            [-132, 45], [-127, 49],
        ]),
    ];
}


function earthCratons() {
    const specs = [
        {lon: 20, lat: 8, share: 0.21, toward: [20, 32], elong: 1.35, taper: 0.18},
        {lon: 55, lat: 54, share: 0.28, toward: [100, 52], elong: 1.55, taper: 0.05},
        {lon: -92, lat: 52, share: 0.17, toward: [-55, 72], elong: 1.35, taper: 0.04},
        {lon: -64, lat: -18, share: 0.13, toward: [-64, 6], elong: 2.05, taper: 0.18},
        {lon: 134, lat: -25, share: 0.055, toward: [148, -25], elong: 1.45, taper: 0.10},
        {lon: 0, lat: -82, share: 0.105, toward: [90, -78], elong: 1.12, taper: 0.0},
        {lon: 78, lat: 20, share: 0.06, toward: [78, 30], elong: 1.30, taper: 0.15},
    ];
    const centres = [], shares = [], axes = [], elong = [], taper = [];
    for (const s of specs) {
        const centre = lonLatToXyz(s.lon, s.lat);
        centres.push(centre);
        shares.push(s.share);
        axes.push(tangentFrame(centre, lonLatToXyz(s.toward[0], s.toward[1])));
        elong.push(s.elong);
        taper.push(s.taper);
    }
    return {centres, shares, axes, elong, taper};
}


const HOTSPOTS = [
    {lon: -155.5, lat: 19.5, strength: 1.2},   // Hawaii
    {lon: -19.0, lat: 64.8, strength: 1.1},    // Iceland
    {lon: 55.5, lat: -21.1, strength: 1.0},    // Réunion
];


function heapPush(heap, cost, value) {
    heap.push({cost, value});
    let i = heap.length - 1;
    while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent].cost <= heap[i].cost) break;
        const t = heap[parent]; heap[parent] = heap[i]; heap[i] = t;
        i = parent;
    }
}

function heapPop(heap) {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
            const l = 2 * i + 1, r = l + 1;
            let small = i;
            if (l < heap.length && heap[l].cost < heap[small].cost) small = l;
            if (r < heap.length && heap[r].cost < heap[small].cost) small = r;
            if (small === i) break;
            const t = heap[small]; heap[small] = heap[i]; heap[i] = t;
            i = small;
        }
    }
    return top;
}


/* Age from distance to the nearest ridge, divided by that ridge's opening
 * rate, so the EPR paints a wide young swath and the MAR a narrower one.
 * Continents block the walk, so the Pacific does not inherit Atlantic age. */
function paintSeafloorAge(mesh, map, opts) {
    const {r_xyz, r_crust_type, r_crust_age} = map;
    const {r_boundary, r_convergence} = Tectonics.classifyBoundaries(mesh, map);
    const n = mesh.numRegions;
    const dist = new Float64Array(n).fill(Infinity);
    const rate = new Float64Array(n);
    const heap = [];
    const out_r = [];

    for (let r = 0; r < n; r++) {
        if (r_boundary[r] !== Tectonics.BOUNDARY_DIVERGENT) continue;
        if (r_crust_type[r] !== Tectonics.CRUST_OCEANIC) continue;
        const open = Math.max(1e-5, -r_convergence[r]);
        dist[r] = 0;
        rate[r] = open;
        heapPush(heap, 0, r);
    }

    while (heap.length > 0) {
        const {cost, value: r} = heapPop(heap);
        if (cost !== dist[r]) continue;
        mesh.r_circulate_r(out_r, r);
        for (const nb of out_r) {
            if (r_crust_type[nb] === Tectonics.CRUST_CONTINENTAL) continue;
            const dot = r_xyz[3 * r] * r_xyz[3 * nb]
                + r_xyz[3 * r + 1] * r_xyz[3 * nb + 1]
                + r_xyz[3 * r + 2] * r_xyz[3 * nb + 2];
            const step = Math.acos(dot < -1 ? -1 : dot > 1 ? 1 : dot);
            const next = dist[r] + step;
            if (next < dist[nb]) {
                dist[nb] = next;
                rate[nb] = rate[r];
                heapPush(heap, next, nb);
            }
        }
    }

    const cap = opts.seafloorAgeCapMyr;
    for (let r = 0; r < n; r++) {
        if (r_crust_type[r] !== Tectonics.CRUST_OCEANIC) continue;
        r_crust_age[r] = dist[r] === Infinity ? cap : Math.min(cap, dist[r] / rate[r]);
    }
}


function paintHotspots(mesh, map, opts) {
    const {r_xyz, r_hotspot, plates} = map;
    const n = mesh.numRegions;
    const spots = HOTSPOTS.map(h => ({
        xyz: lonLatToXyz(h.lon, h.lat),
        strength: h.strength,
    }));

    /* A short Emperor streak: old volcanoes sit in the direction the
     * Pacific has been carrying them. */
    const hawaii = lonLatToXyz(-155.5, 19.5);
    const pacific = plates.find(p => p.name === 'Pacific');
    if (pacific) {
        const v = Tectonics.plateVelocity([], pacific.pole, pacific.omega, hawaii);
        const speed = vec3.length(v);
        if (speed > 1e-12) {
            const dir = vec3.scale([], v, 1 / speed);
            for (const [ang, strength] of [[0.16, 0.50], [0.34, 0.28], [0.52, 0.15]]) {
                const p = vec3.normalize([], vec3.scaleAndAdd([], hawaii, dir, ang));
                spots.push({xyz: p, strength});
            }
        }
    }

    const cosR = Math.cos(opts.hotspotRadius);
    for (const spot of spots) {
        const p = spot.xyz;
        const add = spot.strength;
        for (let r = 0; r < n; r++) {
            const d = r_xyz[3 * r] * p[0] + r_xyz[3 * r + 1] * p[1] + r_xyz[3 * r + 2] * p[2];
            if (d > cosR) r_hotspot[r] = Math.min(2, r_hotspot[r] + add);
        }
    }
}


function buildEarthMap(mesh, map, options) {
    const opts = Object.assign({}, Tectonics.DEFAULTS, EARTH_OPTS, options);
    const seed = numericSeed(options && options.seed != null ? options.seed : TOKEN);

    map.plates = earthPlates();
    map.targetPlateCount = map.plates.length;
    map.nextPlateId = map.plates.length;
    map.elapsedMyr = 0;

    const stamp = `${mesh.numRegions}:${TOKEN}`;
    if (map.tectonicFieldsFor !== stamp) {
        map.boundaryWarp = Tectonics.makeBoundaryWarp(mesh, map.r_xyz, seed, opts);
        map.tectonicFieldsFor = stamp;
    }

    /* Authored sites, no enclave absorption, no body-splitting, no NNR
     * correction — the poles are already in that frame. */
    map.r_plate = Tectonics.assignPlateOwnership(mesh, map.r_xyz, map.plates, map.boundaryWarp);

    opts.cratonPlacement = earthCratons();
    Object.assign(map, Tectonics.initCrust(mesh, map.r_xyz, seed, opts));

    paintSeafloorAge(mesh, map, opts);
    paintHotspots(mesh, map, opts);
    for (let i = 0; i < opts.paintPasses; i++) {
        Tectonics.paintConvergentMargins(mesh, map, opts);
    }

    Object.assign(map, Tectonics.classifyBoundaries(mesh, map));
    Tectonics.crustToElevation(mesh, map, seed, opts);
    return map;
}


module.exports = {
    TOKEN,
    MESH_SEED,
    EARTH_OPTS,
    isEarthSeed,
    numericSeed,
    lonLatToXyz,
    buildEarthMap,
};
