/*
 * Tectonics for the planet generator.
 *
 * This module is deliberately free of WebGL and DOM so it can be run and
 * measured headlessly (see scripts/tectonics-stats.mjs).
 *
 * The model has three parts:
 *
 *   1. Plates with an Earth-like size hierarchy, grown by weighted
 *      competition rather than a uniform flood fill.
 *   2. Rigid motion about Euler poles in a no-net-rotation frame, and a
 *      classification of every boundary as convergent, divergent or
 *      transform.
 *   3. A timestepped simulation in which the crust itself is the state.
 *      Crust carries a type, an age and a thickness; plates advect it,
 *      ridges create it, trenches consume it, collisions thicken it.
 *
 * Elevation is read off the crust at the end rather than being painted
 * from plate outlines: ocean depth comes from the age of the sea floor
 * via half-space cooling, land height from isostasy on crustal thickness.
 */
'use strict';

const SimplexNoise = require('simplex-noise');
const {vec3} = require('gl-matrix');
const {makeRandInt, makeRandFloat} = require('@redblobgames/prng');

/* The -1..1 elevation scale the renderer, climate model and exporter all
 * share. Defined here because the simulation works in metres and has to
 * map back onto it. */
const LAND_PEAK_M = 5500;
const LAND_POWER = 1.35;
const OCEAN_DEPTH_M = 6000;   // deep enough for the 5650 m the cooling curve reaches
const OCEAN_POWER = 1.4;

function elevationToMeters(e) {
    if (e >= 0) return LAND_PEAK_M * Math.pow(e, LAND_POWER);
    return -OCEAN_DEPTH_M * Math.pow(-e, OCEAN_POWER);
}

function metersToElevation(m) {
    if (m >= 0) return Math.pow(Math.min(1, m / LAND_PEAK_M), 1 / LAND_POWER);
    return -Math.pow(Math.min(1, -m / OCEAN_DEPTH_M), 1 / OCEAN_POWER);
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/* Averages a field with its neighbours in place. `mask`, when given,
 * confines the average to regions sharing the same mask value. */
function smoothField(mesh, values, mask, iterations) {
    const {numRegions} = mesh;
    const next = new Float32Array(numRegions);
    const neighbors = [];
    for (let iter = 0; iter < iterations; iter++) {
        for (let r = 0; r < numRegions; r++) {
            mesh.r_circulate_r(neighbors, r);
            let sum = values[r], count = 1;
            for (const n of neighbors) {
                if (!mask || mask[n] === mask[r]) { sum += values[n]; count++; }
            }
            next[r] = sum / count;
        }
        values.set(next);
    }
    return values;
}


/**********************************************************************
 * 1. Plates
 *
 * A plate is a rigid body made of *sites* — points that rotate with it.
 * A cell belongs to whichever site is nearest, so the boundary between two
 * plates falls where their nearest sites tie: a great-circle arc, and where
 * three plates meet, a triple junction. That is what Earth's plate map is
 * made of, and it is why its boundaries read as long smooth curves rather
 * than as noise.
 *
 * Growing plates by flood fill instead gives a boundary that wanders at
 * cell scale. Measured against the shortest boundary a body of that area
 * could have, a flood-filled plate scores about 3; Earth's major plates
 * score 1.2 to 1.5. That ratio is what "messy" meant.
 *
 * Several sites per plate rather than one is what keeps the shapes from
 * being convex caps: a plate is the union of its sites' cells, so it can be
 * elongated, notched or crescent-shaped while every edge stays an arc.
 */

/* Earth's plates come in two populations: a handful of majors holding
 * ~90% of the surface, then a microplate tail. Uniform seeding gives every
 * plate the same expected area instead, which reads as interchangeable
 * blobs. */
const PLATE_MAJOR_FRACTION = 0.35;   // share of plates that are "major"
const PLATE_MAJOR_SHARE = 0.90;      // share of the surface they hold
const PLATE_SIGMA_MAJOR = 0.20;      // lognormal spread within each population
const PLATE_SIGMA_MINOR = 0.70;

function plateAreaTargets(count, randFloat) {
    const gauss = () => {   // Box-Muller, so the shares come out lognormal
        const u1 = Math.max(1e-9, randFloat()), u2 = randFloat();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const numMajor = Math.max(1, Math.min(count, Math.round(count * PLATE_MAJOR_FRACTION)));
    const numMinor = count - numMajor;
    const major = Array.from({length: numMajor}, () => Math.exp(PLATE_SIGMA_MAJOR * gauss()));
    const minor = Array.from({length: numMinor}, () => Math.exp(PLATE_SIGMA_MINOR * gauss()));
    const sumMajor = major.reduce((a, b) => a + b, 0) || 1;
    const sumMinor = minor.reduce((a, b) => a + b, 0) || 1;
    const share = numMinor === 0 ? 1 : PLATE_MAJOR_SHARE;
    return [
        ...major.map(w => share * w / sumMajor),
        ...minor.map(w => (1 - share) * w / sumMinor),
    ];
}


/* Plates are named so they can be talked about, and the name travels with
 * the plate through every rift and collision it survives. Built from
 * syllables rather than a fixed list, so a world can have as many as it
 * needs and none of them are Earth's. */
const NAME_ONSET = ['b', 'br', 'c', 'ch', 'd', 'dr', 'f', 'g', 'h', 'k', 'l', 'm', 'n',
                    'p', 'pr', 'q', 'r', 's', 'sh', 'st', 't', 'th', 'tr', 'v', 'y', 'z'];
const NAME_VOWEL = ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'i', 'o', 'ae', 'ia', 'io', 'ou'];
const NAME_CODA = ['', '', '', 'l', 'n', 'r', 's', 'th', 'm', 'nd', 'rn', 'sk'];
const NAME_SUFFIX = ['ia', 'a', 'ea', 'is', 'os', 'an', 'or', 'ar', 'ith', 'une'];

function makePlateNamer(randFloat) {
    const used = new Set();
    const pick = (list) => list[Math.min(list.length - 1, Math.floor(randFloat() * list.length))];
    return () => {
        for (let attempt = 0; attempt < 40; attempt++) {
            let name = pick(NAME_ONSET) + pick(NAME_VOWEL);
            if (randFloat() < 0.55) name += pick(NAME_CODA) + pick(NAME_VOWEL);
            name += pick(NAME_SUFFIX);
            name = name[0].toUpperCase() + name.slice(1);
            if (!used.has(name) && name.length >= 4) { used.add(name); return name; }
        }
        let n = 1;
        while (used.has(`Plate ${n}`)) n++;
        used.add(`Plate ${n}`);
        return `Plate ${n}`;
    };
}


/* Sites are scattered over the whole sphere, then handed out to plate
 * nuclei. A plate's area follows from how many sites it holds, so the size
 * hierarchy survives without any of the shapes being drawn by hand. */
function scatterSites(count, randFloat) {
    const sites = [];
    /* a spiral gives an even spread; the jitter keeps it from looking woven */
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
        const z = 1 - (2 * i + 1) / count;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        const theta = golden * i + 0.6 * (randFloat() - 0.5);
        const v = [r * Math.cos(theta), r * Math.sin(theta), z + 0.35 * (randFloat() - 0.5) / count];
        const m = Math.hypot(v[0], v[1], v[2]);
        sites.push([v[0] / m, v[1] / m, v[2] / m]);
    }
    return sites;
}


