/*
 * Frozen present-day Earth: Bird 2003 plate outlines, NNR-MORVEL56 Euler
 * poles, authored cratons, then a one-shot kinematic paint for age and
 * belts. The random generator is not involved. WebGL-free, like tectonics.js.
 *
 * Outlines are PB2002 (Bird 2003), merged to the 16-plate USGS-style map
 * so trenches and ridges stay major–major boundaries. Poles and ω are
 * NNR-MORVEL56 (Argus, Gordon, DeMets 2011). Ownership is point-in-polygon
 * on those outlines — not Dijkstra from a handful of sites, and not warped.
 */
'use strict';

const {vec3} = require('gl-matrix');
const Tectonics = require('./tectonics');
const PLATE_DATA = require('./earth-plates-data.json');
const PROJECT = require('./projects/earth');

const TOKEN = 'earth';
const MESH_SEED = 1843;

/* Earth's body and authored knobs live in `projects/earth.js`. */
const EARTH_OPTS = Object.assign({}, PROJECT.body, PROJECT.values);

/* Parameters the fixture has and the simulation does not: the one-shot
 * kinematic paint has no loop to accumulate over. Registered in
 * `params.js` under the `fixture` module. */
const DEFAULTS = {
    paintPasses: 6,
    seafloorAgeCapMyr: 180,
};

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/* Known spots used as a sanity check that the outlines landed where they
 * should. Minors are listed first so a point on a shared edge prefers them. */
const PROBE = [
    ['Juan de Fuca', -128.5, 46.5],
    ['Scotia', -40, -57],
    ['Caribbean', -75, 15],
    ['Cocos', -95, 10],
    ['Arabia', 45, 24],
    ['Philippine Sea', 135, 16],
    ['Nazca', -90, -20],
    ['India', 78, 22],
    ['Somalia', 45, 0],
    ['Pacific', -150, 5],
    ['North America', -100, 45],
    ['South America', -60, -15],
    ['Eurasia', 40, 54],
    ['Africa', 18, 6],
    ['Antarctica', 0, -80],
    ['Australia', 134, -24],
];


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


function xyzToLonLat(x, y, z) {
    return [Math.atan2(y, x) * RAD, Math.asin(Math.max(-1, Math.min(1, z))) * RAD];
}


function omegaFromDeg(degPerMyr) {
    return degPerMyr * DEG;
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


/* Even-odd test in lon/lat. PB2002 already splits dateline-crossing plates
 * and walks polar plates up the ±180 meridians to the pole, so a planar
 * test on the equirectangular plane matches the polygons. */
function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if ((yi > lat) !== (yj > lat)) {
            const x = (xj - xi) * (lat - yi) / (yj - yi) + xi;
            if (lon < x) inside = !inside;
        }
    }
    return inside;
}


function ringBounds(ring) {
    let west = 180, east = -180, south = 90, north = -90;
    for (const [lon, lat] of ring) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
    }
    return {west, east, south, north};
}


function compilePlateRings(spec) {
    const rings = [];
    for (const ring of spec.rings) {
        if (!ring || ring.length < 4) continue;
        rings.push({ring, bounds: ringBounds(ring)});
    }
    return rings;
}


const COMPILED = PLATE_DATA.plates.map(compilePlateRings);


function plateIndexAtLonLat(lon, lat) {
    for (let p = 0; p < COMPILED.length; p++) {
        for (const {ring, bounds} of COMPILED[p]) {
            if (lat < bounds.south || lat > bounds.north) continue;
            if (lon < bounds.west || lon > bounds.east) continue;
            if (pointInRing(lon, lat, ring)) return p;
        }
    }
    return -1;
}


function assignFromPolygons(mesh, r_xyz) {
    const n = mesh.numRegions;
    const r_plate = new Int32Array(n);
    r_plate.fill(-1);
    for (let r = 0; r < n; r++) {
        const [lon, lat] = xyzToLonLat(r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2]);
        r_plate[r] = plateIndexAtLonLat(lon, lat);
    }
    fillGaps(mesh, r_plate);
    return r_plate;
}


