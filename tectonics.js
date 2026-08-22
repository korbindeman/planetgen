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


function q9(x) {
    return Math.round(x * 1e9) / 1e9;
}

function angleBetween(a, b) {
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    return q9(Math.acos(dot));
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
    pairs.sort((a, b) => a.d - b.d || a.s - b.s || a.p - b.p);

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

    /* Majors and minors are not the same kind of thing, so they are not
     * seeded the same way. Earth's majors tile the whole sphere between
     * them; its minors — Cocos, Caribbean, Juan de Fuca, Scotia — are
     * slivers pinched off *at the boundaries between majors*, mostly where
     * those majors converge. Seeding every plate from its own free-standing
     * nucleus instead drops minors into the middle of majors, where they sit
     * as enclaves with a single neighbour: a thing Earth does not have. */
    const targets = plateAreaTargets(numPlates, randFloat);
    const numMajor = Math.max(1, Math.min(numPlates, Math.round(numPlates * PLATE_MAJOR_FRACTION)));
    const majorTargets = targets.slice(0, numMajor);
    const majorSum = majorTargets.reduce((a, b) => a + b, 0) || 1;

    /* nuclei kept apart, so no two plates start life fighting over the same
       patch of sphere */
    const nuclei = [];
    for (let p = 0; p < numMajor; p++) {
        let best = null, bestGap = -1;
        for (let attempt = 0; attempt < 32; attempt++) {
            const c = randomUnitVector(randFloat);
            let gap = Infinity;
            for (const o of nuclei) gap = Math.min(gap, angleBetween(c, o));
            if (gap > bestGap || (gap === bestGap && best == null)) { bestGap = gap; best = c; }
            if (gap > opts.nucleusSeparation) break;
        }
        nuclei.push(best);
    }
    const sites = scatterSites(numPlates * opts.sitesPerPlate, randFloat);
    /* the majors take the whole sphere between them; the minors are carved
       back out of their edges afterwards */
    const owner = assignSitesToPlates(sites, nuclei, majorTargets.map(t => t / majorSum));

    const plates = [];
    for (let p = 0; p < numMajor; p++) {
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
    carveMicroplates(plates, sites, owner, targets.slice(numMajor), opts, randFloat, nextName);
    for (let s = 0; s < sites.length; s++) plates[owner[s]].sites.push(sites[s]);
    /* a nucleus that ended up with nothing is not a plate */
    return {plates: plates.filter(p => p.sites.length > 0), nextName,
            /* the census the simulation keeps the planet topped up to */
            targetPlateCount: numPlates};
}


/* Carve the minor plates out of the boundaries between majors.
 *
 * Every candidate location is the midpoint of a tight cross-plate site
 * pair — a spot the boundary actually passes through — so a microplate is
 * born touching at least two majors and cannot be an enclave. Candidates
 * where the two majors are closing on each other are preferred, because
 * that is where Earth keeps its microplates: trapped in the vice between
 * converging plates, shedding island arcs. And the sites a minor takes are
 * gathered anisotropically, stretched along the boundary, so it comes out
 * as a sliver hugging the margin rather than a round cap punched into one
 * side. */
function carveMicroplates(plates, sites, owner, minorTargets, opts, randFloat, nextName) {
    const n = sites.length;
    if (minorTargets.length === 0 || plates.length < 2) return;

    /* the boundary network, as tight cross-plate site pairs */
    const pairs = [];
    for (let s = 0; s < n; s++) {
        let best = -1, bestD = Infinity;
        for (let t = 0; t < n; t++) {
            if (owner[t] === owner[s]) continue;
            const d = angleBetween(sites[s], sites[t]);
            if (d < bestD || (d === bestD && t < best)) { bestD = d; best = t; }
        }
        if (best !== -1 && s < best) pairs.push({s, t: best, d: bestD});
        else if (best !== -1 && !pairs.some(q => q.s === best && q.t === s)) pairs.push({s: best, t: s, d: bestD});
    }
    pairs.sort((a, b) => a.d - b.d || a.s - b.s || a.t - b.t);
    /* the tightest pairs straddle the boundary; the loose tail merely faces
       it from a distance */
    const candidates = pairs.slice(0, Math.max(minorTargets.length * 3, pairs.length >> 1));

    const va = [0, 0, 0], vb = [0, 0, 0];
    for (const c of candidates) {
        const mid = vec3.normalize([], vec3.add([], sites[c.s], sites[c.t]));
        /* direction from plate A's side towards plate B's, in the tangent plane */
        const across = vec3.subtract([], sites[c.t], sites[c.s]);
        vec3.scaleAndAdd(across, across, mid, -vec3.dot(across, mid));
        if (vec3.length(across) < 1e-9) { c.closing = -Infinity; continue; }
        vec3.normalize(across, across);
        const A = plates[owner[c.s]], B = plates[owner[c.t]];
        plateVelocity(va, A.pole, A.omega, mid);
        plateVelocity(vb, B.pole, B.omega, mid);
        /* positive when the two majors are closing on each other here */
        c.closing = q9(vec3.dot(vec3.subtract([], va, vb), across));
        c.mid = mid;
        c.across = across;
    }
    const ranked = candidates.filter(c => c.mid).sort((a, b) => b.closing - a.closing || a.s - b.s || a.t - b.t);

    const taken = new Uint8Array(n);
    const used = [];
    for (const target of minorTargets) {
        /* the boundary this minor is born on: the most convergent margin not
           already claimed by an earlier minor */
        let spot = null;
        for (const c of ranked) {
            let clear = true;
            for (const u of used) if (angleBetween(c.mid, u) < opts.microplateSeparation) { clear = false; break; }
            if (clear && !taken[c.s] && !taken[c.t]) { spot = c; break; }
        }
        if (!spot) break;
        used.push(spot.mid);

        /* along-boundary direction: tangent to the sphere, perpendicular to
           the crossing direction */
        const along = vec3.normalize([], vec3.cross([], spot.mid, spot.across));

        /* The floor matters more than the target. A three-site sliver holds
         * ~0.3% of the sphere, and the convergence feedback plus the retire
         * threshold eat it inside a few steps: measured, a planet born with
         * 21 plates kept losing its whole microplate belt by mid-run. Five
         * sites lands a minor near 1%, Nazca-to-Caribbean country, big
         * enough to live long enough to matter. */
        const quota = Math.max(6, Math.round(target * n));
        const cost = [];
        for (let s = 0; s < n; s++) {
            if (taken[s]) { cost.push(Infinity); continue; }
            const d = angleBetween(sites[s], spot.mid);
            const e = vec3.scaleAndAdd([], sites[s], spot.mid, -vec3.dot(sites[s], spot.mid));
            let a = 0;
            if (vec3.length(e) > 1e-9) a = Math.abs(vec3.dot(vec3.normalize(e, e), along)) * d;
            const x = Math.sqrt(Math.max(0, d * d - a * a));
            cost.push(q9(Math.hypot(a / opts.microplateElongation, x)));
        }
        const order = Array.from({length: n}, (_, i) => i).sort((a, b) => cost[a] - cost[b] || a - b);

        const p = plates.length;
        plates.push({
            id: p,
            name: nextName(),
            sites: [],
            pole: randomUnitVector(randFloat),
            /* Earth's microplates are its sprinters: Cocos and Philippine
               outrun every major. The speed is also what makes them matter —
               it is what keeps their margins converging hard enough to build
               arcs. */
            omega: randomOmega(randFloat) * opts.microplateSpin,
            bornMyr: 0,
            parent: -1,
        });
        for (let k = 0, got = 0; k < n && got < quota; k++) {
            const s = order[k];
            if (cost[s] === Infinity) break;
            taken[s] = 1;
            owner[s] = p;
            got++;
        }
    }
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
function heapLess(a, b) {
    if (a.cost !== b.cost) return a.cost < b.cost;
    return a.value < b.value;
}

function heapPush(heap, cost, value) {
    heap.push({cost, value});
    let i = heap.length - 1;
    while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!heapLess(heap[i], heap[parent])) break;
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
            if (l < heap.length && heapLess(heap[l], heap[small])) small = l;
            if (r < heap.length && heapLess(heap[r], heap[small])) small = r;
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
            /* integer costs: 1-ulp sin/cos differences between JS engines
               must not flip a boundary cell, or 20 steps later the planet
               is a different world */
            const next = here + Math.round(step * k * warp(r, nb) * 1e7);
            if (next < cost[nb] || (next === cost[nb] && p < r_plate[nb])) {
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

/* Compression axis at a converging margin: relative velocity of `other`
 * minus `mine`, projected into the tangent plane. Weighted by `amount`
 * so later mixing is just addition. */
function addOrogenyDir(dir, r, r_xyz, plates, mine, other, amount, va, vb, rel) {
    const px = r_xyz[3 * r], py = r_xyz[3 * r + 1], pz = r_xyz[3 * r + 2];
    const pos = addOrogenyDir._pos;
    pos[0] = px; pos[1] = py; pos[2] = pz;
    const pa = plates[mine], pb = plates[other];
    plateVelocity(va, pa.pole, pa.omega, pos);
    plateVelocity(vb, pb.pole, pb.omega, pos);
    rel[0] = vb[0] - va[0];
    rel[1] = vb[1] - va[1];
    rel[2] = vb[2] - va[2];
    const rad = rel[0] * px + rel[1] * py + rel[2] * pz;
    rel[0] -= rad * px;
    rel[1] -= rad * py;
    rel[2] -= rad * pz;
    const len = Math.hypot(rel[0], rel[1], rel[2]);
    if (len < 1e-12) return;
    const s = amount / len;
    dir[3 * r]     += rel[0] * s;
    dir[3 * r + 1] += rel[1] * s;
    dir[3 * r + 2] += rel[2] * s;
}
addOrogenyDir._pos = [0, 0, 0];


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
 * Spherical Voronoi cells are convex, so the walk always ends on the true
 * nearest cell — it stops when no neighbour is closer, and that local
 * maximum is the global one.
 *
 * The step limit is only a safety net, so it has to scale with the mesh. A
 * fixed cap works for advection, where the start is a cell or two away, but
 * not for locating a plate site from an arbitrary hint: at 40000 regions the
 * mesh is over 200 cells across, a 64-step cap cut the climb off partway,
 * and the wrong cell then seeded the ownership. Half the plates vanished
 * before the clock started, and only at high resolution. */
function nearestRegion(mesh, r_xyz, x, start, out_r) {
    let current_r = start;
    const dotQ = (r) => Math.round((x[0] * r_xyz[3 * r] + x[1] * r_xyz[3 * r + 1] + x[2] * r_xyz[3 * r + 2]) * 1e12);
    let best = dotQ(current_r);
    const limit = 8 * Math.sqrt(mesh.numRegions);
    for (let guard = 0; guard < limit; guard++) {
        let moved = -1;
        mesh.r_circulate_r(out_r, current_r);
        for (const neighbor_r of out_r) {
            const d = dotQ(neighbor_r);
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
    sitesPerPlate: 40,            // enough that even the smallest plate in a
                                  // heavy-tailed size distribution gets several, and
                                  // enough that shapes are not convex caps. Also sets
                                  // how finely a subduction front erodes: consumption
                                  // scallops a margin at site spacing, and at 26 sites
                                  // a 40k mesh resolved the scallops as raggedness
                                  // 1.5 where 40 sites reads 1.2 at every mesh size
    boundaryWarp: 0.35,           // how far the boundary curves away from a true arc
    speckCells: 12,               // territory smaller than this is not a plate
    microplateElongation: 2.4,    // how stretched along its margin a minor plate is
    microplateSpin: 1.7,          // minors turn faster than majors, as Earth's do
    microplateSeparation: 0.5,    // radians between minor plate birthplaces
    boundaryWarpScale: 1.6,       // low frequency: bend the boundary, do not fray it
    plateGrowth: 0.05,            // how fast a plate gains at its ridges and loses at
                                  // its trenches; this is what lets a mostly-subducting
                                  // plate shrink away, as the Farallon did
    plateReversion: 0.12,         // pull back towards its own size; must exceed
                                  // plateGrowth or the feedback has no equilibrium
    plateRetireArea: 0.001,       // a plate smaller than this is absorbed by its neighbours
    stepMyr: 10,                  // 200 Myr of history
    cratons: 6,                   // continents; each is grown from several welded blocks
    cratonSigma: 0.55,            // spread of craton sizes, so they are not all alike
    cratonWarp: 1.0,              // gain on the banded margin cuts. The old
                                  // multiplicative warp just resized a disc; this
                                  // scales gulfs, bays and shatter instead
    cratonElongation: 0.38,       // log-sigma of how stretched a craton is along its
                                  // axis; discs make blobs, slivers make Americas, and
                                  // too much of it makes noodles
    cratonTaper: 0.35,            // how much one end of a craton narrows, so a mass
                                  // can come to a point the way South America does
    continentBlocks: 1.0,         // a continent is grown as a chain of welded blocks,
                                  // not one decorated cap; this scales how many blocks
                                  // the largest continents get. 0 collapses every
                                  // continent back to a single cap
    blockSpread: 0.70,            // block centre spacing as a fraction of the two
                                  // blocks' summed radii. Lower is compact and rounded,
                                  // higher is lobed and sprawling; past ~1 the blocks
                                  // detach into an island neighbour
    sutures: 1.0,                 // gain on what a weld between two blocks does to the
                                  // crust. The fixture zeroes this: it authors its own
                                  // belts and basins
    sutureWidth: 0.22,            // seam half-width, in units of block radius
    sutureBeltKm: 5,              // an old collision belt along the weld: extra
                                  // thickness that rootRelax erodes into rounded
                                  // highlands, an Appalachians rather than a Himalaya
    sutureSagKm: 5.5,             // a sagged weld: thinner crust that floods into a
                                  // shallow epicontinental sea, a Hudson Bay or Baltic.
                                  // This replaces the generated inland-sea caps
    oceanGap: 0.07,               // radians of sea a growing block must keep from
                                  // every other continent
    blockFacets: 1.0,             // straight-margin cuts and pointed tips on blocks.
                                  // An ellipse's level set can never come to a point;
                                  // real margins are line-derived — rift scars and
                                  // trenches — and their intersections are what make
                                  // an India or a Patagonia. 0 disables
    facetCalm: 0.35,              // gain on the gulf/bay noise along a faceted margin.
                                  // A rift scar is a calm, straight coast; full noise
                                  // wobbles the straightness back into a blob
    gulfCut: 0.72,                // deep but sparse inlets; weak noise is ignored
    bayCut: 0.16,                 // smaller bays
    coastGrain: 0.06,             // a little edge grain; wiggly blobs are not the goal
    cratonShatter: 0.12,          // some outer shelves break into islands
    coastContrast: 0.4,           // regional variation in coast raggedness: some
                                  // margins calm, some shattered
    cratonClustering: 0.62,       // chance a craton huddles against the others
    cratonMinSeparation: 0.70,    // radians; block aggregates reach further than the
                                  // caps they grew from, so continents need more room
                                  // than single cratons did
    crustSmoothing: 1,            // smoothing of the craton edge warp
    continentFraction: 0.47,      // Earth: continental crust is ~41% of the surface, of
                                  // which ~29% is dry land. Set above 0.41 because this
                                  // is the fraction the planet is *born* with and
                                  // rifting consumes some of it over the run; block
                                  // aggregates expose much less margin than the old
                                  // noise-fringed discs did, so they lose only ~5
                                  // points where the discs lost 16
    crustReferenceKm: 33.5,       // thickness undisturbed continental crust relaxes towards.
                                  // Sets how high a quiet interior stands: at 145 m per km
                                  // above sea-level thickness, 33.5 km is ~650 m, near
                                  // Earth's mean land elevation. Lower than this and the
                                  // whole continent hovers at the waterline, where any
                                  // noise at all decides the coastline
    seaLevelThicknessKm: 29,      // thickness that floats exactly at sea level
    crustOceanKm: 7,
    crustTypeKm: 18,              // thicker than this is continental crust. This is
                                  // also where a stretched margin breaks: a single
                                  // threshold, or the rift branch keeps crust the
                                  // derived type then calls ocean
    crustMinKm: 22,               // fully rifted margin
    crustShelfKm: 26.5,           // the rim an undisturbed craton is born with. Starting
                                  // it at crustMinKm gave every continent a pre-rifted
                                  // margin, so the first rift to touch a coast converted
                                  // the whole shelf ring to ocean and the continent shrank
                                  // by its rim. A margin should have to be stretched down
                                  // to crustMinKm before it breaks
    crustMaxKm: 68,               // Tibet
    coastalPlain: 0.35,           // fraction of the interior over which the coast climbs
                                  // to platform height. Inside that ramp the continent is
                                  // *flat*: a platform born at crustReferenceKm, the
                                  // thickness it would relax to anyway. Relief on land is
                                  // orogeny's job — a radial dome from core to coast made
                                  // every continent shade like a blob
    shelfThinningKm: 0.15,         // per step, at a rifting margin
    collisionThickenKm: 0.9,      // per step, continent against continent
    collisionThrust: 0.34,        // share of an overridden column thrust onto the winner
    riftThinKm: 0.6,              // how much a margin thins per step of stretching.
                                  // Thinning by a *fraction* instead halves a cell every
                                  // step it spends on a divergent boundary, which leaves
                                  // half the continental crust too thin to stand above
                                  // sea level
    riftIntactShare: 0.75,        // a margin stretches until it thins to this fraction of
                                  // reference thickness, then it has broken and the
                                  // opening floods. Was declared but never used: the rift
                                  // branch tested against crustTypeKm instead, so crust
                                  // kept being drawn into new area almost indefinitely
    emergentFraction: 0.73,       // share of continental crust starting above sea level.
                                  // The rest is shelf: a craton needs a wide drowned rim
                                  // to land at Earth's ~30% submerged, and that rim is
                                  // what reads as a continental shelf rather than a cliff
    orogenyDecay: 0.88,           // erosion between steps
    orogenyReliefM: 2200,         // extra relief at full orogeny, on top of isostasy
    rootRelax: 0.030,             // crustal roots relax back towards normal
    arcUpliftM: 2400,             // how far a full-strength arc lifts the sea floor
    arcOceanic: 0.8,              // island arc over ocean-ocean subduction
    arcContinental: 0.85,         // Andean arc over ocean-continent
    arcCrestM: 9000,              // height of the volcanic crest itself, applied
                                  // after the coastal blend so an island survives it
    arcEmergeThreshold: 0.35,     // arc or hotspot strength below this builds only
                                  // seamounts, never islands
    hotspots: 3,                  // mantle plumes, fixed while the plates slide over
                                  // them; each writes an age-progressive island chain
    hotspotRadius: 0.07,          // radians; the footprint of a plume head
    hotspotStrength: 0.6,         // per step, while a cell sits over the plume
    hotspotDecay: 0.965,          // per step; an old chain subsides into seamounts
    hotspotUpliftM: 6000,         // crest height over a full-strength hotspot
    orogenyAndean: 0.5,
    orogenyCollision: 1.0,
    weldContact: 0.30,            // accumulated contact needed to fuse two plates,
                                  // as a multiple of the whole surface
    contactDecay: 0.75,           // contact fades once two plates stop converging
    backArcChance: 1.0,           // per step, chance a convergent margin calves off a
                                  // microplate, so long as the census is under strength
    riftChance: 0.12,             // per step, chance of deliberately splitting a big
                                  // plate. Kept low because plates being cut in two by
                                  // their neighbours already supplies most of the churn
    riftMinArea: 0.12,            // only plates larger than this can rift
    coastBlend: 1,                // relaxation rings across the continental margin
    healPasses: 2,                // majority-filter passes that keep plates coherent
    minFragment: 0.014,           // a detached piece smaller than this is absorbed by
                                  // its neighbours instead of becoming a plate
    detailNoise: 0.035,           // added in elevation units, where near-shore land sits
                                  // around 0.05. Any larger and the noise outweighs the
                                  // land it is perturbing: it stops roughening the coast
                                  // and starts punching holes in it, which is what
                                  // shredded continents into strings and speckle
    polarStraits: true,           // isolate a continent that sits on a pole with a
                                  // high-latitude seaway, the way Drake Passage cuts
                                  // Antarctica off from the Americas. Off leaves the
                                  // land bridge if the cratons grew one
    polarCapLat: 70,              // degrees; a polar continent is land covering this cap
    polarCapLand: 0.50,           // fraction of the cap that must be land to count
    polarStraitLat: 52,           // degrees; cut in this band (Earth: Drake ~60°S)
    polarStraitBand: 16,          // band width in degrees (52–68)
    polarStraitM: -140,           // metres; shallow water, not an abyssal trench
    polarStraitMaxFrac: 0.015,    // never drown more than this of the surface to cut
    polarStraitOnPole: true,      // the pole cell itself must be land; Arctic islands
                                  // reaching 80°N are not a polar continent
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
function radiiFromShares(shares, continentFraction) {
    const total = shares.reduce((a, b) => a + b, 0) || 1;
    return shares.map(w => {
        const share = continentFraction * w / total;
        return Math.acos(Math.max(-1, 1 - 2 * share));
    });
}


/* Angular distance from a cap's centre, stretched into an ellipse and
 * tapered so one end can come to a point. Shared by cratons and the
 * basins punched into them. */
function capDistance(p, centre, axis, elong, taper, scratch) {
    const t = scratch || [0, 0, 0];
    const dot = Math.max(-1, Math.min(1, vec3.dot(p, centre)));
    const a = Math.acos(dot);
    if (a <= 1e-6) return 0;
    t[0] = p[0] - dot * centre[0];
    t[1] = p[1] - dot * centre[1];
    t[2] = p[2] - dot * centre[2];
    vec3.normalize(t, t);
    const along = vec3.dot(t, axis.u), across = vec3.dot(t, axis.v);
    const stretch = Math.sqrt(along * along / elong + across * across * elong)
        / (1 + taper * along);
    return a * stretch;
}


/* Authored cratons skip the random huddle. Same primitive otherwise:
 * spherical caps, unequal shares, a stretch axis and a taper. */
function placementFromSpec(spec, opts) {
    const centres = spec.centres;
    const shares = spec.shares || centres.map(() => 1);
    return {
        centres,
        radii: spec.radii && spec.radii.length === centres.length
            ? spec.radii.slice()
            : radiiFromShares(shares, opts.continentFraction),
        axes: spec.axes,
        elong: spec.elong,
        taper: spec.taper,
        facets: spec.facets,
        shares: shares.slice(),
    };
}


function placeCratons(mesh, r_xyz, count, randFloat, opts) {
    if (opts.cratonPlacement) return placementFromSpec(opts.cratonPlacement, opts);

    const centres = [];
    const angle = (a, b) => angleBetween(a, b);

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
            candidates.push({c, nearest, i: candidates.length});
        }
        if (candidates.length === 0) { centres.push(randomUnitVector(randFloat)); continue; }
        const huddle = randFloat() < opts.cratonClustering;
        candidates.sort((a, b) => huddle
            ? (a.nearest - b.nearest || a.i - b.i)
            : (b.nearest - a.nearest || a.i - b.i));
        centres.push(candidates[0].c);
    }

    /* Unequal sizes, the way Eurasia dwarfs Australia. */
    const gauss = () => {
        const u1 = Math.max(1e-9, randFloat()), u2 = randFloat();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const weights = centres.map(() => Math.exp(opts.cratonSigma * gauss()));

    /* Radius of a spherical cap holding this craton's share of the target
     * continental area: cap fraction = (1 - cos R) / 2. */
    const radii = radiiFromShares(weights, opts.continentFraction);

    /* A cap is a disc, and a planet of discs reads as a planet of blobs.
     * Earth's masses have a grain: the Americas are a sliver, Africa a
     * wedge. So stretch each craton along a random axis and taper it
     * towards one end. */
    const axes = centres.map(c => {
        const ref = Math.abs(c[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        let u = vec3.normalize([], vec3.cross([], c, ref));
        const spin = 2 * Math.PI * randFloat();
        u = rotateAbout([], u, c, spin);
        const v = vec3.cross([], c, u);
        return {u, v};
    });
    const elong = centres.map(() => Math.exp(opts.cratonElongation * Math.abs(gauss())));
    const taper = centres.map(() => opts.cratonTaper * (2 * randFloat() - 1));
    return {centres, radii, axes, elong, taper, shares: weights};
}


function walkSphere(centre, tangent, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const out = [
        centre[0] * c + tangent[0] * s,
        centre[1] * c + tangent[1] * s,
        centre[2] * c + tangent[2] * s,
    ];
    const len = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= len; out[1] /= len; out[2] /= len;
    return out;
}


function frameFromTangent(centre, u) {
    const along = [
        u[0] - vec3.dot(u, centre) * centre[0],
        u[1] - vec3.dot(u, centre) * centre[1],
        u[2] - vec3.dot(u, centre) * centre[2],
    ];
    if (vec3.length(along) < 1e-9) {
        const ref = Math.abs(centre[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        vec3.cross(along, centre, ref);
    }
    vec3.normalize(along, along);
    return {u: along, v: vec3.normalize([], vec3.cross([], centre, along))};
}


function smooth01(edge0, edge1, x) {
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}


/* What a weld between two blocks does to the crust, decided once per
 * pair: an old collision belt, a sagging seam, or a clean join. */
const SUTURE_NONE = 0, SUTURE_BELT = 1, SUTURE_SAG = 2;

function drawSutureTypes(nB, randFloat) {
    const types = new Uint8Array(nB * nB);
    for (let i = 0; i < nB; i++) {
        for (let j = i + 1; j < nB; j++) {
            const roll = randFloat();
            const type = roll < 0.40 ? SUTURE_BELT : roll < 0.72 ? SUTURE_SAG : SUTURE_NONE;
            types[i * nB + j] = types[j * nB + i] = type;
        }
    }
    return types;
}


/* A continent is not one cap. Earth's are aggregates: a few cratonic
 * blocks welded along sutures — Laurentia, the shield, an Appalachian
 * rim make North America. A lone ellipse can only ever be a blob, and
 * decorating it with authored peninsula and gulf caps kept the blob and
 * added bumps. So grow each continent as a chain of overlapping blocks:
 * the union's outline gets waists, promontories and concavities because
 * the structure has them, and each weld is a suture that can carry an
 * old belt or sag into a shallow sea.
 *
 * All randomness is drawn up front. Positions are re-derived for any
 * radius scale with block spacing proportional to radius, so the area
 * bisection in initCrust resizes an aggregate without changing its
 * topology. */
function planBlocks(continents, randFloat, opts) {
    const nC = continents.centres.length;
    const cShares = continents.shares || continents.centres.map(() => 1);
    const cTotal = cShares.reduce((a, b) => a + b, 0);
    const gauss = () => {
        const u1 = Math.max(1e-9, randFloat()), u2 = randFloat();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };

    /* Pass 1: how many blocks each continent gets and how big each is,
     * so every radius is known before any block is placed. */
    const continent = [], weights = [], elong = [], taper = [];
    const firstBlock = [];
    for (let k = 0; k < nC; k++) {
        const frac = cShares[k] / cTotal;
        let want = 1;
        if (frac >= 0.30) want = 5;
        else if (frac >= 0.20) want = 4;
        else if (frac >= 0.12) want = 3;
        else if (frac >= 0.05) want = 2;
        want = Math.max(1, Math.round(1 + (want - 1) * opts.continentBlocks));

        const sub = [1];
        for (let i = 1; i < want; i++) sub.push(0.50 * Math.exp(0.65 * gauss()));
        const subTotal = sub.reduce((a, b) => a + b, 0);

        firstBlock.push(continent.length);
        for (let i = 0; i < want; i++) {
            continent.push(k);
            weights.push(cShares[k] * sub[i] / subTotal);
            if (i === 0) {
                elong.push(continents.elong[k]);
                taper.push(continents.taper[k]);
            } else {
                elong.push(Math.exp(0.30 * Math.abs(gauss())));
                taper.push(0.8 * opts.cratonTaper * (2 * randFloat() - 1));
            }
        }
    }
    const radii = radiiFromShares(weights, opts.continentFraction);
    const nB = weights.length;

    const parent = new Int32Array(nB).fill(-1);
    const bearing = new Float32Array(nB);
    const spread = new Float32Array(nB);
    const axisJitter = new Float32Array(nB);

    /* One block's centre, given its parent's, at a radius scale. The
     * bearing is stored in a frame derived from the parent's position, so
     * the same plan stays coherent as the bisection rescales it. */
    const stepFrom = (P, k, theta, arc) => {
        const f = frameFromTangent(P, continents.axes[k].u);
        const c = Math.cos(theta), s = Math.sin(theta);
        const dir = [
            f.u[0] * c + f.v[0] * s,
            f.u[1] * c + f.v[1] * s,
            f.u[2] * c + f.v[2] * s,
        ];
        return {pos: walkSphere(P, dir, arc), dir};
    };

    const materialize = (scale) => {
        const centres = new Array(nB), axes = new Array(nB);
        for (let b = 0; b < nB; b++) {
            const k = continent[b];
            if (parent[b] < 0) {
                centres[b] = continents.centres[k];
                axes[b] = continents.axes[k];
                continue;
            }
            const arc = spread[b] * (radii[parent[b]] + radii[b]) * scale;
            const {pos, dir} = stepFrom(centres[parent[b]], k, bearing[b], arc);
            centres[b] = pos;
            /* The block lies along its chain step, give or take a jitter. */
            const g = frameFromTangent(pos, dir);
            const cj = Math.cos(axisJitter[b]), sj = Math.sin(axisJitter[b]);
            const u = [
                g.u[0] * cj + g.v[0] * sj,
                g.u[1] * cj + g.v[1] * sj,
                g.u[2] * cj + g.v[2] * sj,
            ];
            axes[b] = {u, v: vec3.cross([], pos, u)};
        }
        return {centres, axes};
    };

    /* Pass 2: place the blocks at scale 1, keeping every aggregate clear
     * of the others. Positions are frozen as bearings, not coordinates. */
    const pos1 = new Array(nB);
    const clearance = (Q, b) => {
        let gap = Infinity;
        for (let j = 0; j < nB; j++) {
            if (continent[j] === continent[b] || !pos1[j]) continue;
            gap = Math.min(gap, angleBetween(Q, pos1[j]) - radii[j] - radii[b]);
        }
        for (let k = 0; k < nC; k++) {
            if (k === continent[b] || pos1[firstBlock[k]]) continue;
            gap = Math.min(gap, angleBetween(Q, continents.centres[k]) - continents.radii[k] - radii[b]);
        }
        return gap;
    };

    const OFFSETS = [0, 0.79, -0.79, 1.57, -1.57, 2.36, -2.36, 3.14];
    for (let b = 0; b < nB; b++) {
        const k = continent[b];
        if (b === firstBlock[k]) { pos1[b] = continents.centres[k]; continue; }

        /* Walk on from the newest block most of the time — that is what
         * stretches a continent into a sliver or an arc — and sometimes
         * branch from an earlier one, which fattens it instead. */
        parent[b] = (b - firstBlock[k] === 1 || randFloat() < 0.55)
            ? b - 1
            : firstBlock[k] + Math.floor(randFloat() * (b - firstBlock[k]));

        /* Prefer to grow away from the continent's existing mass. */
        const centroid = [0, 0, 0];
        for (let j = firstBlock[k]; j < b; j++) vec3.add(centroid, centroid, pos1[j]);
        vec3.normalize(centroid, centroid);
        const P = pos1[parent[b]];
        const f = frameFromTangent(P, continents.axes[k].u);
        const away = vec3.scaleAndAdd([], centroid, P, -vec3.dot(centroid, P));
        let preferred;
        if (vec3.length(away) < 1e-6) {
            preferred = 2 * Math.PI * randFloat();
        } else {
            vec3.normalize(away, away);
            preferred = Math.atan2(-vec3.dot(away, f.v), -vec3.dot(away, f.u));
        }
        preferred += 1.2 * (randFloat() - 0.5);

        spread[b] = randFloat() < 0.10
            ? 0.95 + 0.15 * randFloat()   // detached: an offshore Madagascar
            : opts.blockSpread * (0.78 + 0.45 * randFloat());
        const arc = spread[b] * (radii[parent[b]] + radii[b]);

        /* A chain may not wander further than this from home: unbounded
         * walks turned continents into globe-wrapping ribbons. The cap
         * radius already covers the continent's whole share, so there is
         * little legitimate reason to stand far outside it. */
        const maxReach = 1.4 * continents.radii[k];
        /* Score candidates by the worse of two constraints, but only an
         * actual touch with another continent is disqualifying: a sprawl
         * overshoot merely stops being preferred, or dropped blocks
         * collapse continents back into the discs this replaced. */
        let bestGap = -Infinity, bestClear = -Infinity, bestTheta = preferred, bestPos = null;
        for (const off of OFFSETS) {
            const theta = preferred + off;
            const {pos} = stepFrom(P, k, theta, arc);
            const clear = clearance(pos, b);
            const gap = Math.min(clear, maxReach - angleBetween(pos, continents.centres[k]));
            if (gap > bestGap) { bestGap = gap; bestClear = clear; bestTheta = theta; bestPos = pos; }
            if (bestGap >= opts.oceanGap) break;
        }
        if (bestClear < 0) {
            /* Nowhere to grow without touching another continent. Drop the
             * block; the area bisection makes up the lost share. */
            parent[b] = -2;
            radii[b] = 0;
            pos1[b] = P;
            continue;
        }
        bearing[b] = bestTheta;
        axisJitter[b] = 0.9 * (randFloat() - 0.5);
        pos1[b] = bestPos;
    }
    /* Dropped blocks sit on their parent with radius 0; give materialize a
     * valid parent so the chain positions stay defined. */
    for (let b = 0; b < nB; b++) if (parent[b] === -2) parent[b] = firstBlock[continent[b]];

    /* Facets: straight-margin cuts, and pairs of cuts that converge into a
     * pointed tip. An ellipse can never come to a point, and real sharp
     * coasts are intersections of line-derived margins. A tip continues
     * the block's grown end — the last block of a chain is a peninsula
     * end, so it gets one most often. */
    const facets = [];
    const gain = opts.blockFacets;
    for (let b = 0; b < nB; b++) {
        const list = [];
        facets.push(list);
        if (!(radii[b] > 0) || !gain) continue;
        const tail = b + 1 === nB || continent[b + 1] !== continent[b];
        if (randFloat() < gain * (tail ? 0.40 : 0.15)) {
            const az = (taper[b] >= 0 ? 0 : Math.PI) + 1.0 * (randFloat() - 0.5);
            const phi = 0.30 + 0.25 * randFloat();
            const reach = 0.85 + 0.25 * randFloat();
            /* Reach is against the ellipse's extent along the azimuth, so
             * a stretched block keeps its full length. */
            const ca = Math.cos(az), sa = Math.sin(az);
            const stretch = Math.sqrt(ca * ca / elong[b] + sa * sa * elong[b])
                / (1 + taper[b] * ca);
            const off = reach * Math.sin(phi) / stretch;
            list.push({theta: az + (Math.PI / 2 - phi), off, gate: az});
            list.push({theta: az - (Math.PI / 2 - phi), off, gate: az});
        }
        if (randFloat() < gain * 0.30) {
            list.push({theta: 2 * Math.PI * randFloat(), off: 0.55 + 0.30 * randFloat()});
        }
    }

    return {radii, elong, taper, facets, materialize, sutureType: drawSutureTypes(nB, randFloat), nB};
}


/* Authored placement is already a set of blocks; nothing to grow. */
function planFromSpec(placement, randFloat) {
    const nB = placement.centres.length;
    return {
        radii: placement.radii,
        elong: placement.elong,
        taper: placement.taper,
        facets: placement.facets || placement.centres.map(() => []),
        materialize: () => ({centres: placement.centres, axes: placement.axes}),
        sutureType: drawSutureTypes(nB, randFloat),
        nB,
    };
}


function initCrust(mesh, r_xyz, seed, opts) {
    const {numRegions} = mesh;
    const randFloat = makeRandFloat(seed ^ 0x2545f491);

    const r_crust_type = new Uint8Array(numRegions);
    const r_crust_age = new Float32Array(numRegions);
    const r_thickness = new Float32Array(numRegions);
    const r_orogeny = new Float32Array(numRegions);
    const r_orogenyDir = new Float32Array(numRegions * 3);
    const r_arc = new Float32Array(numRegions);
    const r_hotspot = new Float32Array(numRegions);

    const placement = placeCratons(mesh, r_xyz, opts.cratons, randFloat, opts);
    const plan = opts.cratonPlacement
        ? planFromSpec(placement, randFloat)
        : planBlocks(placement, randFloat, opts);
    const {radii, elong, taper, sutureType, nB} = plan;

    /* Distance to the nearest block, in units of that block's radius.
     * Below 1 is continental crust; 0 is the deep interior.
     *
     * The old warp multiplied the whole field by low-frequency FBM, which
     * only resized the disc. Gulfs and shattered shelves are mid-scale
     * *cuts* on the margin — additive, stronger toward the edge, so the
     * interior stays a compact craton and we never sit on the percolation
     * threshold. Contrast still varies which coasts are calm. */
    const depth = new Float32Array(numRegions);
    const gulf = new Float32Array(numRegions);
    const bay = new Float32Array(numRegions);
    const grain = new Float32Array(numRegions);
    const contrast = new Float32Array(numRegions);
    const gulfNoise = makeFbm(new SimplexNoise(makeRandFloat(seed ^ 0x27d4eb2f)), 3, 0.5);
    const bayNoise = makeFbm(new SimplexNoise(makeRandFloat(seed ^ 0x9e3779b9)), 2, 0.55);
    const grainNoise = makeFbm(new SimplexNoise(makeRandFloat(seed ^ 0xa5a5a5a5)), 2, 0.5);
    const contrastNoise = makeFbm(new SimplexNoise(makeRandFloat(seed ^ 0x85ebca6b)), 2, 0.6);
    const GULF_F = 9, BAY_F = 16, GRAIN_F = 24;
    for (let r = 0; r < numRegions; r++) {
        const x = r_xyz[3 * r], y = r_xyz[3 * r + 1], z = r_xyz[3 * r + 2];
        gulf[r] = gulfNoise(GULF_F * x, GULF_F * y, GULF_F * z);
        bay[r] = bayNoise(BAY_F * x, BAY_F * y, BAY_F * z);
        grain[r] = grainNoise(GRAIN_F * x, GRAIN_F * y, GRAIN_F * z);
        contrast[r] = 1 + opts.coastContrast * contrastNoise(x, y, z);
    }
    smoothField(mesh, gulf, null, opts.crustSmoothing);

    const p = [0, 0, 0], t = [0, 0, 0];
    /* Signed thickness change along block welds, filled on the last pass:
     * positive is an old belt, negative a sagging seam. */
    const sutureKm = new Float32Array(numRegions);
    const beltKm = opts.sutures * opts.sutureBeltKm;
    const sagKm = opts.sutures * opts.sutureSagKm;
    const measure = (scale, record) => {
        const {centres, axes} = plan.materialize(scale);
        /* Facet cut planes, as tangent vectors in each block's frame. A
         * facet with a gate also gets the gate's direction vector: the cut
         * only binds toward that end of the block. Without the gate a
         * tip's two planes clip a corridor down the block's whole length —
         * that is what pinched Patagonia into a neck. */
        const tangent = (k, theta) => {
            const c = Math.cos(theta), s = Math.sin(theta);
            const u = axes[k].u, v = axes[k].v;
            return [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s];
        };
        const facetM = plan.facets.map((list, k) => list.map(f => tangent(k, f.theta)));
        const facetG = plan.facets.map((list, k) =>
            list.map(f => f.gate != null ? tangent(k, f.gate) : null));
        let inside = 0;
        for (let r = 0; r < numRegions; r++) {
            p[0] = r_xyz[3 * r]; p[1] = r_xyz[3 * r + 1]; p[2] = r_xyz[3 * r + 2];
            let d1 = Infinity, d2 = Infinity, b1 = -1, b2 = -1, facet1 = false;
            for (let k = 0; k < nB; k++) {
                if (!(radii[k] > 0)) continue;
                let d = capDistance(p, centres[k], axes[k], elong[k], taper[k], t)
                    / (radii[k] * scale);
                /* A facet trims the cap with a straight edge: everything
                 * past `off` block radii in the cut's direction is ocean.
                 * The gradient matches the cap's, so the shelf keeps its
                 * width along a faceted margin. */
                let faceted = false;
                const list = plan.facets[k], ms = facetM[k], gs = facetG[k];
                for (let j = 0; j < list.length; j++) {
                    const m = ms[j];
                    const s = Math.asin(Math.max(-1, Math.min(1,
                        p[0] * m[0] + p[1] * m[1] + p[2] * m[2])));
                    let off = list[j].off;
                    if (gs[j]) {
                        const g = gs[j];
                        const ag = Math.asin(Math.max(-1, Math.min(1,
                            p[0] * g[0] + p[1] * g[1] + p[2] * g[2])));
                        off += 1.2 * (1 - smooth01(-0.1, 0.5, ag / (radii[k] * scale)));
                    }
                    const df = 1 + (s / (radii[k] * scale) - off);
                    if (df > d) { d = df; faceted = true; }
                }
                if (d < d1) { d2 = d1; b2 = b1; d1 = d; b1 = k; facet1 = faceted; }
                else if (d < d2) { d2 = d; b2 = k; }
            }
            const raw = d1;
            /* A faceted margin is a rift scar or a trench line: straight
             * and calm. Full-strength noise would wobble it back round. */
            const w = opts.cratonWarp * contrast[r] * (facet1 ? opts.facetCalm : 1);
            const g = gulf[r], b = bay[r];
            const mGulf = smooth01(0.22, 0.85, raw);
            const mBay = smooth01(0.48, 1.00, raw);
            const mEdge = smooth01(0.62, 1.12, raw);
            const cut = w * (
                opts.gulfCut * Math.max(0, g - 0.22) * mGulf +
                opts.bayCut * Math.max(0, b - 0.10) * mBay +
                opts.cratonShatter * Math.max(0, 0.55 * g + 0.45 * b - 0.20) * mEdge
            );
            const wig = w * opts.coastGrain * grain[r] * mEdge;
            depth[r] = raw + cut + wig;
            if (depth[r] < 1) inside++;

            /* A weld is where two blocks are nearly equidistant and the
             * point is really inside their overlap, not out past the rim. */
            if (record && b2 >= 0 && d1 < 1.05) {
                const type = sutureType[b1 * nB + b2];
                if (type !== SUTURE_NONE) {
                    let s = 1 - (d2 - d1) / opts.sutureWidth;
                    if (s > 0) {
                        s *= s * (1 - smooth01(0.80, 1.05, d2));
                        sutureKm[r] = type === SUTURE_BELT ? beltKm * s : -sagKm * s;
                    }
                }
            }
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
    measure((lo + hi) / 2, true);

    /* Sea level sits at the depth enclosing `emergentFraction` of the
     * continental crust, found the same way the radii were: by bisection on
     * the field we actually built.
     *
     * Taking it as sqrt(emergentFraction) instead assumes a craton's area
     * grows as the square of its radius, which is only true of a lone circular
     * one. Cratons that cluster and merge share a single deep interior, so that
     * proxy handed those seeds far more emergent land than asked for — which is
     * why some planets came out as ocean worlds and others as near-total land. */
    const emergentTarget = opts.continentFraction * clamp01(opts.emergentFraction);
    let slo = 0, shi = 1;
    for (let iter = 0; iter < 20; iter++) {
        const mid = (slo + shi) / 2;
        let above = 0;
        for (let r = 0; r < numRegions; r++) if (depth[r] < mid) above++;
        if (above / numRegions < emergentTarget) slo = mid; else shi = mid;
    }
    const shore = (slo + shi) / 2;
    for (let r = 0; r < numRegions; r++) {
        const d = depth[r];
        if (d >= 1) {
            r_crust_type[r] = CRUST_OCEANIC;
            r_thickness[r] = opts.crustOceanKm;
            continue;
        }
        r_crust_type[r] = CRUST_CONTINENTAL;
        const base = d < shore
            /* interior: a coastal plain climbing to a flat platform at the
               equilibrium thickness. Not a dome — distance from the coast
               says nothing about how high a real continent stands */
            ? opts.seaLevelThicknessKm + (opts.crustReferenceKm - opts.seaLevelThicknessKm) *
              smooth01(0, opts.coastalPlain, 1 - d / shore)
            /* the shelf, between the shoreline and the edge of the craton */
            : opts.crustShelfKm + (opts.seaLevelThicknessKm - opts.crustShelfKm) * (1 - d) / (1 - shore);
        /* then the weld running through here, if any: an old belt stands
           up as rounded highlands, a sag floods into a shallow sea */
        r_thickness[r] = sutureKm[r]
            ? Math.max(opts.crustMinKm, Math.min(opts.crustMaxKm, base + sutureKm[r]))
            : base;
    }
    applyBasins(r_xyz, r_thickness, r_crust_type, opts, null);
    return {r_crust_type, r_crust_age, r_thickness, r_orogeny, r_orogenyDir, r_arc, r_hotspot};
}


/* Enclosed seas — Mediterranean, Hudson Bay — are drowned continental
 * crust, not ocean floor. A basin is the same stretched cap as a craton
 * but it thins the column until it sits below sea level. The Earth
 * fixture authors a few; the random path generates its own. */
function applyBasins(r_xyz, r_thickness, r_crust_type, opts, r_orogeny) {
    const basins = opts.basinPlacement;
    if (!basins || !basins.centres || basins.centres.length === 0) return;
    const {centres, radii, axes, elong, taper, floorKm} = basins;
    const n = r_thickness.length;
    const p = [0, 0, 0], t = [0, 0, 0];
    for (let r = 0; r < n; r++) {
        if (r_crust_type[r] !== CRUST_CONTINENTAL) continue;
        p[0] = r_xyz[3 * r]; p[1] = r_xyz[3 * r + 1]; p[2] = r_xyz[3 * r + 2];
        let drown = 0, floor = opts.crustShelfKm;
        for (let k = 0; k < centres.length; k++) {
            const d = capDistance(p, centres[k], axes[k], elong[k], taper[k], t) / radii[k];
            if (d >= 1) continue;
            const w = Math.pow(1 - d, 1.5);
            if (w > drown) {
                drown = w;
                floor = floorKm[k];
            }
        }
        if (drown > 0) {
            r_thickness[r] = r_thickness[r] * (1 - drown) + floor * drown;
            if (r_orogeny) r_orogeny[r] *= 1 - drown;
        }
    }
}


/* The partition. Everything that reads plate ownership goes through here, so
 * whatever tidying happens after the Voronoi pass is never quietly rebuilt
 * away by the next one. */
function plateOwnership(mesh, map, opts, out) {
    const r_plate = assignPlateOwnership(mesh, map.r_xyz, map.plates, map.boundaryWarp, out);
    despeckle(mesh, r_plate, opts);
    return r_plate;
}


/* Absorb any run of territory too small to be a plate into whatever
 * surrounds it. Only the specks: anything substantial is left for
 * resolvePlateBodies to promote into a plate of its own. */
function despeckle(mesh, r_plate, opts) {
    const {numRegions} = mesh;
    const out_r = [];
    const component = new Int32Array(numRegions).fill(-1);
    const members = [];
    for (let r = 0; r < numRegions; r++) {
        if (component[r] !== -1) continue;
        const p = r_plate[r];
        const id = members.length;
        const queue = [r];
        component[r] = id;
        for (let h = 0; h < queue.length; h++) {
            mesh.r_circulate_r(out_r, queue[h]);
            for (const nb of out_r) {
                if (component[nb] === -1 && r_plate[nb] === p) { component[nb] = id; queue.push(nb); }
            }
        }
        members.push(queue);
    }
    const limit = Math.max(2, Math.round(opts.speckCells));
    const tally = new Map();
    for (const group of members) {
        if (group.length > limit) continue;
        tally.clear();
        for (const r of group) {
            mesh.r_circulate_r(out_r, r);
            for (const nb of out_r) {
                if (component[nb] === component[r]) continue;
                tally.set(r_plate[nb], (tally.get(r_plate[nb]) || 0) + 1);
            }
        }
        let best = -1, bestCount = 0;
        for (const [p, count] of tally) {
            if (count > bestCount || (count === bestCount && (best === -1 || p < best))) {
                bestCount = count; best = p;
            }
        }
        if (best !== -1) for (const r of group) r_plate[r] = best;
    }
}


/* Weights for reading a field at an arbitrary point, spread over the cell
 * that contains it and that cell's neighbours.
 *
 * Snapping to the nearest cell centre instead puts up to half a cell of
 * jitter into every step, and twenty steps of that random-walks a coastline
 * until it breaks into specks: measured, the simulation turned 3 landmasses
 * into 39, of which 24 were three cells or smaller. Nothing about the
 * tectonics wanted that — it was the resampling.
 */
function sampleWeights(mesh, r_xyz, x, source_r, out_r, cells, weights) {
    mesh.r_circulate_r(out_r, source_r);
    cells.length = 0;
    weights.length = 0;
    /* A compact kernel: full weight at a cell centre, falling to nothing at
     * the neighbouring centres. Inverse-distance weighting instead gives
     * every neighbour a share however close the point is to one centre, and
     * twenty steps of that averaging flattens the crust — it cost 11 points
     * of land fraction before this was made local. */
    let span = 0;
    for (const n of out_r) {
        const dx = r_xyz[3 * source_r] - r_xyz[3 * n];
        const dy = r_xyz[3 * source_r + 1] - r_xyz[3 * n + 1];
        const dz = r_xyz[3 * source_r + 2] - r_xyz[3 * n + 2];
        span += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    span = out_r.length ? span / out_r.length : 1;

    let total = 0;
    const push = (c) => {
        const dx = x[0] - r_xyz[3 * c], dy = x[1] - r_xyz[3 * c + 1], dz = x[2] - r_xyz[3 * c + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const t = 1 - d / span;
        if (t <= 0) return;
        const w = t * t;
        cells.push(c);
        weights.push(w);
        total += w;
    };
    push(source_r);
    for (const n of out_r) push(n);
    if (total <= 0) { cells.push(source_r); weights.push(1); return 1; }
    for (let i = 0; i < weights.length; i++) weights[i] /= total;
    return cells.length;
}

function sampleField(field, cells, weights) {
    let sum = 0;
    for (let i = 0; i < cells.length; i++) sum += weights[i] * field[cells[i]];
    return sum;
}

function samplePacked3(field, cells, weights, out) {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < cells.length; i++) {
        const c = 3 * cells[i], w = weights[i];
        x += w * field[c];
        y += w * field[c + 1];
        z += w * field[c + 2];
    }
    out[0] = x; out[1] = y; out[2] = z;
    return out;
}

/* A tangent vector riding with a plate: rotate with the plate, then drop
 * the radial component at the new position so it stays in the tangent plane. */
function advectTangent(out, v, pole, angle, pos) {
    rotateAbout(out, v, pole, angle);
    const d = out[0] * pos[0] + out[1] * pos[1] + out[2] * pos[2];
    out[0] -= d * pos[0];
    out[1] -= d * pos[1];
    out[2] -= d * pos[2];
    return out;
}


/* Raise arcs and collision belts along every converging margin. Extracted
 * so the Earth fixture can run the same loop in place without turning the
 * plates. Returns continent-continent contact counts, keyed "a,b". */
function paintConvergentMargins(mesh, fields, opts) {
    const {
        r_xyz, plates, r_plate, r_crust_type, r_crust_age,
        r_thickness, r_orogeny, r_orogenyDir, r_arc,
    } = fields;
    const {numRegions} = mesh;
    const {r_boundary} = classifyBoundaries(mesh, {r_xyz, r_plate, plates});
    const collisions = new Map();
    const out_r = [];
    const va = [0, 0, 0], vb = [0, 0, 0], rel = [0, 0, 0];
    for (let r = 0; r < numRegions; r++) {
        if (r_boundary[r] !== BOUNDARY_CONVERGENT) continue;
        const mine = r_plate[r];
        mesh.r_circulate_r(out_r, r);
        let facingContinental = false, facingOceanic = false, oldestFacing = -1, other = -1;
        for (const nb of out_r) {
            if (r_plate[nb] === mine) continue;
            if (r_crust_type[nb] === CRUST_CONTINENTAL) facingContinental = true;
            else { facingOceanic = true; oldestFacing = Math.max(oldestFacing, r_crust_age[nb]); }
            other = r_plate[nb];
        }
        if (other === -1) continue;

        if (r_crust_type[r] === CRUST_CONTINENTAL && facingContinental) {
            /* two continents meeting: the crust shortens and thickens */
            r_thickness[r] = Math.min(opts.crustMaxKm, r_thickness[r] + opts.collisionThickenKm);
            const added = Math.min(opts.orogenyCollision, 2 - r_orogeny[r]);
            r_orogeny[r] += added;
            if (added > 0) addOrogenyDir(r_orogenyDir, r, r_xyz, plates, mine, other, added, va, vb, rel);
            const key = other < mine ? `${other},${mine}` : `${mine},${other}`;
            collisions.set(key, (collisions.get(key) || 0) + 1);
        } else if (r_crust_type[r] === CRUST_CONTINENTAL && facingOceanic) {
            /* ocean going down beneath a continent: an Andean margin */
            r_arc[r] = Math.min(2, r_arc[r] + opts.arcContinental);
            const added = Math.min(opts.orogenyAndean, 2 - r_orogeny[r]);
            r_orogeny[r] += added;
            if (added > 0) addOrogenyDir(r_orogenyDir, r, r_xyz, plates, mine, other, added, va, vb, rel);
            r_thickness[r] = Math.min(opts.crustMaxKm, r_thickness[r] + 0.35);
        } else if (r_crust_type[r] === CRUST_OCEANIC && facingOceanic && r_crust_age[r] < oldestFacing) {
            /* the younger, lighter slab stays up and carries the arc */
            r_arc[r] = Math.min(2, r_arc[r] + opts.arcOceanic);
        }
    }
    return collisions;
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
          prevThickness = map.r_thickness, prevOrogeny = map.r_orogeny, prevArc = map.r_arc,
          prevHotspot = map.r_hotspot,
          prevOrogenyDir = map.r_orogenyDir || new Float32Array(numRegions * 3);

    /* Which way is each boundary moving, before anything turns? */
    const {r_boundary} = classifyBoundaries(mesh, map);

    /* Turn the plates. */
    for (const plate of plates) {
        const angle = plate.omega * dtMyr;
        plate.sites = plate.sites.map(s => rotateAbout([], s, plate.pole, angle));
    }
    const nextPlate = plateOwnership(mesh, map, opts);

    const nextType = new Uint8Array(numRegions);
    const nextAge = new Float32Array(numRegions);
    const nextThickness = new Float32Array(numRegions);
    const nextOrogeny = new Float32Array(numRegions);
    const nextOrogenyDir = new Float32Array(numRegions * 3);
    const nextArc = new Float32Array(numRegions);
    const nextHotspot = new Float32Array(numRegions);

    const collisions = new Map();     // "a,b" -> cells of continent-continent contact
    const gained = new Int32Array(plates.length);
    const lost = new Int32Array(plates.length);
    const out_r = [], cells = [], weights = [];
    const back = [0, 0, 0], x = [0, 0, 0];
    const sampledDir = [0, 0, 0], rotatedDir = [0, 0, 0];

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
             * flood.
             *
             * Breaking point is `riftIntactShare` of reference thickness, not
             * the ocean/continent threshold. Stretching all the way down to the
             * latter lets a margin keep drawing continental crust into new area
             * for the whole run: the model has no conservation law, so each
             * step clones the source column rather than dividing it, and
             * continental crust grows without bound. That is what took some
             * seeds from the 47% they are built with to over 60%. */
            const intactKm = opts.riftIntactShare * opts.crustReferenceKm;
            const stretched = prevType[source_r] === CRUST_CONTINENTAL
                ? prevThickness[source_r] - opts.riftThinKm : 0;
            if (stretched > intactKm) {
                nextType[r] = CRUST_CONTINENTAL;
                nextThickness[r] = stretched;
                nextAge[r] = prevAge[source_r] + dtMyr;
                nextOrogeny[r] = prevOrogeny[source_r] * opts.orogenyDecay;
                sampledDir[0] = prevOrogenyDir[3 * source_r];
                sampledDir[1] = prevOrogenyDir[3 * source_r + 1];
                sampledDir[2] = prevOrogenyDir[3 * source_r + 2];
                advectTangent(rotatedDir, sampledDir, plate.pole, plate.omega * dtMyr, x);
                nextOrogenyDir[3 * r]     = rotatedDir[0] * opts.orogenyDecay;
                nextOrogenyDir[3 * r + 1] = rotatedDir[1] * opts.orogenyDecay;
                nextOrogenyDir[3 * r + 2] = rotatedDir[2] * opts.orogenyDecay;
            } else {
                nextType[r] = CRUST_OCEANIC;
                nextAge[r] = 0;
                nextThickness[r] = opts.crustOceanKm;
            }
            gained[now]++;
            continue;
        }

        /* Everywhere else the crust simply travels with its plate. */
        sampleWeights(mesh, r_xyz, back, source_r, out_r, cells, weights);
        nextAge[r] = sampleField(prevAge, cells, weights) + dtMyr;
        nextThickness[r] = sampleField(prevThickness, cells, weights);
        nextOrogeny[r] = sampleField(prevOrogeny, cells, weights) * opts.orogenyDecay;
        nextArc[r] = sampleField(prevArc, cells, weights) * opts.orogenyDecay;
        nextHotspot[r] = sampleField(prevHotspot, cells, weights) * opts.hotspotDecay;
        samplePacked3(prevOrogenyDir, cells, weights, sampledDir);
        advectTangent(rotatedDir, sampledDir, plate.pole, plate.omega * dtMyr, x);
        nextOrogenyDir[3 * r]     = rotatedDir[0] * opts.orogenyDecay;
        nextOrogenyDir[3 * r + 1] = rotatedDir[1] * opts.orogenyDecay;
        nextOrogenyDir[3 * r + 2] = rotatedDir[2] * opts.orogenyDecay;
        if (r_boundary[r] === BOUNDARY_CONVERGENT) lost[nextPlate[r]]++;
    }

    /* Mantle plumes sit still while the plates slide over them, which is what
     * writes an age-progressive chain of volcanoes onto the moving floor. */
    if (map.hotspots) {
        const cosR = Math.cos(opts.hotspotRadius);
        for (const plume of map.hotspots) {
            for (let r = 0; r < numRegions; r++) {
                const d = r_xyz[3 * r] * plume[0] + r_xyz[3 * r + 1] * plume[1]
                        + r_xyz[3 * r + 2] * plume[2];
                if (d > cosR) nextHotspot[r] = Math.min(2, nextHotspot[r] + opts.hotspotStrength);
            }
        }
    }

    /* Crust type follows from how thick the column is, rather than being
     * carried along as its own label. Oceanic crust is a few kilometres
     * thick and continental crust tens, so the two never overlap — and a
     * derived type cannot be speckled by resampling the way a carried label
     * can. */
    for (let r = 0; r < numRegions; r++) {
        nextType[r] = nextThickness[r] > opts.crustTypeKm ? CRUST_CONTINENTAL : CRUST_OCEANIC;
    }

    /* Arcs and belts are built along a margin for as long as it is
     * converging, not only in the step when the boundary happens to sweep
     * past a cell. Ownership under a Voronoi partition changes hands over a
     * band a cell or two wide per step, so tying mountain building to that
     * band alone leaves a planet with almost no relief. The Andes are raised
     * continuously above a subducting slab; so are these. */
    const painted = paintConvergentMargins(mesh, {
        r_xyz, plates,
        r_plate: nextPlate,
        r_crust_type: nextType,
        r_crust_age: nextAge,
        r_thickness: nextThickness,
        r_orogeny: nextOrogeny,
        r_orogenyDir: nextOrogenyDir,
        r_arc: nextArc,
    }, opts);
    for (const [key, count] of painted) collisions.set(key, (collisions.get(key) || 0) + count);

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
        /* Roots relax back towards normal as the belt above them erodes. Only
         * downwards: a thickened root sinks and erodes away, but crust that has
         * been stretched thin does not re-thicken on its own. Relaxing both ways
         * makes this term fight the margin-thinning above — at shelf thickness
         * the two nearly cancel, margins stop thinning, and continental crust
         * grows without limit instead of being rifted away. */
        if (nextThickness[r] > opts.crustReferenceKm) {
            nextThickness[r] += (opts.crustReferenceKm - nextThickness[r]) * opts.rootRelax;
        }
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
    map.r_orogenyDir = nextOrogenyDir;
    map.r_arc = nextArc;
    map.r_hotspot = nextHotspot;
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
        for (const [q, count] of tally) {
            if (count > bestCount || (count === bestCount && (best === -1 || q < best))) {
                bestCount = count; best = q;
            }
        }
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


/* Subduction, done to the plates themselves.
 *
 * A plate is its sites, and until now sites were immortal: a converging
 * plate's sites marched straight through whatever stood in their way and
 * took its territory. That is not what a trench does. The slab that arrives
 * at a subduction zone goes down and is gone, and the boundary stays put,
 * pinned to the overriding plate — which is why the Caribbean can sit in
 * the closing vice between the Americas and live: the ocean floor bearing
 * down on it subducts under it instead of overrunning it.
 *
 * So: a site that finds itself on ground owned by another plate, at a
 * margin that is converging, is slab that went down the trench — it is
 * consumed. And because the sea floor consumed at trenches is made at
 * ridges, every consumed site is handed back as a new site on a spreading
 * margin, weighted by how much divergent boundary each plate has. Plates
 * with ridges grow, plates being swallowed at trenches shrink and finally
 * go, and the total never drifts. */
function subductSites(mesh, map, randFloat) {
    const {plates, r_plate, r_xyz} = map;
    const {numRegions} = mesh;
    const {r_boundary} = classifyBoundaries(mesh, map);
    const out_r = [];

    /* nearest ground still owned by plate p, walking outward from `from` */
    const bfsHome = (from, p) => {
        const queue = [from];
        const seen = new Set(queue);
        for (let h = 0; h < queue.length && h < 400; h++) {
            mesh.r_circulate_r(out_r, queue[h]);
            for (const nb of out_r) {
                if (r_plate[nb] === p) return nb;
                if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
            }
        }
        return -1;
    };

    /* Which side goes down is not who won the tug over any one cell — it is
     * density, and it is coherent along the whole margin. Ocean floor sinks
     * under a continent, older colder floor sinks under younger, and a
     * continent never sinks at all: it arrives, survives, and collides —
     * which is the whole India story. Each overridden site casts a vote
     * from the crust on its side and the crust it is standing on, and the
     * margin's majority decides for every site on it. Deciding site by
     * site instead lets the verdict flip cell to cell along a patchy
     * coast, and the half-eaten, half-pinned front that leaves was
     * measured at raggedness 4 where a clean arc scores 2. */
    const overridden = [];        // {p, i, home}
    const votes = new Map();      // "p>q" -> net vote that p subducts under q
    let hint = 0;
    for (let p = 0; p < plates.length; p++) {
        for (let i = 0; i < plates[p].sites.length; i++) {
            hint = nearestRegion(mesh, r_xyz, plates[p].sites[i], hint, out_r);
            if (r_plate[hint] === p) continue;
            /* only a converging margin consumes; a site nudged over a
               transform or a bookkeeping line is left to find its way home */
            let converging = r_boundary[hint] === BOUNDARY_CONVERGENT;
            if (!converging) {
                mesh.r_circulate_r(out_r, hint);
                for (const nb of out_r) {
                    if (r_boundary[nb] === BOUNDARY_CONVERGENT) { converging = true; break; }
                }
            }
            if (!converging) continue;

            const home = bfsHome(hint, p);
            let goesDown = true;
            if (home !== -1) {
                const mine = map.r_crust_type[home], theirs = map.r_crust_type[hint];
                if (mine === CRUST_CONTINENTAL) goesDown = false;
                else if (theirs === CRUST_OCEANIC) goesDown = map.r_crust_age[home] >= map.r_crust_age[hint];
            }
            const key = `${p}>${r_plate[hint]}`;
            votes.set(key, (votes.get(key) || 0) + (goesDown ? 1 : -1));
            overridden.push({p, i, home, key});
        }
    }
    if (overridden.length === 0) return false;

    let consumed = 0;
    const dead = new Set();
    for (const site of overridden) {
        if (votes.get(site.key) >= 0 || site.home === -1) {
            consumed++;
            dead.add(site);
            continue;
        }
        /* The overriding side steps well back from the trench, not onto its
         * lip: a site dropped on the boundary cell itself crowds the
         * Voronoi there and crinkles the margin. Retreating towards the
         * plate's nearest other site keeps the front smooth. */
        const sites = plates[site.p].sites;
        const ground = [r_xyz[3 * site.home], r_xyz[3 * site.home + 1], r_xyz[3 * site.home + 2]];
        let nearest = null, best = -2;
        for (let i = 0; i < sites.length; i++) {
            if (i === site.i) continue;
            const d = vec3.dot(sites[i], ground);
            if (d > best) { best = d; nearest = sites[i]; }
        }
        sites[site.i] = nearest
            ? vec3.normalize([], vec3.add([], ground, vec3.scale([], vec3.subtract([], nearest, ground), 0.85)))
            : ground;
    }
    if (consumed > 0) {
        for (const site of dead) plates[site.p].sites[site.i] = null;
        for (const plate of plates) plate.sites = plate.sites.filter(Boolean);
    }
    if (consumed === 0) return true;

    /* The ridges pay the trenches back. Weighted by the share of each
     * plate's own boundary that is spreading, not by raw ridge length: the
     * biggest plate always has the longest ridges, and paying by length
     * hands it nearly every recycled site, which is the same
     * rich-get-richer term that once let one plate eat the map. A plate
     * whose edge is mostly ridge is growing whatever its size; that is the
     * thing worth rewarding. */
    const ridgeCells = plates.map(() => []);
    const boundaryLen = new Int32Array(plates.length);
    for (let r = 0; r < numRegions; r++) {
        if (r_boundary[r] === BOUNDARY_NONE || plates[r_plate[r]].sites.length === 0) continue;
        boundaryLen[r_plate[r]]++;
        if (r_boundary[r] === BOUNDARY_DIVERGENT) ridgeCells[r_plate[r]].push(r);
    }
    const spreaders = [];
    const weight = new Float64Array(plates.length);
    let totalWeight = 0;
    for (let p = 0; p < plates.length; p++) {
        if (ridgeCells[p].length === 0) continue;
        weight[p] = ridgeCells[p].length / boundaryLen[p];
        spreaders.push(p);
        totalWeight += weight[p];
    }
    if (totalWeight === 0) return true;
    for (let k = 0; k < consumed; k++) {
        let pick = randFloat() * totalWeight;
        let q = spreaders[spreaders.length - 1];
        for (const p of spreaders) { pick -= weight[p]; if (pick <= 0) { q = p; break; } }
        const cell = ridgeCells[q][Math.min(ridgeCells[q].length - 1, Math.floor(randFloat() * ridgeCells[q].length))];
        const at = [r_xyz[3 * cell], r_xyz[3 * cell + 1], r_xyz[3 * cell + 2]];
        /* set the new site a little back from the ridge, towards the plate's
           nearest existing site, so it lands on its own plate's ground */
        let nearest = null, best = -2;
        for (const s of plates[q].sites) {
            const d = vec3.dot(s, at);
            if (d > best) { best = d; nearest = s; }
        }
        const site = nearest
            ? vec3.normalize([], vec3.add([], at, vec3.scale([], vec3.subtract([], nearest, at), 0.4)))
            : at;
        plates[q].sites.push(site);
    }
    return true;
}


/* Subduction consumes microplates, but it is also what makes them: a trench
 * rolls back, the plate behind it stretches, and a sliver calves off — the
 * Philippine Sea and Scotia plates both began this way. Without this birth
 * channel the microplate census only ever falls, and a 200 Myr run grinds
 * twenty plates down to nine survivors, none of them small. Pick a spot on
 * a convergent margin, weighted by how hard it is converging, and pinch off
 * a sliver of the plate there, stretched along the trench. */
function spawnBackArcPlate(mesh, map, randFloat, opts) {
    const {plates, r_plate, r_xyz} = map;
    const {numRegions} = mesh;
    const {r_boundary, r_convergence} = classifyBoundaries(mesh, map);

    let total = 0;
    const margin = [];
    for (let r = 0; r < numRegions; r++) {
        if (r_boundary[r] !== BOUNDARY_CONVERGENT || r_convergence[r] <= 0) continue;
        margin.push(r);
        total += r_convergence[r];
    }
    if (margin.length === 0) return false;
    let pick = randFloat() * total;
    let chosen = margin[margin.length - 1];
    for (const r of margin) { pick -= r_convergence[r]; if (pick <= 0) { chosen = r; break; } }

    const p = r_plate[chosen];
    const parent = plates[p];
    if (parent.sites.length < 7) return false;   // do not gut an already-small plate

    /* the local frame of the trench: normal towards the other plate, tangent
       along the margin */
    const mid = [r_xyz[3 * chosen], r_xyz[3 * chosen + 1], r_xyz[3 * chosen + 2]];
    const out_r = [];
    mesh.r_circulate_r(out_r, chosen);
    let normal = null;
    for (const nb of out_r) {
        if (r_plate[nb] === p) continue;
        normal = [r_xyz[3 * nb] - mid[0], r_xyz[3 * nb + 1] - mid[1], r_xyz[3 * nb + 2] - mid[2]];
        vec3.scaleAndAdd(normal, normal, mid, -vec3.dot(normal, mid));
        if (vec3.length(normal) < 1e-9) { normal = null; continue; }
        vec3.normalize(normal, normal);
        break;
    }
    if (!normal) return false;
    const along = vec3.normalize([], vec3.cross([], mid, normal));

    /* the sliver: the parent's sites nearest the trench, gathered with the
       same along-margin stretch the birth microplates use */
    let totalSites = 0;
    for (const plate of plates) totalSites += plate.sites.length;
    const quota = Math.max(5, Math.round(0.012 * totalSites));
    const scored = parent.sites.map((s, i) => {
        const d = angleBetween(s, mid);
        const e = vec3.scaleAndAdd([], s, mid, -vec3.dot(s, mid));
        let a = 0;
        if (vec3.length(e) > 1e-9) a = Math.abs(vec3.dot(vec3.normalize(e, e), along)) * d;
        const x = Math.sqrt(Math.max(0, d * d - a * a));
        return {s, i, cost: q9(Math.hypot(a / opts.microplateElongation, x))};
    }).sort((a, b) => a.cost - b.cost || a.i - b.i);

    const split = [], keep = [];
    for (const {s, cost} of scored) {
        /* only a sliver that actually hugs this margin; a quota filled from
           the far side of the plate would be a teleporting fragment */
        if (split.length < quota && cost < 0.5 && parent.sites.length - split.length > 4) split.push(s);
        else keep.push(s);
    }
    if (split.length < 3) return false;
    parent.sites = keep;
    plates.push({
        id: map.nextPlateId++,
        name: map.nextName(),
        sites: split,
        pole: randomUnitVector(randFloat),
        omega: randomOmega(randFloat) * opts.microplateSpin,
        scale: parent.scale || 1,
        bornMyr: map.elapsedMyr,
        parent: parent.id,
    });
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


/* A plate whose entire boundary touches a single neighbour is an enclave: a
 * hole punched in another plate. Earth has nothing of the kind — every real
 * plate's edge runs through at least two neighbours and a triple junction,
 * because plates are made by boundaries meeting, not by holes opening. An
 * enclave also cannot do anything tectonic: with one neighbour it has one
 * relative motion, so its whole margin is a single ring of the same
 * boundary type. Whatever churn created it, the surrounding plate simply
 * takes it back. */
function absorbEnclaves(mesh, map) {
    const {plates, r_plate} = map;
    const {numRegions} = mesh;
    const out_r = [];
    const touches = plates.map(() => new Set());
    for (let r = 0; r < numRegions; r++) {
        mesh.r_circulate_r(out_r, r);
        for (const nb of out_r) {
            if (r_plate[nb] !== r_plate[r]) touches[r_plate[r]].add(r_plate[nb]);
        }
    }
    let changed = false;
    for (let p = 0; p < plates.length; p++) {
        if (plates[p].sites.length === 0 || touches[p].size !== 1) continue;
        const q = touches[p].values().next().value;
        /* two plates alone on the sphere surround each other; that is a
           hemisphere pair, not an enclave */
        if (touches[q].size === 1 || plates[q].sites.length === 0) continue;
        plates[q].sites = plates[q].sites.concat(plates[p].sites);
        plates[p].sites = [];
        plates[p].absorbedInto = plates[q].id;
        changed = true;
    }
    return changed;
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


function crustToMeters(mesh, map, opts) {
    const {r_crust_type, r_crust_age, r_thickness, r_orogeny, r_arc, r_hotspot, r_boundary} = map;
    const {numRegions} = mesh;

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
            /* the broad base of an arc or a hotspot swell shallows the floor */
            meters[r] += opts.arcUpliftM * r_arc[r] * r_arc[r];
            if (r_hotspot) meters[r] += 0.35 * opts.hotspotUpliftM * Math.min(1, r_hotspot[r]);
            /* and the trench in front of an arc is the deepest thing on the planet */
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
    return meters;
}


/* Volcanic crests go on after the blend. An island arc is a ridge narrower
 * than a sim cell; averaged against the abyssal plain beside it, no island
 * it builds would survive — which is exactly what left the oceans empty.
 * Noise decides which stretches of a front crest the surface, so what
 * emerges is a chain of islands, not a wall of land.
 *
 * On the simulation mesh a cell is ~226 km, so this can only paint one
 * blob per island. The detail pass runs the same function on a finer mesh
 * with `crestFrequency` raised to match, which is the size it was written
 * for. Frequency 8 on the unit sphere is the original 10k tuning. */
function applyIslandCrests(mesh, r_xyz, meters, r_crust_type, r_arc, r_hotspot, seed, opts) {
    if (!r_arc) return meters;
    const {numRegions} = mesh;
    const crestNoise = makeFbm(new SimplexNoise(makeRandFloat(seed ^ 0x1c8f4a2d)), 3, 0.5);
    const freq = opts.crestFrequency != null ? opts.crestFrequency : 8;
    for (let r = 0; r < numRegions; r++) {
        if (r_crust_type && r_crust_type[r] !== CRUST_OCEANIC) continue;
        const arc = Math.max(0, r_arc[r] - opts.arcEmergeThreshold);
        const hot = r_hotspot ? Math.max(0, r_hotspot[r] - opts.arcEmergeThreshold) : 0;
        if (arc === 0 && hot === 0) continue;
        const x = freq * r_xyz[3 * r], y = freq * r_xyz[3 * r + 1], z = freq * r_xyz[3 * r + 2];
        const ridge = 1.6 * crestNoise(x, y, z);
        if (ridge <= 0) continue;
        meters[r] += ridge * (opts.arcCrestM * arc + opts.hotspotUpliftM * hot);
    }
    return meters;
}


function crustToElevation(mesh, map, seed, opts) {
    const {r_xyz, r_elevation} = map;
    const {numRegions} = mesh;
    const meters = crustToMeters(mesh, map, opts);
    map.r_meters = meters;
    /* The detail pass takes the crests: on this mesh they are one cell
     * wide, which is far too big. Leave them here only when nothing finer
     * is going to run. */
    if (!opts.deferCrests) {
        applyIslandCrests(mesh, r_xyz, meters, map.r_crust_type, map.r_arc, map.r_hotspot, seed, opts);
    }
    const detail = makeFbm(new SimplexNoise(makeRandFloat(seed)), 5);
    for (let r = 0; r < numRegions; r++) {
        r_elevation[r] = metersToElevation(meters[r]) +
            opts.detailNoise * detail(r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2]);
    }
    polarStraits(mesh, r_xyz, r_elevation, opts, meters);
}


/* A continent sitting on a pole is cut off from lower-latitude land by a
 * high-latitude seaway. Earth does this at both ends: Drake Passage in the
 * south, and the Arctic Ocean in the north (no polar continent at all).
 * The test is "does land fill the polar cap", not "does some land reach
 * high latitude" — otherwise North America, which merely has Arctic
 * islands, would be sliced through at 60°N. */
function polarStraits(mesh, r_xyz, r_elevation, opts, r_meters) {
    if (!opts.polarStraits) return;
    const n = mesh.numRegions;
    const capLat = opts.polarCapLat;
    const capNeed = opts.polarCapLand;
    const bandLo = opts.polarStraitLat;
    const bandHi = opts.polarStraitLat + opts.polarStraitBand;
    const straitM = opts.polarStraitM;
    const straitE = metersToElevation(straitM);
    const maxDrown = Math.max(8, (n * opts.polarStraitMaxFrac) | 0);
    const lat = new Float32Array(n);
    for (let r = 0; r < n; r++) {
        lat[r] = Math.asin(Math.max(-1, Math.min(1, r_xyz[3 * r + 2]))) * 180 / Math.PI;
    }
    const out_r = [];
    const isLand = (r) => r_elevation[r] >= 0;

    for (const sign of [1, -1]) {
        let capCells = 0, capLand = 0;
        for (let r = 0; r < n; r++) {
            if (sign * lat[r] < capLat) continue;
            capCells++;
            if (isLand(r)) capLand++;
        }
        if (capCells === 0 || capLand / capCells < capNeed) continue;
        if (opts.polarStraitOnPole !== false) {
            let poleR = 0, poleDot = -2;
            for (let r = 0; r < n; r++) {
                const d = sign * r_xyz[3 * r + 2];
                if (d > poleDot) { poleDot = d; poleR = r; }
            }
            if (!isLand(poleR)) continue;
        }

        let reachesLow = false;
        const seen = new Uint8Array(n);
        const q = [];
        for (let r = 0; r < n; r++) {
            if (sign * lat[r] < capLat || !isLand(r)) continue;
            seen[r] = 1;
            q.push(r);
        }
        for (let h = 0; h < q.length; h++) {
            if (sign * lat[q[h]] < bandLo) reachesLow = true;
            mesh.r_circulate_r(out_r, q[h]);
            for (const nb of out_r) {
                if (seen[nb] || !isLand(nb)) continue;
                seen[nb] = 1;
                q.push(nb);
            }
        }
        if (!reachesLow) continue;

        /* Cut a latitude ring through the polar mass. Lowest-first drowning
         * prefers coastal plains over a high isthmus, so the Andes can
         * keep Chile glued to Antarctica; a ring at ~60° is the Drake
         * Passage shape and only fires when the neck is actually a neck
         * (wider than maxFrac and we leave it — that is a pole-to-equator
         * supercontinent, not a strait). */
        const target = bandLo + opts.polarStraitBand * 0.5;
        const halfW = Math.max(3.5, opts.polarStraitBand * 0.4);
        const toDrown = [];
        for (let r = 0; r < n; r++) {
            if (!seen[r]) continue;
            if (Math.abs(sign * lat[r] - target) > halfW) continue;
            /* Only the neck: land both toward the pole and toward the
             * equator. A polar coast facing open ocean is not a land
             * bridge, and drowning it would saw-tooth Antarctica. */
            let towardPole = false, towardEq = false;
            mesh.r_circulate_r(out_r, r);
            for (const nb of out_r) {
                if (!isLand(nb) && !seen[nb]) continue;
                if (!isLand(nb)) continue;
                if (sign * lat[nb] > sign * lat[r] + 0.15) towardPole = true;
                if (sign * lat[nb] < sign * lat[r] - 0.15) towardEq = true;
            }
            if (towardPole && towardEq) toDrown.push(r);
        }
        if (toDrown.length === 0 || toDrown.length > maxDrown) continue;
        const marked = new Uint8Array(n);
        for (const r of toDrown) marked[r] = 1;
        for (const r of toDrown) {
            mesh.r_circulate_r(out_r, r);
            for (const nb of out_r) {
                if (marked[nb] || !seen[nb] || !isLand(nb)) continue;
                if (Math.abs(sign * lat[nb] - target) > halfW) continue;
                marked[nb] = 1;
            }
        }
        let nDrown = 0;
        for (let r = 0; r < n; r++) if (marked[r]) nDrown++;
        if (nDrown === 0 || nDrown > maxDrown) continue;
        for (let r = 0; r < n; r++) {
            if (!marked[r]) continue;
            r_elevation[r] = straitE;
            if (r_meters) r_meters[r] = straitM;
        }
    }
}


/* Runs the whole model and leaves r_elevation, the crust fields and the
 * boundary classification on `map`. */
function simulateTectonics(mesh, map, seed, options) {
    const opts = Object.assign({}, DEFAULTS, options);
    const randFloat = makeRandFloat(seed ^ 0x85ebca6b);

    /* Both fields are one value per cell, so a cached one belongs to the mesh
     * it was built for. Callers that keep a single `map` across regenerations
     * would otherwise index a 10k field with a 40k mesh, read undefined, and
     * hand NaN weights to the ownership pass — which collapses the planet to
     * a couple of plates, but only after the mesh size is changed. */
    const stamp = `${mesh.numRegions}:${seed}`;
    if (map.tectonicFieldsFor !== stamp) {
        map.boundaryWarp = makeBoundaryWarp(mesh, map.r_xyz, seed, opts);
        map.tectonicFieldsFor = stamp;
    }
    map.nextPlateId = map.nextPlateId ?? map.plates.length;
    map.elapsedMyr = 0;
    for (const plate of map.plates) plate.scale = plate.scale || 1;

    map.r_plate = plateOwnership(mesh, map, opts);
    /* Filling quotas nearest-first can leave a plate in two pieces before the
     * clock has even started, so settle the bodies once at birth too. */
    if (resolvePlateBodies(mesh, map, randFloat, opts)) {
        compactPlates(map);
        map.r_plate = plateOwnership(mesh, map, opts, map.r_plate);
    }
    if (absorbEnclaves(mesh, map)) {
        compactPlates(map);
        map.r_plate = plateOwnership(mesh, map, opts, map.r_plate);
    }
    removeNetRotation(mesh, map.plates, map.r_plate);
    Object.assign(map, initCrust(mesh, map.r_xyz, seed, opts));
    map.hotspots = Array.from({length: opts.hotspots},
        () => randomUnitVector(randFloat));

    for (let step = 0; step < opts.steps; step++) {
        map.elapsedMyr += opts.stepMyr;
        const collisions = stepTectonics(mesh, map, opts);

        let changed = subductSites(mesh, map, randFloat);
        if (weldPlates(mesh, map, collisions, opts)) changed = true;
        if (randFloat() < opts.riftChance && riftPlate(mesh, map, randFloat, opts)) changed = true;
        /* births balance deaths: back-arc slivers keep calving off the
           trenches until the census is back at strength, the way Earth's
           subduction girdle keeps its microplate belt topped up. The vice
           kills more than one microplate a step when the belt is full, so
           a big deficit is allowed two births. */
        const census = map.plates.reduce((c, plate) => c + (plate.sites.length > 0 ? 1 : 0), 0);
        const deficit = (map.targetPlateCount || 0) - census;
        for (let births = deficit > 2 ? 2 : deficit > 0 ? 1 : 0; births > 0; births--) {
            if (randFloat() < opts.backArcChance && spawnBackArcPlate(mesh, map, randFloat, opts)) changed = true;
        }
        if (retirePlates(mesh, map, opts)) changed = true;
        if (resolvePlateBodies(mesh, map, randFloat, opts)) {
            compactPlates(map);
            map.r_plate = plateOwnership(mesh, map, opts, map.r_plate);
        }
        if (changed) {
            compactPlates(map);
            map.r_plate = plateOwnership(mesh, map, opts, map.r_plate);
        }
        /* the churn above can leave a plate wholly inside another; that is
           not a configuration plates can be in, so it does not survive the
           step */
        if (absorbEnclaves(mesh, map)) {
            compactPlates(map);
            map.r_plate = plateOwnership(mesh, map, opts, map.r_plate);
            changed = true;
        }
        if (changed) removeNetRotation(mesh, map.plates, map.r_plate);
        if (opts.onStep) opts.onStep(step, map);
    }

    Object.assign(map, classifyBoundaries(mesh, map));
    crustToElevation(mesh, map, seed, opts);
    return map;
}


module.exports = {
    DEFAULTS,
    assignPlateOwnership, plateOwnership, makeBoundaryWarp,
    BOUNDARY_NONE, BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM,
    CRUST_OCEANIC, CRUST_CONTINENTAL,
    LAND_PEAK_M, LAND_POWER, OCEAN_DEPTH_M, OCEAN_POWER,
    elevationToMeters, metersToElevation,
    clamp01, smoothField, makeFbm,
    sampleWeights, sampleField, samplePacked3,
    generatePlates, removeNetRotation, absorbEnclaves,
    plateVelocity, rotateAbout, nearestRegion,
    classifyBoundaries, paintConvergentMargins,
    placeCratons, initCrust, applyBasins,
    oceanDepthMeters, continentHeightMeters,
    crustToMeters, applyIslandCrests, crustToElevation, polarStraits,
    simulateTectonics,
};