function angleBetween(a, b) {
    return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
}


/* Hand each site to a nucleus, with each plate taking exactly the share of
 * the sphere it was allotted.
 *
 * The obvious way — scale each nucleus's reach and adjust the scales until
 * the areas come out right — does not converge. Area is a steep function of
 * the ratio between neighbouring scales, so the correction overshoots, and
 * when two nuclei happen to land a few degrees apart it runs away entirely:
 * measured on one seed the worst error grew 2.0 -> 4.6 over the iterations
 * while a single plate swelled from 131 sites to 340.
 *
 * It is really an assignment problem with capacities, so solve it as one.
 * Take every nucleus-site pair in order of distance and hand each site to
 * its nearest plate that still has room. Quotas are then met exactly, and
 * because the nearest pairs are taken first each plate still comes out as a
 * compact group.
 */
function assignSitesToPlates(sites, nuclei, targets) {
    const n = sites.length;

    const quota = targets.map(t => Math.max(1, Math.round(t * n)));
    let total = quota.reduce((a, b) => a + b, 0);
    /* rounding has to be paid for out of the largest plates */
    while (total !== n) {
        let pick = 0;
        for (let p = 1; p < quota.length; p++) if (quota[p] > quota[pick]) pick = p;
        if (total > n) { if (quota[pick] > 1) { quota[pick]--; total--; } else break; }
        else { quota[pick]++; total++; }
    }

    const pairs = [];
    for (let s = 0; s < n; s++) {
        for (let p = 0; p < nuclei.length; p++) {
            pairs.push({d: angleBetween(sites[s], nuclei[p]), s, p});
        }
    }
    pairs.sort((a, b) => a.d - b.d);

    const owner = new Int32Array(n).fill(-1);
    const held = new Int32Array(nuclei.length);
    let assigned = 0;
    for (const pair of pairs) {
        if (owner[pair.s] !== -1 || held[pair.p] >= quota[pair.p]) continue;
        owner[pair.s] = pair.p;
        held[pair.p]++;
        if (++assigned === n) break;
    }
    /* anything still loose goes to whichever plate is nearest */
    if (assigned < n) {
        for (const pair of pairs) {
            if (owner[pair.s] !== -1) continue;
            owner[pair.s] = pair.p;
            if (++assigned === n) break;
        }
    }
    return owner;
}


function generatePlates(mesh, numPlates, seed, options) {
    const opts = Object.assign({}, DEFAULTS, options);
    const randFloat = makeRandFloat(seed ^ 0x5f3759df);
    const nextName = makePlateNamer(makeRandFloat(seed ^ 0x1b873593));

    const targets = plateAreaTargets(numPlates, randFloat);
    /* nuclei kept apart, so no two plates start life fighting over the same
       patch of sphere */
    const nuclei = [];
    for (let p = 0; p < numPlates; p++) {
        let best = null, bestGap = -1;
        for (let attempt = 0; attempt < 32; attempt++) {
            const c = randomUnitVector(randFloat);
            let gap = Infinity;
            for (const o of nuclei) gap = Math.min(gap, angleBetween(c, o));
            if (gap > bestGap) { bestGap = gap; best = c; }
            if (gap > opts.nucleusSeparation) break;
        }
        nuclei.push(best);
    }
    const sites = scatterSites(numPlates * opts.sitesPerPlate, randFloat);
    const owner = assignSitesToPlates(sites, nuclei, targets);

    const plates = [];
    for (let p = 0; p < numPlates; p++) {
        plates.push({
            id: p,
            name: nextName(),
            sites: [],
            pole: randomUnitVector(randFloat),
            omega: randomOmega(randFloat),
            bornMyr: 0,
            parent: -1,
        });
    }
    for (let s = 0; s < sites.length; s++) plates[owner[s]].sites.push(sites[s]);
    /* a nucleus that ended up with nothing is not a plate */
    return {plates: plates.filter(p => p.sites.length > 0), nextName};
}


function makeBoundaryWarp(mesh, r_xyz, seed, opts) {
    const noise = new SimplexNoise(makeRandFloat(seed ^ 0x68bc21eb));
    const f = opts.boundaryWarpScale;
    const a = opts.boundaryWarp;
    const {numRegions} = mesh;
    /* one value per cell, so the same edge always costs the same and the
       boundary comes out as a smooth curve rather than a frayed one */
    const field = new Float32Array(numRegions);
    for (let r = 0; r < numRegions; r++) {
        field[r] = 1 + a * noise.noise3D(r_xyz[3 * r] * f, r_xyz[3 * r + 1] * f, r_xyz[3 * r + 2] * f);
    }
    return (a2, b2) => 0.5 * (field[a2] + field[b2]);
}


/* A small binary heap, so ownership can be grown outwards from the sites
 * rather than by testing every cell against every site. */
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


/* Ownership: the plate whose nearest site is nearest, grown outward from the
 * sites across the mesh.
 *
 * Doing it by testing every cell against every site costs cells times sites,
 * which puts a hard ceiling on how many sites a plate can have — and that
 * ceiling is what broke the size hierarchy, because the smallest plates in a
 * heavy-tailed distribution want less than one site each and end up with
 * none. Growing outwards instead costs the same whatever the site count, so
 * plates can have as many as they need.
 *
 * Step costs are scaled per plate, so a plate that has been gaining at its
 * ridges reaches further and one losing at its trenches reaches less; and
 * they are nudged by a smooth noise field, which bends the boundaries into
 * curves rather than leaving them as exact arcs. Earth's are not straight
 * either.
 */
function assignPlateOwnership(mesh, r_xyz, plates, warp, out) {
    const {numRegions} = mesh;
    const r_plate = out || new Int32Array(numRegions);
    const cost = new Float64Array(numRegions).fill(Infinity);
    r_plate.fill(-1);

    const out_r = [];
    const heap = [];
    let hint = 0;
    for (let p = 0; p < plates.length; p++) {
        for (const site of plates[p].sites) {
            hint = nearestRegion(mesh, r_xyz, site, hint, out_r);
            if (cost[hint] === 0) continue;
            cost[hint] = 0;
            r_plate[hint] = p;
            heapPush(heap, 0, hint);
        }
    }
    /* nothing to grow from: everything belongs to the first plate */
    if (heap.length === 0) { r_plate.fill(0); return r_plate; }

    const reach = plates.map(p => Math.max(1e-6, p.scale || 1));
    while (heap.length > 0) {
        const {cost: here, value: r} = heapPop(heap);
        if (here > cost[r]) continue;
        const p = r_plate[r];
        const k = 1 / reach[p];
        mesh.r_circulate_r(out_r, r);
        for (const nb of out_r) {
            const dot = r_xyz[3 * r] * r_xyz[3 * nb]
                + r_xyz[3 * r + 1] * r_xyz[3 * nb + 1]
                + r_xyz[3 * r + 2] * r_xyz[3 * nb + 2];
            const step = Math.acos(dot < -1 ? -1 : dot > 1 ? 1 : dot);
            const next = here + step * k * warp(r, nb);
            if (next < cost[nb]) {
                cost[nb] = next;
                r_plate[nb] = p;
                heapPush(heap, next, nb);
            }
        }
    }
    for (let r = 0; r < numRegions; r++) if (r_plate[r] === -1) r_plate[r] = 0;
    return r_plate;
}