function fillGaps(mesh, r_plate) {
    const n = mesh.numRegions;
    const out_r = [];
    const queue = [];
    for (let r = 0; r < n; r++) if (r_plate[r] >= 0) queue.push(r);
    for (let h = 0; h < queue.length; h++) {
        mesh.r_circulate_r(out_r, queue[h]);
        const p = r_plate[queue[h]];
        for (const nb of out_r) {
            if (r_plate[nb] < 0) {
                r_plate[nb] = p;
                queue.push(nb);
            }
        }
    }
    for (let r = 0; r < n; r++) if (r_plate[r] < 0) r_plate[r] = 0;
}


function sitesFromOwnership(r_xyz, r_plate, p, count) {
    const cells = [];
    for (let r = 0; r < r_plate.length; r++) if (r_plate[r] === p) cells.push(r);
    if (cells.length === 0) return [[1, 0, 0]];

    let cx = 0, cy = 0, cz = 0;
    for (const r of cells) {
        cx += r_xyz[3 * r];
        cy += r_xyz[3 * r + 1];
        cz += r_xyz[3 * r + 2];
    }
    const pick = [];
    let best = cells[0], bestDot = -2;
    const inv = 1 / Math.hypot(cx, cy, cz) || 1;
    cx *= inv; cy *= inv; cz *= inv;
    for (const r of cells) {
        const d = r_xyz[3 * r] * cx + r_xyz[3 * r + 1] * cy + r_xyz[3 * r + 2] * cz;
        if (d > bestDot) { bestDot = d; best = r; }
    }
    pick.push(best);
    const want = Math.min(count, cells.length);
    while (pick.length < want) {
        let far = cells[0], farScore = -1;
        for (const r of cells) {
            let nearest = -2;
            for (const s of pick) {
                const d = r_xyz[3 * r] * r_xyz[3 * s]
                    + r_xyz[3 * r + 1] * r_xyz[3 * s + 1]
                    + r_xyz[3 * r + 2] * r_xyz[3 * s + 2];
                if (d > nearest) nearest = d;
            }
            const score = 1 - nearest;
            if (score > farScore) { farScore = score; far = r; }
        }
        if (pick.includes(far)) break;
        pick.push(far);
    }
    return pick.map(r => [r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2]]);
}


function earthPlates(r_xyz, r_plate) {
    const perPlate = Tectonics.DEFAULTS.sitesPerPlate;
    return PLATE_DATA.plates.map((spec, id) => ({
        id,
        name: spec.name,
        sites: sitesFromOwnership(r_xyz, r_plate, id, perPlate),
        pole: lonLatToXyz(spec.poleLon, spec.poleLat),
        omega: omegaFromDeg(spec.omegaDeg),
        bornMyr: 0,
        parent: -1,
        scale: 1,
    }));
}


/* Straight-margin cuts, authored per block. `facets` is [[azimuthDeg,
 * offsetFrac], …]: azimuth 0 is the block's `toward` axis, +90 a quarter
 * turn to its left, and the cut trims everything past offsetFrac block
 * radii in that direction. `tip` is [azimuthDeg, halfAngleDeg, reachFrac]
 * sugar for the pair of cuts that converge into a point — an India, a
 * Patagonia — at reachFrac radii along the azimuth. */