/**********************************************************************
 * 2. Motion
 *
 * A plate is a rigid cap of a rotating sphere, so its motion is a rotation
 * about an Euler pole, not a translation. A single constant 3D vector per
 * plate can only be tangent at one point: on a sphere partitioned into 20
 * plates, that model puts more than 30% of the velocity into the radial
 * direction across a third of the surface. `omega x r` is tangent and
 * rigid everywhere by construction.
 */

/* 0.006 rad/Myr is ~0.34 deg/Myr, ~3.8 cm/yr at 90 degrees from the pole,
 * which sits mid-range for Earth's plates. */
const PLATE_OMEGA_MEAN = 0.006;
const PLATE_OMEGA_SPREAD = 0.7;

function randomUnitVector(randFloat) {
    const z = 2 * randFloat() - 1, phi = 2 * Math.PI * randFloat();
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    return [s * Math.cos(phi), s * Math.sin(phi), z];
}

function randomOmega(randFloat) {
    return PLATE_OMEGA_MEAN * Math.exp(PLATE_OMEGA_SPREAD * (2 * randFloat() - 1)) *
        (randFloat() < 0.5 ? -1 : 1);
}

/* Published plate models are quoted in a no-net-rotation frame: the plates
 * move relative to each other, not all one way. Poles sampled independently
 * leave a net drift worth about a quarter of the total motion, so subtract
 * the area-weighted mean rotation from every plate. */
function removeNetRotation(mesh, plates, r_plate) {
    const area = new Float64Array(plates.length);
    for (let r = 0; r < mesh.numRegions; r++) area[r_plate[r]]++;

    const net = [0, 0, 0];
    let total = 0;
    for (let p = 0; p < plates.length; p++) {
        vec3.scaleAndAdd(net, net, plates[p].pole, area[p] * plates[p].omega);
        total += area[p];
    }
    if (total === 0) return;
    vec3.scale(net, net, 1 / total);
    for (const plate of plates) {
        const w = vec3.scaleAndAdd([], vec3.scale([], plate.pole, plate.omega), net, -1);
        const mag = vec3.length(w);
        plate.omega = mag;
        plate.pole = mag > 1e-12 ? vec3.scale([], w, 1 / mag) : [0, 0, 1];
    }
}


/* Surface velocity of a plate at a point on the unit sphere. */
function plateVelocity(out, pole, omega, pos) {
    vec3.cross(out, pole, pos);
    return vec3.scale(out, out, omega);
}


/* Rotate v about a unit axis by `angle` radians (Rodrigues). */
function rotateAbout(out, v, axis, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const d = vec3.dot(axis, v);
    const cross = vec3.cross([], axis, v);
    out[0] = v[0] * c + cross[0] * s + axis[0] * d * (1 - c);
    out[1] = v[1] * c + cross[1] * s + axis[1] * d * (1 - c);
    out[2] = v[2] * c + cross[2] * s + axis[2] * d * (1 - c);
    return out;
}


/* Nearest mesh region to a point, by hill-climbing from a nearby region.
 * Spherical Voronoi cells are convex, so the greedy walk lands on the true
 * nearest cell provided `start` is in the neighbourhood — which it is,
 * since a plate moves only a few cells per step. */
function nearestRegion(mesh, r_xyz, x, start, out_r) {
    let current_r = start;
    let best = x[0] * r_xyz[3 * current_r] + x[1] * r_xyz[3 * current_r + 1] + x[2] * r_xyz[3 * current_r + 2];
    for (let guard = 0; guard < 64; guard++) {
        let moved = -1;
        mesh.r_circulate_r(out_r, current_r);
        for (const neighbor_r of out_r) {
            const d = x[0] * r_xyz[3 * neighbor_r] + x[1] * r_xyz[3 * neighbor_r + 1] + x[2] * r_xyz[3 * neighbor_r + 2];
            if (d > best) { best = d; moved = neighbor_r; }
        }
        if (moved === -1) break;
        current_r = moved;
    }
    return current_r;
}


/* The three kinds of margin. Without this vocabulary the generator cannot
 * tell a ridge from a trench from a strike-slip fault, which is why every
 * boundary used to look alike. */
const BOUNDARY_NONE = 0, BOUNDARY_CONVERGENT = 1, BOUNDARY_DIVERGENT = 2, BOUNDARY_TRANSFORM = 3;
const TRANSFORM_COS = 0.5;   // |normal component| below this reads as strike-slip

function classifyBoundaries(mesh, {r_xyz, r_plate, plates}) {
    const {numRegions} = mesh;
    const r_boundary = new Uint8Array(numRegions);
    const r_convergence = new Float32Array(numRegions);   // + closing, - opening
    const out_r = [];
    const va = [0, 0, 0], vb = [0, 0, 0];

    for (let current_r = 0; current_r < numRegions; current_r++) {
        const pa = [r_xyz[3 * current_r], r_xyz[3 * current_r + 1], r_xyz[3 * current_r + 2]];
        let strongest = 0, type = BOUNDARY_NONE;
        mesh.r_circulate_r(out_r, current_r);
        for (const neighbor_r of out_r) {
            if (r_plate[current_r] === r_plate[neighbor_r]) continue;
            const pb = [r_xyz[3 * neighbor_r], r_xyz[3 * neighbor_r + 1], r_xyz[3 * neighbor_r + 2]];
            const mid = vec3.normalize([], vec3.add([], pa, pb));

            /* boundary normal, in the tangent plane at the midpoint */
            const normal = vec3.subtract([], pb, pa);
            vec3.scaleAndAdd(normal, normal, mid, -vec3.dot(normal, mid));
            if (vec3.length(normal) < 1e-9) continue;
            vec3.normalize(normal, normal);

            const pa2 = plates[r_plate[current_r]], pb2 = plates[r_plate[neighbor_r]];
            plateVelocity(va, pa2.pole, pa2.omega, mid);
            plateVelocity(vb, pb2.pole, pb2.omega, mid);
            const rel = vec3.subtract([], vb, va);
            const speed = vec3.length(rel);
            if (speed < 1e-12) continue;

            /* negative = the neighbour is closing on us, positive = pulling away */
            const normalComponent = vec3.dot(rel, normal);
            if (Math.abs(normalComponent) > Math.abs(strongest)) {
                strongest = normalComponent;
                type = Math.abs(normalComponent) / speed < TRANSFORM_COS ? BOUNDARY_TRANSFORM
                    : normalComponent < 0 ? BOUNDARY_CONVERGENT : BOUNDARY_DIVERGENT;
            }
        }
        r_boundary[current_r] = type;
        r_convergence[current_r] = -strongest;
    }
    return {r_boundary, r_convergence};
}


/**********************************************************************
 * 3. Simulation
 *
 * The distance-field blend this replaces makes a plausible snapshot but
 * has no history: nothing carries from one configuration to the next, so
 * it cannot produce a passive margin, a basin that deepens away from its
 * ridge, or a belt where two continents met.
 *
 * Here the crust is the state. Each step the plates rotate about their
 * poles and carry their crust with them; where they open a gap new ocean
 * floor forms at age zero, where they converge the denser side is
 * consumed, and where two continents meet the crust thickens and the
 * plates weld. The initial crust type comes from a noise field rather
 * than the plate partition, so a plate can carry a continent and an ocean
 * at once the way the North American plate does.
 */

const CRUST_OCEANIC = 0, CRUST_CONTINENTAL = 1;

const DEFAULTS = {
    steps: 20,
    nucleusSeparation: 0.45,      // radians between plate nuclei at birth
    sitesPerPlate: 26,            // enough that even the smallest plate in a
                                  // heavy-tailed size distribution gets several, and
                                  // enough that shapes are not convex caps
    boundaryWarp: 0.35,           // how far the boundary curves away from a true arc
    boundaryWarpScale: 1.6,       // low frequency: bend the boundary, do not fray it
    plateGrowth: 0.05,            // how fast a plate gains at its ridges and loses at
                                  // its trenches; this is what lets a mostly-subducting
                                  // plate shrink away, as the Farallon did
    plateReversion: 0.12,         // pull back towards its own size; must exceed
                                  // plateGrowth or the feedback has no equilibrium
    plateRetireArea: 0.0015,       // a plate smaller than this is absorbed by its neighbours
    stepMyr: 10,                  // 200 Myr of history
    cratons: 6,                   // continental nuclei; Earth has about this many blocks
    cratonSigma: 0.55,            // spread of craton sizes, so they are not all alike
    cratonWarp: 0.68,             // how ragged the edge of a craton is
    cratonClustering: 0.62,       // chance a craton huddles against the others
    cratonMinSeparation: 0.55,    // radians; stops two cratons landing on each other
    crustSmoothing: 1,            // smoothing of the craton edge warp
    continentFraction: 0.44,      // Earth: continental crust is ~41% of the
                                  // surface, of which ~29% is dry land
    crustReferenceKm: 31,         // thickness undisturbed continental crust relaxes towards
    seaLevelThicknessKm: 26,      // thickness that floats exactly at sea level
    crustOceanKm: 7,
    crustMinKm: 22,               // fully rifted margin
    crustMaxKm: 68,               // Tibet
    crustInitialPeakKm: 33,       // craton cores; Earth's interiors are a few hundred
                                  // metres up, not the kilometres a thicker core implies
    shelfThinningKm: 0.15,         // per step, at a rifting margin
    collisionThickenKm: 0.9,      // per step, continent against continent
    collisionThrust: 0.34,        // share of an overridden column thrust onto the winner
    riftThinKm: 3.0,              // how much a margin thins per step of stretching.
                                  // Thinning by a *fraction* instead halves a cell every
                                  // step it spends on a divergent boundary, which leaves
                                  // half the continental crust too thin to stand above
                                  // sea level
    crustBreakKm: 9,              // thinner than this and the margin has broken: sea floor
    riftIntactShare: 0.80,        // only crust this fraction of reference thickness stretches
    emergentFraction: 0.71,       // share of continental crust starting above sea level
    orogenyDecay: 0.88,           // erosion between steps
    orogenyReliefM: 2200,         // extra relief at full orogeny, on top of isostasy
    rootRelax: 0.030,             // crustal roots relax back towards normal
    arcOceanic: 0.55,             // island arc over ocean-ocean subduction
    arcContinental: 0.85,         // Andean arc over ocean-continent
    orogenyAndean: 0.5,
    orogenyCollision: 1.0,
    weldContact: 0.30,            // accumulated contact needed to fuse two plates,
                                  // as a multiple of the whole surface
    contactDecay: 0.75,           // contact fades once two plates stop converging
    riftChance: 0.12,             // per step, chance of deliberately splitting a big
                                  // plate. Kept low because plates being cut in two by
                                  // their neighbours already supplies most of the churn
    riftMinArea: 0.12,            // only plates larger than this can rift
    coastBlend: 1,                // relaxation rings across the continental margin
    healPasses: 2,                // majority-filter passes that keep plates coherent
    minFragment: 0.014,           // a detached piece smaller than this is absorbed by
                                  // its neighbours instead of becoming a plate
    detailNoise: 0.06,
};


function makeFbm(noise, octaves, persistence = 2 / 3) {
    const amplitudes = Array.from({length: octaves}, (_, o) => Math.pow(persistence, o));
    const total = amplitudes.reduce((a, b) => a + b, 0);
    return (nx, ny, nz) => {
        let sum = 0;
        for (let octave = 0; octave < octaves; octave++) {
            const f = 1 << octave;
            sum += amplitudes[octave] * noise.noise3D(nx * f, ny * f, nz * f);
        }
        return sum / total;
    };
}


/* Continental crust as a noise field thresholded to the target area, with
 * thickness tapering towards the edges so margins start as shelves rather
 * than cliffs. Deliberately independent of the plate partition. */
/* Where the continents start.
 *
 * Thresholding a noise field looks like the obvious way to do this, and it is
 * what this used to do. It does not work: at the ~40% coverage continental
 * crust needs, a thresholded isotropic field sits right at the percolation
 * threshold, and that regime produces stringy maze-like land spread evenly
 * over the whole sphere. No seed escapes it.
 *
 * Earth's continents are not a noise threshold. They are a handful of compact
 * cratons, unequal in size, clustered into one hemisphere — which is why the
 * Pacific is a third of the planet with nothing in it. So place cratons and
 * grow them, and use noise only to make their edges irregular.
 */
function placeCratons(mesh, r_xyz, count, randFloat, opts) {
    const centres = [];
    const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, vec3.dot(a, b))));

    for (let k = 0; k < count; k++) {
        if (centres.length === 0) { centres.push(randomUnitVector(randFloat)); continue; }
        /* Candidates far enough out not to sit on top of an existing craton.
         * Then either hug the existing group or strike out on its own: the
         * clustering bias is what leaves one big empty ocean instead of
         * spreading the land evenly around the sphere. */
        const candidates = [];
        for (let attempt = 0; attempt < 64 && candidates.length < 12; attempt++) {
            const c = randomUnitVector(randFloat);
            let nearest = Infinity;
            for (const o of centres) nearest = Math.min(nearest, angle(c, o));
            if (nearest < opts.cratonMinSeparation) continue;
            candidates.push({c, nearest});
        }
        if (candidates.length === 0) { centres.push(randomUnitVector(randFloat)); continue; }
        const huddle = randFloat() < opts.cratonClustering;
        candidates.sort((a, b) => huddle ? a.nearest - b.nearest : b.nearest - a.nearest);
        centres.push(candidates[0].c);
    }

    /* Unequal sizes, the way Eurasia dwarfs Australia. */
    const gauss = () => {
        const u1 = Math.max(1e-9, randFloat()), u2 = randFloat();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const weights = centres.map(() => Math.exp(opts.cratonSigma * gauss()));
    const total = weights.reduce((a, b) => a + b, 0) || 1;

    /* Radius of a spherical cap holding this craton's share of the target
     * continental area: cap fraction = (1 - cos R) / 2. */
    const radii = weights.map(w => {
        const share = opts.continentFraction * w / total;
        return Math.acos(Math.max(-1, 1 - 2 * share));
    });
    return {centres, radii};
}