function facetsFromSpec(s) {
    const list = [];
    if (s.facets) for (const [az, off] of s.facets) list.push({theta: az * DEG, off});
    if (s.tip) {
        const [az, phi, reach] = s.tip;
        /* Reach is in units of the ellipse's extent along the tip azimuth,
         * not the nominal radius — a stretched sliver runs sqrt(elong)
         * times further along its axis, and authoring against the nominal
         * radius truncated Patagonia at half its length. */
        const ca = Math.cos(az * DEG), sa = Math.sin(az * DEG);
        const stretch = Math.sqrt(ca * ca / s.elong + sa * sa * s.elong)
            / (1 + s.taper * ca);
        const off = reach * Math.sin(phi * DEG) / stretch;
        list.push({theta: (az + 90 - phi) * DEG, off, gate: az * DEG});
        list.push({theta: (az - 90 + phi) * DEG, off, gate: az * DEG});
    }
    return list;
}


function placementFromLonLat(specs, withFloor) {
    const centres = [], shares = [], axes = [], elong = [], taper = [];
    const radii = [], floorKm = [], facets = [];
    for (const s of specs) {
        const centre = lonLatToXyz(s.lon, s.lat);
        centres.push(centre);
        if (s.share != null) shares.push(s.share);
        if (s.radius != null) radii.push(s.radius);
        if (s.floorKm != null) floorKm.push(s.floorKm);
        const toward = s.toward || [s.lon, s.lat + (s.lat >= 0 ? 10 : -10)];
        axes.push(tangentFrame(centre, lonLatToXyz(toward[0], toward[1])));
        elong.push(s.elong);
        taper.push(s.taper);
        facets.push(facetsFromSpec(s));
    }
    const out = {centres, axes, elong, taper, facets};
    if (shares.length) out.shares = shares;
    if (radii.length) out.radii = radii;
    if (withFloor) out.floorKm = floorKm;
    return out;
}


/* Each continent is a union of blocks, the way the real one is an
 * aggregate of cratons and accreted terranes. A single decorated cap can
 * only make a blob — a circular Africa was the proof — so the wedge, the
 * waist and the peninsula are built from block geometry instead. */