function initCrust(mesh, r_xyz, seed, opts) {
    const {numRegions} = mesh;
    const randFloat = makeRandFloat(seed ^ 0x2545f491);
    const warpNoise = makeFbm(new SimplexNoise(makeRandFloat(seed ^ 0x27d4eb2f)), 4, 0.55);

    const r_crust_type = new Uint8Array(numRegions);
    const r_crust_age = new Float32Array(numRegions);
    const r_thickness = new Float32Array(numRegions);
    const r_orogeny = new Float32Array(numRegions);
    const r_arc = new Float32Array(numRegions);

    const {centres, radii} = placeCratons(mesh, r_xyz, opts.cratons, randFloat, opts);

    /* Distance to the nearest craton centre, in units of that craton's radius,
     * warped by noise so the coastline is ragged rather than circular.
     * Below 1 is continental crust; 0 is the deep interior. */
    const depth = new Float32Array(numRegions);
    const warp = new Float32Array(numRegions);
    for (let r = 0; r < numRegions; r++) {
        warp[r] = 1 + opts.cratonWarp * warpNoise(r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2]);
    }
    smoothField(mesh, warp, null, opts.crustSmoothing);

    const p = [0, 0, 0];
    const measure = (scale) => {
        let inside = 0;
        for (let r = 0; r < numRegions; r++) {
            p[0] = r_xyz[3 * r]; p[1] = r_xyz[3 * r + 1]; p[2] = r_xyz[3 * r + 2];
            let best = Infinity;
            for (let k = 0; k < centres.length; k++) {
                const a = Math.acos(Math.max(-1, Math.min(1, vec3.dot(p, centres[k]))));
                best = Math.min(best, a / (radii[k] * scale));
            }
            depth[r] = best * warp[r];
            if (depth[r] < 1) inside++;
        }
        return inside / numRegions;
    };

    /* Warping changes how much area the cratons actually cover, so bisect a
     * global scale on the radii until the continental fraction comes out
     * where it was asked for. */
    let lo = 0.4, hi = 2.2;
    for (let iter = 0; iter < 18; iter++) {
        const mid = (lo + hi) / 2;
        if (measure(mid) < opts.continentFraction) lo = mid; else hi = mid;
    }
    measure((lo + hi) / 2);

    /* Sea level sits at the radius enclosing `emergentFraction` of a craton's
     * area. Area grows as the square of the radius, hence the square root. */
    const shore = Math.sqrt(clamp01(opts.emergentFraction));
    for (let r = 0; r < numRegions; r++) {
        const d = depth[r];
        if (d >= 1) {
            r_crust_type[r] = CRUST_OCEANIC;
            r_thickness[r] = opts.crustOceanKm;
            continue;
        }
        r_crust_type[r] = CRUST_CONTINENTAL;
        r_thickness[r] = d < shore
            /* interior: thickest at the craton's core, thinning outward */
            ? opts.seaLevelThicknessKm + (opts.crustInitialPeakKm - opts.seaLevelThicknessKm) *
              Math.pow(1 - d / shore, 0.7)
            /* the shelf, between the shoreline and the edge of the craton */
            : opts.crustMinKm + (opts.seaLevelThicknessKm - opts.crustMinKm) * (1 - d) / (1 - shore);
    }
    return {r_crust_type, r_crust_age, r_thickness, r_orogeny, r_arc};
}


/* One timestep.
 *
 * The plates turn about their poles, carrying their sites with them, and
 * ownership is rebuilt from those sites. Because the partition is always a
 * Voronoi of rigid bodies, the plates stay coherent no matter how long the
 * model runs — the previous version advected ownership cell by cell, which
 * shredded the map into slivers and needed a repair pass to hide it.
 *
 * The crust is a separate matter: it is carried by whichever plate holds it
 * and is created and destroyed at the boundaries.
 */