function earthCratons() {
    return placementFromLonLat([
        /* Africa: wide across the Sahara, waisted at the Gulf of Guinea,
         * tapering through the Kalahari; the Horn as its own small block. */
        {lon: 3, lat: 18, share: 0.088, toward: [28, 15], elong: 1.55, taper: 0.10},
        {lon: 22, lat: -1, share: 0.056, toward: [38, -2], elong: 1.15, taper: 0.05},
        {lon: 24, lat: -22, share: 0.042, toward: [21, -33], elong: 1.35, taper: 0.25,
         tip: [0, 30, 0.85]},
        /* Madagascar, offshore across a drowned channel. */
        {lon: 49, lat: -19, share: 0.007, toward: [47, -12], elong: 2.8, taper: 0.10},
        {lon: 45, lat: 7, share: 0.012, toward: [51, 11], elong: 1.45, taper: 0.25,
         facets: [[90, 0.55]]},
        /* Eurasia: Baltica, Siberia, a Kazakh link, China, and Indochina
         * trailing off toward the equator. India and Arabia dock below. */
        {lon: 25, lat: 55, share: 0.055, toward: [48, 60], elong: 1.40, taper: 0.10},
        /* Iberia and an Italy sliver give the Med its north-shore
         * peninsulas; without them the basin is a featureless square. */
        {lon: -4, lat: 40, share: 0.012, toward: [3, 42], elong: 1.25, taper: 0.10},
        {lon: 13, lat: 43, share: 0.005, toward: [16, 39], elong: 2.6, taper: 0.20,
         tip: [0, 25, 0.9]},
        {lon: 95, lat: 63, share: 0.075, toward: [130, 63], elong: 1.60, taper: 0.08},
        {lon: 68, lat: 48, share: 0.035, toward: [88, 46], elong: 1.35, taper: 0.05},
        {lon: 110, lat: 32, share: 0.055, toward: [117, 42], elong: 1.35, taper: 0.15},
        {lon: 102, lat: 14, share: 0.020, toward: [104, 3], elong: 1.75, taper: 0.30,
         tip: [0, 20, 0.90]},
        /* North America: the shield wide across Canada, a cordilleran
         * block pointing at Mexico, Alaska reaching for the strait, and
         * an Appalachian seaboard strip. */
        {lon: -95, lat: 56, share: 0.072, toward: [-70, 56], elong: 1.50, taper: 0.08},
        {lon: -105, lat: 37, share: 0.045, toward: [-100, 19], elong: 1.50, taper: 0.30,
         tip: [0, 30, 0.85]},
        {lon: -143, lat: 64, share: 0.020, toward: [-158, 61], elong: 1.55, taper: 0.20},
        {lon: -76, lat: 38, share: 0.020, toward: [-62, 46], elong: 1.85, taper: 0.15},
        /* South America: the Amazon bulge, then a sliver tapering through
         * Patagonia, stopping short of 56°S so Drake Passage can cut. */
        {lon: -59, lat: -6, share: 0.068, toward: [-47, -9], elong: 1.25, taper: 0.10,
         facets: [[-25, 0.88], [-170, 0.92]]},
        {lon: -66.5, lat: -27.5, share: 0.029, toward: [-70, -46], elong: 4.40, taper: 0.30,
         tip: [0, 22, 0.75], facets: [[-90, 0.75]]},
        {lon: -55, lat: -21, share: 0.022, toward: [-48, -25], elong: 1.35, taper: 0.10},
        /* Australia: a western shield and an eastern block whose taper
         * points at Cape York, so the north coast gets its notch. */
        {lon: 119, lat: -25, share: 0.030, toward: [110, -24], elong: 1.30, taper: 0.12},
        {lon: 146, lat: -25, share: 0.022, toward: [144, -13], elong: 1.45, taper: 0.28,
         tip: [0, 28, 0.95]},
        {lon: 147, lat: -42, share: 0.003, toward: [147, -37], elong: 1.3, taper: 0.10},
        /* Antarctica: the East Antarctic disc plus a West Antarctic lobe
         * toward the Peninsula. */
        {lon: 60, lat: -82, share: 0.058, toward: [90, -78], elong: 1.10, taper: 0.0},
        {lon: -100, lat: -78, share: 0.022, toward: [-66, -67], elong: 1.60, taper: 0.25},
        /* India, Greenland, Arabia. */
        {lon: 78, lat: 21, share: 0.042, toward: [78, 32], elong: 1.28, taper: 0.14,
         tip: [180, 30, 1.05]},
        {lon: -42, lat: 73, share: 0.020, toward: [-42, 84], elong: 1.45, taper: 0.08,
         tip: [180, 30, 1.0]},
        {lon: 46, lat: 24, share: 0.024, toward: [48, 32], elong: 1.38, taper: 0.12,
         facets: [[90, 0.72], [-90, 0.72]]},
    ]);
}


/* Drowned continental crust. The Med is the one that reads from space;
 * Hudson Bay and Davis Strait keep Canada and Greenland from fusing;
 * the Caribbean stops the Americas becoming an isthmus wall. */
function earthBasins() {
    return placementFromLonLat([
        {lon: 20, lat: 35.5, toward: [38, 35], elong: 2.60, taper: 0.0, radius: 0.17, floorKm: 16},
        {lon: -82, lat: 60, toward: [-92, 58], elong: 1.55, taper: 0.0, radius: 0.17, floorKm: 25},
        {lon: -62, lat: 70, toward: [-62, 78], elong: 2.10, taper: 0.0, radius: 0.11, floorKm: 20},
        {lon: -76, lat: 15, toward: [-64, 14], elong: 2.05, taper: 0.0, radius: 0.15, floorKm: 18},
        {lon: 38, lat: 21, toward: [35, 28], elong: 3.40, taper: 0.0, radius: 0.09, floorKm: 20},
        {lon: -65, lat: -62, toward: [-42, -62], elong: 2.70, taper: 0.0, radius: 0.12, floorKm: 14},
        {lon: -90, lat: 25, toward: [-90, 25], elong: 1.35, taper: 0.0, radius: 0.11, floorKm: 24},
    ], true);
}