function stepTectonics(mesh, map, opts) {
    const {r_xyz, plates} = map;
    const {numRegions} = mesh;
    const dtMyr = opts.stepMyr;

    const prevPlate = map.r_plate;
    const prevType = map.r_crust_type, prevAge = map.r_crust_age,
          prevThickness = map.r_thickness, prevOrogeny = map.r_orogeny, prevArc = map.r_arc;

    /* Which way is each boundary moving, before anything turns? */
    const {r_boundary} = classifyBoundaries(mesh, map);

    /* Turn the plates. */
    for (const plate of plates) {
        const angle = plate.omega * dtMyr;
        plate.sites = plate.sites.map(s => rotateAbout([], s, plate.pole, angle));
    }
    const nextPlate = assignPlateOwnership(mesh, r_xyz, plates, map.boundaryWarp);

    const nextType = new Uint8Array(numRegions);
    const nextAge = new Float32Array(numRegions);
    const nextThickness = new Float32Array(numRegions);
    const nextOrogeny = new Float32Array(numRegions);
    const nextArc = new Float32Array(numRegions);

    const collisions = new Map();     // "a,b" -> cells of continent-continent contact
    const gained = new Int32Array(plates.length);
    const lost = new Int32Array(plates.length);
    const out_r = [];
    const back = [0, 0, 0], x = [0, 0, 0];

    for (let r = 0; r < numRegions; r++) {
        const now = nextPlate[r];
        const plate = plates[now];
        x[0] = r_xyz[3 * r]; x[1] = r_xyz[3 * r + 1]; x[2] = r_xyz[3 * r + 2];

        /* Where was the crust that is under this point now? Back along the
         * owning plate's rotation. */
        rotateAbout(back, x, plate.pole, -plate.omega * dtMyr);
        const source_r = nearestRegion(mesh, r_xyz, back, r, out_r);

        /* What happens to the crust depends on what the boundary here is
         * doing, not on whether the cell changed hands. Ownership is also
         * renumbered when plates split, weld or absorb a scrap, and reading
         * those bookkeeping changes as subduction shreds the continents. */
        if (r_boundary[r] === BOUNDARY_DIVERGENT) {
            /* The plates are pulling apart here. But a rift does not become
             * sea floor the moment it opens: it first draws the neighbouring
             * continent out into it, thinning it. That stretched crust is a
             * hyperextended margin, and it is what gives a passive margin its
             * width. Only once it has thinned past breaking does the opening
             * flood. */
            const stretched = prevType[source_r] === CRUST_CONTINENTAL
                ? prevThickness[source_r] - opts.riftThinKm : 0;
            if (stretched > opts.crustBreakKm) {
                nextType[r] = CRUST_CONTINENTAL;
                nextThickness[r] = stretched;
                nextAge[r] = prevAge[source_r] + dtMyr;
                nextOrogeny[r] = prevOrogeny[source_r] * opts.orogenyDecay;
            } else {
                nextType[r] = CRUST_OCEANIC;
                nextAge[r] = 0;
                nextThickness[r] = opts.crustOceanKm;
            }
            gained[now]++;
            continue;
        }

        /* Everywhere else the crust simply travels with its plate. */
        nextType[r] = prevType[source_r];
        nextAge[r] = prevAge[source_r] + dtMyr;
        nextThickness[r] = prevThickness[source_r];
        nextOrogeny[r] = prevOrogeny[source_r] * opts.orogenyDecay;
        nextArc[r] = prevArc[source_r] * opts.orogenyDecay;
        if (r_boundary[r] === BOUNDARY_CONVERGENT) lost[nextPlate[r]]++;
    }

    /* Arcs and belts are built along a margin for as long as it is
     * converging, not only in the step when the boundary happens to sweep
     * past a cell. Ownership under a Voronoi partition changes hands over a
     * band a cell or two wide per step, so tying mountain building to that
     * band alone leaves a planet with almost no relief. The Andes are raised
     * continuously above a subducting slab; so are these. */
    {
        const boundaryNow = classifyBoundaries(mesh, {r_xyz, r_plate: nextPlate, plates}).r_boundary;
        for (let r = 0; r < numRegions; r++) {
            if (boundaryNow[r] !== BOUNDARY_CONVERGENT) continue;
            const mine = nextPlate[r];
            mesh.r_circulate_r(out_r, r);
            let facingContinental = false, facingOceanic = false, oldestFacing = -1, other = -1;
            for (const nb of out_r) {
                if (nextPlate[nb] === mine) continue;
                if (nextType[nb] === CRUST_CONTINENTAL) facingContinental = true;
                else { facingOceanic = true; oldestFacing = Math.max(oldestFacing, nextAge[nb]); }
                other = nextPlate[nb];
            }
            if (other === -1) continue;

            if (nextType[r] === CRUST_CONTINENTAL && facingContinental) {
                /* two continents meeting: the crust shortens and thickens */
                nextThickness[r] = Math.min(opts.crustMaxKm, nextThickness[r] + opts.collisionThickenKm);
                nextOrogeny[r] = Math.min(2, nextOrogeny[r] + opts.orogenyCollision);
                const key = other < mine ? `${other},${mine}` : `${mine},${other}`;
                collisions.set(key, (collisions.get(key) || 0) + 1);
            } else if (nextType[r] === CRUST_CONTINENTAL && facingOceanic) {
                /* ocean going down beneath a continent: an Andean margin */
                nextArc[r] = Math.min(2, nextArc[r] + opts.arcContinental);
                nextOrogeny[r] = Math.min(2, nextOrogeny[r] + opts.orogenyAndean);
                nextThickness[r] = Math.min(opts.crustMaxKm, nextThickness[r] + 0.35);
            } else if (nextType[r] === CRUST_OCEANIC && facingOceanic && nextAge[r] < oldestFacing) {
                /* the younger, lighter slab stays up and carries the arc */
                nextArc[r] = Math.min(2, nextArc[r] + opts.arcOceanic);
            }
        }
    }

    /* Continental crust against brand new ocean floor is a rifting margin:
     * stretching thins it, which is what turns it into a shelf. */
    for (let r = 0; r < numRegions; r++) {
        if (nextType[r] !== CRUST_CONTINENTAL) continue;
        mesh.r_circulate_r(out_r, r);
        for (const neighbor_r of out_r) {
            if (nextType[neighbor_r] === CRUST_OCEANIC && nextAge[neighbor_r] === 0) {
                nextThickness[r] = Math.max(opts.crustMinKm, nextThickness[r] - opts.shelfThinningKm);
                break;
            }
        }
        /* roots relax back towards normal as the belt above them erodes */
        nextThickness[r] += (opts.crustReferenceKm - nextThickness[r]) * opts.rootRelax;
    }

    /* A plate grows at its ridges and shrinks at its trenches. Let that feed
     * back into how much of the sphere it claims, so a plate that is mostly
     * being consumed dwindles and finally goes, the way the Farallon did. */
    for (let p = 0; p < plates.length; p++) {
        /* Measured as a share of this plate's own boundary, not as raw cell
         * counts. Counting cells makes the term scale with plate size, so the
         * biggest plate has the longest ridges, gains the most, and grows
         * without limit until it has eaten the map. What matters is the
         * balance along a plate's own edge: all ridge and it grows, all
         * trench and it goes the way of the Farallon. */
        const edge = gained[p] + lost[p];
        const balance = edge > 0 ? (gained[p] - lost[p]) / edge : 0;
        const plate = plates[p];
        plate.scale = (plate.scale || 1) * (1 + opts.plateGrowth * balance);
        /* and pulled back towards its own size. Without this a plate whose
         * edge happens to be all ridge grows for the whole run and ends up
         * owning the map; the reversion has to be the stronger term or there
         * is no equilibrium at all. */
        plate.scale += (1 - plate.scale) * opts.plateReversion;
        plate.scale = Math.max(0.5, Math.min(1.7, plate.scale));
    }

    map.r_plate = nextPlate;
    map.r_crust_type = nextType;
    map.r_crust_age = nextAge;
    map.r_thickness = nextThickness;
    map.r_orogeny = nextOrogeny;
    map.r_arc = nextArc;
    return collisions;
}


/* Each plate turns about its own pole, so after enough differential rotation
 * two plates' site clouds interleave and a plate can end up in pieces.
 *
 * A plate in two pieces is not a bookkeeping error to be papered over — it
 * is something that happens, and what follows is that the pieces stop being
 * one plate. So make it official: the main body keeps the name, a piece big
 * enough to stand on its own becomes a plate in its own right with its own
 * pole and its own birthday, and a scrap is absorbed by whatever surrounds
 * it. Nothing is left disconnected.
 */
function resolvePlateBodies(mesh, map, randFloat, opts) {
    const {plates, r_plate, r_xyz} = map;
    const {numRegions} = mesh;
    const out_r = [];

    /* label connected runs of single-plate territory */
    const component = new Int32Array(numRegions).fill(-1);
    const compPlate = [], compSize = [];
    for (let r = 0; r < numRegions; r++) {
        if (component[r] !== -1) continue;
        const p = r_plate[r];
        const id = compPlate.length;
        compPlate.push(p);
        const queue = [r];
        component[r] = id;
        for (let h = 0; h < queue.length; h++) {
            mesh.r_circulate_r(out_r, queue[h]);
            for (const nb of out_r) {
                if (component[nb] === -1 && r_plate[nb] === p) { component[nb] = id; queue.push(nb); }
            }
        }
        compSize.push(queue.length);
    }

    /* the biggest run of each plate is the plate proper */
    const mainComp = new Int32Array(plates.length).fill(-1);
    for (let c = 0; c < compPlate.length; c++) {
        const p = compPlate[c];
        if (mainComp[p] === -1 || compSize[c] > compSize[mainComp[p]]) mainComp[p] = c;
    }

    /* who should swallow a scrap: the neighbour it shares most edge with */
    const adopter = new Map();
    for (let c = 0; c < compPlate.length; c++) {
        if (c === mainComp[compPlate[c]]) continue;
        if (compSize[c] >= opts.minFragment * numRegions) continue;
        adopter.set(c, new Map());
    }
    if (adopter.size > 0) {
        for (let r = 0; r < numRegions; r++) {
            const tally = adopter.get(component[r]);
            if (!tally) continue;
            mesh.r_circulate_r(out_r, r);
            for (const nb of out_r) {
                if (component[nb] === component[r]) continue;
                tally.set(r_plate[nb], (tally.get(r_plate[nb]) || 0) + 1);
            }
        }
    }

    /* a substantial piece becomes a plate of its own */
    const newPlateOf = new Map();
    for (let c = 0; c < compPlate.length; c++) {
        const p = compPlate[c];
        if (c === mainComp[p]) continue;
        if (compSize[c] < opts.minFragment * numRegions) continue;
        const parent = plates[p];
        const born = {
            id: map.nextPlateId++,
            name: map.nextName(),
            sites: [],
            pole: randomUnitVector(randFloat),
            omega: randomOmega(randFloat),
            scale: parent.scale || 1,
            bornMyr: map.elapsedMyr,
            parent: parent.id,
        };
        plates.push(born);
        newPlateOf.set(c, plates.length - 1);
    }

    /* every cell follows its own piece */
    let changed = newPlateOf.size > 0;
    for (let r = 0; r < numRegions; r++) {
        const c = component[r];
        if (newPlateOf.has(c)) { r_plate[r] = newPlateOf.get(c); continue; }
        const tally = adopter.get(c);
        if (!tally || tally.size === 0) continue;
        let best = -1, bestCount = -1;
        for (const [q, count] of tally) if (count > bestCount) { bestCount = count; best = q; }
        r_plate[r] = best;
        changed = true;
    }
    if (!changed) return false;

    /* and the sites follow the ground they now stand on */
    const carried = plates.map(() => []);
    for (let p = 0; p < plates.length; p++) {
        for (const site of plates[p].sites) {
            const r = nearestRegion(mesh, r_xyz, site, 0, out_r);
            carried[r_plate[r]].push(site);
        }
    }
    for (let p = 0; p < plates.length; p++) plates[p].sites = carried[p];
    return true;
}


/* Two continents that have been colliding for a while stop being two
 * plates. This is what assembles supercontinents. The absorbing plate keeps
 * its name and its identity; the absorbed one's sites join it, so the
 * boundary between them simply stops existing. */
function weldPlates(mesh, map, collisions, opts) {
    const {plates} = map;
    const area = new Int32Array(plates.length);
    for (let r = 0; r < mesh.numRegions; r++) area[map.r_plate[r]]++;

    /* Welding on one step's contact makes it a function of how long the
     * shared boundary is, so big plates fuse the moment they touch. A suture
     * takes time: accumulate contact between the same pair across steps, and
     * let it fade when they stop pressing on each other. */
    const contact = map.contact || (map.contact = new Map());
    for (const [key, value] of contact) contact.set(key, value * opts.contactDecay);
    for (const [key, count] of collisions) {
        contact.set(key, (contact.get(key) || 0) + count);
    }
    const threshold = opts.weldContact * mesh.numRegions;

    const absorbedBy = new Map();
    const resolve = (p) => { while (absorbedBy.has(p)) p = absorbedBy.get(p); return p; };
    for (const [key, count] of contact) {
        if (count < threshold) continue;
        contact.delete(key);
        let [a, b] = key.split(',').map(Number);
        if (a >= plates.length || b >= plates.length) continue;
        a = resolve(a); b = resolve(b);
        if (a === b) continue;
        if (area[a] < area[b]) { const t = a; a = b; b = t; }
        absorbedBy.set(b, a);
    }
    if (absorbedBy.size === 0) return false;

    for (const [b, _] of absorbedBy) {
        const into = resolve(b);
        plates[into].sites = plates[into].sites.concat(plates[b].sites);
        plates[b].sites = [];
        plates[b].absorbedInto = plates[into].id;
    }
    return true;
}


/* Without this the plate count only ever falls. A plate splits along a
 * great circle through its centroid; the larger half keeps the name, the
 * smaller half is a new plate with its own pole, so the two drift apart. */
function riftPlate(mesh, map, randFloat, opts) {
    const {plates} = map;
    const area = new Int32Array(plates.length);
    for (let r = 0; r < mesh.numRegions; r++) area[map.r_plate[r]]++;

    const eligible = [];
    for (let p = 0; p < plates.length; p++) {
        if (plates[p].sites.length >= 4 && area[p] / mesh.numRegions > opts.riftMinArea) eligible.push(p);
    }
    if (eligible.length === 0) return false;
    const target = eligible[Math.min(eligible.length - 1, Math.floor(randFloat() * eligible.length))];
    const plate = plates[target];

    const centroid = [0, 0, 0];
    for (const s of plate.sites) vec3.add(centroid, centroid, s);
    if (vec3.length(centroid) < 1e-9) return false;
    vec3.normalize(centroid, centroid);

    const cut = randomUnitVector(randFloat);
    vec3.scaleAndAdd(cut, cut, centroid, -vec3.dot(cut, centroid));
    if (vec3.length(cut) < 1e-6) return false;
    vec3.normalize(cut, cut);

    const near = [], far = [];
    for (const s of plate.sites) (vec3.dot(s, cut) > 0 ? far : near).push(s);
    if (near.length === 0 || far.length === 0) return false;

    const keep = near.length >= far.length ? near : far;
    const split = near.length >= far.length ? far : near;
    plate.sites = keep;

    plates.push({
        id: map.nextPlateId++,
        name: map.nextName(),
        sites: split,
        pole: randomUnitVector(randFloat),
        omega: randomOmega(randFloat),
        scale: plate.scale || 1,
        bornMyr: map.elapsedMyr,
        parent: plate.id,
    });
    return true;
}


/* A plate worn down to nothing stops being a plate. Its remaining sites go
 * to whoever is nearest, which is what subduction does to a plate in the
 * end. */
function retirePlates(mesh, map, opts) {
    const {plates} = map;
    const area = new Int32Array(plates.length);
    for (let r = 0; r < mesh.numRegions; r++) area[map.r_plate[r]]++;

    let changed = false;
    for (let p = 0; p < plates.length; p++) {
        if (plates[p].sites.length === 0) continue;
        if (area[p] / mesh.numRegions >= opts.plateRetireArea) continue;
        /* The whole remnant goes to one neighbour, not site by site to
         * whoever is nearest: splitting it up drops stray sites into distant
         * plates and leaves those plates in two pieces. */
        let best = -Infinity, pick = -1;
        for (let q = 0; q < plates.length; q++) {
            if (q === p || plates[q].sites.length === 0) continue;
            for (const s of plates[p].sites) {
                for (const t of plates[q].sites) {
                    const d = s[0] * t[0] + s[1] * t[1] + s[2] * t[2];
                    if (d > best) { best = d; pick = q; }
                }
            }
        }
        if (pick !== -1) plates[pick].sites = plates[pick].sites.concat(plates[p].sites);
        plates[p].sites = [];
        plates[p].retiredMyr = map.elapsedMyr;
        changed = true;
    }
    return changed;
}