/* The two ice sheets are physical domes kilometres thick, not paint.
 * Thickened crust here floats the surface high, which is what makes the
 * interiors cold enough to render as solid sheets with domed hillshade. */
const ICE_DOMES = [
    {lon: -41, lat: 74, radius: 0.16, crownKm: 12},
    {lon: 60, lat: -82, radius: 0.30, crownKm: 10},
    {lon: -100, lat: -80, radius: 0.18, crownKm: 8},
];


function applyIceDomes(r_xyz, r_thickness, r_crust_type, opts) {
    for (const dome of ICE_DOMES) {
        const c = lonLatToXyz(dome.lon, dome.lat);
        for (let r = 0; r < r_thickness.length; r++) {
            if (r_crust_type[r] !== 1) continue;
            const d = Math.acos(Math.max(-1, Math.min(1,
                c[0] * r_xyz[3 * r] + c[1] * r_xyz[3 * r + 1] + c[2] * r_xyz[3 * r + 2])));
            if (d >= dome.radius) continue;
            const lift = dome.crownKm * (1 - (d / dome.radius) ** 2);
            r_thickness[r] = Math.min(opts.crustMaxKm,
                Math.max(r_thickness[r], opts.seaLevelThicknessKm + lift));
        }
    }
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


function assertProbes() {
    const names = PLATE_DATA.plates.map(p => p.name);
    const missed = [];
    for (const [expect, lon, lat] of PROBE) {
        const got = plateIndexAtLonLat(lon, lat);
        if (got < 0 || names[got] !== expect) {
            missed.push(`${expect} at ${lon},${lat} -> ${got < 0 ? 'none' : names[got]}`);
        }
    }
    if (missed.length) {
        throw new Error(`earth plate probes failed:\n  ${missed.join('\n  ')}`);
    }
}


function buildEarthMap(mesh, map, options) {
    const opts = Object.assign({}, Tectonics.DEFAULTS, EARTH_OPTS, options);
    const seed = numericSeed(options && options.seed != null ? options.seed : TOKEN);

    assertProbes();

    map.r_plate = assignFromPolygons(mesh, map.r_xyz);
    map.plates = earthPlates(map.r_xyz, map.r_plate);
    map.targetPlateCount = map.plates.length;
    map.nextPlateId = map.plates.length;
    map.elapsedMyr = 0;

    /* Authored outlines, not a noise-warped Voronoi. Anything that later
     * asks for a warp must not bend the trenches off the real margins. */
    map.boundaryWarp = () => 1;
    map.tectonicFieldsFor = `${mesh.numRegions}:${TOKEN}`;

    opts.cratonPlacement = earthCratons();
    opts.basinPlacement = earthBasins();
    Object.assign(map, Tectonics.initCrust(mesh, map.r_xyz, seed, opts));

    paintSeafloorAge(mesh, map, opts);
    paintHotspots(mesh, map, opts);
    for (let i = 0; i < opts.paintPasses; i++) {
        Tectonics.paintConvergentMargins(mesh, map, opts);
    }
    /* Collision paint would raise the Med back into mountains; drown it
     * again and kill the orogeny the basin is sitting on. */
    Tectonics.applyBasins(map.r_xyz, map.r_thickness, map.r_crust_type, opts, map.r_orogeny);
    applyIceDomes(map.r_xyz, map.r_thickness, map.r_crust_type, opts);

    Object.assign(map, Tectonics.classifyBoundaries(mesh, map));
    Tectonics.crustToElevation(mesh, map, seed, opts);
    return map;
}


module.exports = {
    TOKEN,
    MESH_SEED,
    DEFAULTS,
    EARTH_OPTS,
    PROJECT,
    isEarthSeed,
    numericSeed,
    lonLatToXyz,
    plateIndexAtLonLat,
    buildEarthMap,
};