/* Plates that have lost all their sites are gone. Compact the list and
 * renumber the ownership field to match, keeping ids and names intact. */
function compactPlates(map) {
    const {plates} = map;
    const remap = new Int32Array(plates.length).fill(-1);
    const kept = [];
    for (let p = 0; p < plates.length; p++) {
        if (plates[p].sites.length === 0) continue;
        remap[p] = kept.length;
        kept.push(plates[p]);
    }
    if (kept.length === plates.length) return;
    /* anything pointing at a departed plate follows it to whoever took over */
    for (let r = 0; r < map.r_plate.length; r++) {
        const to = remap[map.r_plate[r]];
        map.r_plate[r] = to === -1 ? 0 : to;
    }
    map.plates = kept;
}


/* Half-space cooling: ocean floor sinks as it ages away from its ridge.
 * This single relation is what produces mid-ocean ridges and abyssal
 * plains, and it is exactly what a distance field to "ocean seeds" cannot
 * imitate. Ridge crest 2600 m, old floor levelling off near 5650 m. */
function oceanDepthMeters(ageMyr) {
    return 5650 - 3050 * Math.exp(-Math.max(0, ageMyr) / 62.8);
}


/* Airy isostasy: thicker crust floats higher, at about 145 m of elevation
 * per km of crust. Which thickness floats at sea level depends on how much
 * water the planet has, so it is a dial of its own rather than being tied
 * to the thickness the crust relaxes towards. */
function continentHeightMeters(thicknessKm, opts) {
    return (thicknessKm - opts.seaLevelThicknessKm) * 145;
}


function crustToElevation(mesh, map, seed, opts) {
    const {r_xyz, r_crust_type, r_crust_age, r_thickness, r_orogeny, r_arc, r_boundary, r_elevation} = map;
    const {numRegions} = mesh;
    const detail = makeFbm(new SimplexNoise(makeRandFloat(seed)), 5);

    /* Smooth thickness within each crust type, so a margin keeps its taper
       instead of being averaged against 7 km of ocean crust. */
    const thickness = smoothField(mesh, Float32Array.from(r_thickness), r_crust_type, 2);

    /* Each column stands on its own crust: continental crust floats by
       isostasy, ocean floor sits at the depth its age has cooled it to. */
    const meters = new Float32Array(numRegions);
    for (let r = 0; r < numRegions; r++) {
        if (r_crust_type[r] === CRUST_CONTINENTAL) {
            meters[r] = continentHeightMeters(thickness[r], opts)
                + opts.orogenyReliefM * r_orogeny[r] + 700 * r_arc[r];
        } else {
            meters[r] = -oceanDepthMeters(r_crust_age[r]);
            /* volcanic arcs build islands out of the sea floor */
            meters[r] += 3200 * r_arc[r];
            /* and the trench in front of one is the deepest thing on the planet */
            if (r_boundary && r_boundary[r] === BOUNDARY_CONVERGENT) {
                meters[r] -= 1500 * (1 - clamp01(r_arc[r]));
            }
        }
    }

    /* Then relax the whole field across crust types. This is what turns the
       step at a margin into a shelf, a slope and a rise, and it is why the
       coastline lands on an interpolated contour rather than tracing the
       crust-type boundary — let alone a plate outline. Keep it narrow: a
       wide blend averages a margin against the abyssal plain and drowns it. */
    smoothField(mesh, meters, null, opts.coastBlend);

    for (let r = 0; r < numRegions; r++) {
        r_elevation[r] = metersToElevation(meters[r]) +
            opts.detailNoise * detail(r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2]);
    }
}


/* Runs the whole model and leaves r_elevation, the crust fields and the
 * boundary classification on `map`. */
function simulateTectonics(mesh, map, seed, options) {
    const opts = Object.assign({}, DEFAULTS, options);
    const randFloat = makeRandFloat(seed ^ 0x85ebca6b);

    map.boundaryWarp = map.boundaryWarp || makeBoundaryWarp(mesh, map.r_xyz, seed, opts);
    map.nextPlateId = map.nextPlateId ?? map.plates.length;
    map.elapsedMyr = 0;
    for (const plate of map.plates) plate.scale = plate.scale || 1;

    map.r_plate = assignPlateOwnership(mesh, map.r_xyz, map.plates, map.boundaryWarp);
    /* Filling quotas nearest-first can leave a plate in two pieces before the
     * clock has even started, so settle the bodies once at birth too. */
    if (resolvePlateBodies(mesh, map, randFloat, opts)) {
        compactPlates(map);
        map.r_plate = assignPlateOwnership(mesh, map.r_xyz, map.plates, map.boundaryWarp, map.r_plate);
    }
    removeNetRotation(mesh, map.plates, map.r_plate);
    Object.assign(map, initCrust(mesh, map.r_xyz, seed, opts));

    for (let step = 0; step < opts.steps; step++) {
        map.elapsedMyr += opts.stepMyr;
        const collisions = stepTectonics(mesh, map, opts);

        let changed = weldPlates(mesh, map, collisions, opts);
        if (randFloat() < opts.riftChance && riftPlate(mesh, map, randFloat, opts)) changed = true;
        if (retirePlates(mesh, map, opts)) changed = true;
        if (resolvePlateBodies(mesh, map, randFloat, opts)) {
            compactPlates(map);
            map.r_plate = assignPlateOwnership(mesh, map.r_xyz, map.plates, map.boundaryWarp, map.r_plate);
        }
        if (opts.onStep) opts.onStep(step, map);
        if (changed) {
            compactPlates(map);
            map.r_plate = assignPlateOwnership(mesh, map.r_xyz, map.plates, map.boundaryWarp, map.r_plate);
            removeNetRotation(mesh, map.plates, map.r_plate);
        }
    }

    Object.assign(map, classifyBoundaries(mesh, map));
    crustToElevation(mesh, map, seed, opts);
    return map;
}


module.exports = {
    DEFAULTS,
    assignPlateOwnership, makeBoundaryWarp,
    BOUNDARY_NONE, BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM,
    CRUST_OCEANIC, CRUST_CONTINENTAL,
    LAND_PEAK_M, LAND_POWER, OCEAN_DEPTH_M, OCEAN_POWER,
    elevationToMeters, metersToElevation,
    clamp01, smoothField,
    generatePlates, removeNetRotation,
    plateVelocity, rotateAbout, nearestRegion,
    classifyBoundaries,
    oceanDepthMeters, continentHeightMeters,
    simulateTectonics,
};
