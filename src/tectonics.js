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
const World = require('./world');

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
function assignSitesToPlates(sites, nuclei, targets, penalty = null) {
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
            pairs.push({
                d: angleBetween(sites[s], nuclei[p]) + (penalty ? penalty(s, p) : 0),
                s, p,
            });
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


function generatePlates(mesh, seed, options) {
    const opts = World.derive(Object.assign({}, World.DEFAULTS, DEFAULTS, options));
    /* Already scaled for the body by World.derive, so this is how many plates
     * *this* planet has, not how many an Earth-sized one would. */
    const numPlates = opts.plates;
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

    /* Plates fitted to the still. A birth continent large enough gets a
     * major plate seeded at its centre, and the largest shares go to those.
     * The remaining majors are seeded in the ocean, kept apart so no two
     * plates start life fighting over the same patch of sphere. Without
     * the fit the partition ignored the continents: boundaries wandered
     * through shields and the run's belts landed in interiors. */
    const birth = options.birthCrust || null;
    const continents = birth ? birthContinents(mesh, birth, opts) : [];
    const majorShares = majorTargets.map(t => t / majorSum).sort((a, b) => b - a);
    /* At least one ocean major always, and two when there are four or
       more: a Pacific and a Nazca, so the empty ocean has a ridge of its
       own instead of one plate with no neighbour to spread against. */
    const oceanMajors = numMajor >= 4 ? 2 : 1;
    const numContinental = Math.min(continents.length, Math.max(0, numMajor - oceanMajors));
    const nuclei = [];
    const nucleusType = [];
    for (let k = 0; k < numContinental; k++) {
        nuclei.push(continents[k].centre);
        nucleusType.push(CRUST_CONTINENTAL);
    }
    const out_r = [];
    let hint = 0;
    for (let p = numContinental; p < numMajor; p++) {
        let best = null, bestGap = -1;
        for (let attempt = 0; attempt < 32; attempt++) {
            const c = randomUnitVector(randFloat);
            /* an ocean plate is born in the ocean; give up on that only
               when the sphere is nearly all continent */
            if (birth && attempt < 24) {
                hint = nearestRegion(mesh, birth.r_xyz, c, hint, out_r);
                if (birth.r_crust_type[hint] === CRUST_CONTINENTAL) continue;
            }
            let gap = Infinity;
            for (const o of nuclei) gap = Math.min(gap, angleBetween(c, o));
            if (gap > bestGap || (gap === bestGap && best == null)) { bestGap = gap; best = c; }
            if (gap > opts.nucleusSeparation) break;
        }
        nuclei.push(best || randomUnitVector(randFloat));
        nucleusType.push(CRUST_OCEANIC);
    }
    const sites = scatterSites(numPlates * opts.sitesPerPlate, randFloat);
    /* a site on the other crust type pays a toll to join a nucleus, so a
       continent's sites stay with the plate that carries it */
    let penalty = null, siteType = null;
    if (birth) {
        siteType = sites.map(s => {
            hint = nearestRegion(mesh, birth.r_xyz, s, hint, out_r);
            return birth.r_crust_type[hint];
        });
        penalty = (s, p) => siteType[s] === nucleusType[p] ? 0 : opts.siteToll;
    }
    /* the majors take the whole sphere between them; the minors are carved
       back out of their edges afterwards */
    const owner = assignSitesToPlates(sites, nuclei, majorShares, penalty);

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
            origin: 'birth',
        });
    }
    carveMicroplates(plates, sites, owner, targets.slice(numMajor), opts, randFloat, nextName, siteType);
    for (let s = 0; s < sites.length; s++) plates[owner[s]].sites.push(sites[s]);
    /* A plate whose sites mostly stand on continent carries it, and a
       carried continent does not move: the still is stamped back every
       step. So the plate turns slowly, or it would leave its continent
       behind and the fit would be gone by the end of the run. */
    if (birth) {
        for (const plate of plates) {
            let cont = 0;
            for (const s of plate.sites) {
                hint = nearestRegion(mesh, birth.r_xyz, s, hint, out_r);
                if (birth.r_crust_type[hint] === CRUST_CONTINENTAL) cont++;
            }
            plate.continental = plate.sites.length > 0 && cont * 2 >= plate.sites.length;
            if (plate.continental) plate.omega *= opts.continentalDrag;
        }
    }
    const result = {
        plates: plates.filter(p => p.sites.length > 0),   // a nucleus with nothing is not a plate
        nextName,
        targetPlateCount: numPlates,   // the census the simulation keeps the planet topped up to
    };
    if (birth) result.birthCrust = birth;
    return result;
}


/* The birth continents large enough to carry a plate, largest first:
 * connected continental crust with its centre and its share of the
 * surface. */
function birthContinents(mesh, birth, opts) {
    const n = mesh.numRegions;
    const isLand = new Uint8Array(n);
    for (let r = 0; r < n; r++) isLand[r] = birth.r_crust_type[r] === CRUST_CONTINENTAL ? 1 : 0;
    const {id, size, nC} = landComponents(mesh, isLand, n);
    const list = [];
    for (let c = 0; c < nC; c++) {
        if (size[c] < opts.continentPlateMin * n) continue;
        const pick = new Uint8Array(n);
        for (let r = 0; r < n; r++) if (id[r] === c) pick[r] = 1;
        const centre = vec3.normalize([], meanXyz(birth.r_xyz, pick, n));
        list.push({centre, share: size[c] / n});
    }
    list.sort((a, b) => b.share - a.share);
    return list;
}


/* A plate born from another keeps its parent's kind. A piece of a plate
 * that carries continent still carries it, so it drags like one. */
function childMotion(parent, randFloat, opts, spin = 1) {
    const continental = !!parent.continental;
    return {
        pole: randomUnitVector(randFloat),
        omega: randomOmega(randFloat) * spin * (continental ? opts.continentalDrag : 1),
        continental,
    };
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
function carveMicroplates(plates, sites, owner, minorTargets, opts, randFloat, nextName, siteType = null) {
    const n = sites.length;
    if (minorTargets.length === 0 || plates.length < 2) return;
    /* Minors are born in the ocean. Cocos, Juan de Fuca, Scotia and the
     * Philippine Sea are all oceanic; Arabia and Anatolia are the
     * exceptions. A minor carved out of land sites is a boundary through
     * a shield, and every boundary through a shield is a belt. */
    const onLand = (s) => siteType != null && siteType[s] === CRUST_CONTINENTAL;

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
    const oceanPair = (c) => onLand(c.s) || onLand(c.t) ? 0 : 1;
    const ranked = candidates.filter(c => c.mid).sort((a, b) =>
        oceanPair(b) - oceanPair(a) || b.closing - a.closing || a.s - b.s || a.t - b.t);

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
            /* a land site is the last one a sliver takes */
            cost.push(q9(Math.hypot(a / opts.microplateElongation, x) * (onLand(s) ? 3 : 1)));
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
            origin: 'birth',
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


function makeBoundaryWarp(mesh, r_xyz, seed, opts, r_crust_type = null) {
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
    /* and a step across a coast costs more, so a front arriving from the
       ocean stops at the shore rather than pushing on through the shield */
    const type = r_crust_type ? Uint8Array.from(r_crust_type) : null;
    const toll = opts.marginToll;
    if (!type || !(toll > 1)) return (a2, b2) => 0.5 * (field[a2] + field[b2]);
    return (a2, b2) => {
        const w = 0.5 * (field[a2] + field[b2]);
        return type[a2] !== type[b2] ? w * toll : w;
    };
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


/* Present strength decays. Peak and age-since-refresh do not: Shape still
 * needs an extinct arc and an old hotspot track after the volcanoes stop.
 * `before` is present as it was after advection, before this step's paint. */
function refreshLifetime(present, peak, age, before, dtMyr, n) {
    for (let r = 0; r < n; r++) {
        if (present[r] > before[r] + 1e-6) age[r] = 0;
        else if (peak[r] > 0 || present[r] > 0) age[r] += dtMyr;
        if (present[r] > peak[r]) peak[r] = present[r];
    }
}


/* Earth has no step log. After authored paint, peak is whatever present is. */
function stampLifetime(map) {
    const n = (map.r_arc && map.r_arc.length) || 0;
    if (!map.r_arcPeak) map.r_arcPeak = new Float32Array(n);
    if (!map.r_arcAge) map.r_arcAge = new Float32Array(n);
    if (!map.r_arcDir) map.r_arcDir = new Float32Array(n * 3);
    if (!map.r_hotspotPeak) map.r_hotspotPeak = new Float32Array(n);
    if (!map.r_hotspotAge) map.r_hotspotAge = new Float32Array(n);
    for (let r = 0; r < n; r++) {
        if (map.r_arc && map.r_arc[r] > map.r_arcPeak[r]) map.r_arcPeak[r] = map.r_arc[r];
        if (map.r_hotspot && map.r_hotspot[r] > map.r_hotspotPeak[r]) {
            map.r_hotspotPeak[r] = map.r_hotspot[r];
        }
    }
    return map;
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
    plates: 20,                   // at Earth's radius. Plate size is set by the
                                  // convecting mantle beneath, which is a length
                                  // rather than a share of the sphere, so a smaller
                                  // planet carries fewer of them — see World.derive

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
    marginToll: 5,                // ownership step cost across a coast, as a multiple
                                  // of a step over ocean or interior. A boundary that
                                  // meets a continent stops at its shore instead of
                                  // wandering through the shield. 1 disables the fit
    siteToll: 0.35,               // radians added to a site's distance from a nucleus
                                  // on the other crust type, so a continent's sites
                                  // join the plate that carries it
    continentalDrag: 0.3,         // omega multiplier for a plate carrying a continent.
                                  // The still does not move. A plate that turned 70°
                                  // over the run would leave its continent behind
    continentPlateMin: 0.03,      // a birth continent at least this share of the
                                  // surface gets a major plate seeded at its centre
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
    cratonElongation: 0.20,       // log-sigma of how stretched a shield is. Low:
                                  // a fat mass. A peninsula sets its own stretch.
    cratonTaper: 0.22,            // how much one end of a shield narrows
    continentBlocks: 1.0,         // extra composed pieces on top of the shield.
                                  // 0 is a single cap. 1 is lobe, peninsula,
                                  // sliver, satellites — whatever the still rolls
    blockSpread: 0.80,            // lobe spacing as a fraction of summed radii.
                                  // ~0.8 is a waist. Past ~1 the lobe detaches.
                                  // 0.48 fused every extra into the shield.
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
    gulfCut: 0.36,                // sparse inlets; the coast language is facets, not
                                  // noise chewing a blob
    bayCut: 0.08,                 // smaller bays
    coastGrain: 0.05,             // a little edge grain
    coastOctave: 0.08,            // radians of shoreline swing at two to five cells:
                                  // headlands, coves, a shelf island. The gulf and
                                  // bay cuts stop at ~800 km; below that the coast
                                  // was a level set of an ellipse. In radians, not
                                  // block radii, so an island gets the same octave
                                  // as a shield. Additive on a smooth distance
                                  // field: it cannot string the coast out
    shelfVary: 0.25,              // regional swing in shelf width. One margin
                                  // drowned wide, another a cliff, the way the Sunda
                                  // shelf and the Pacific coasts differ
    cratonShatter: 0.04,          // a few outer shelves break into islands
    coastContrast: 0.4,           // regional variation in coast raggedness: some
                                  // margins calm, some shattered
    cratonClustering: 0.82,       // chance a craton huddles against the others.
                                  // Below ~0.6 too many strike out and the land
                                  // sprinkles; this is what leaves a Pacific-sized ocean
    cratonMinSeparation: 1.08,    // radians; huddled continents should kiss, not
                                  // swallow each other. 0.70 still fused three
                                  // Thalos cratons into one blob. The Pacific is
                                  // from clustering, not from overlap.
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
    riftCratonShare: 0.90,        // share of crustReferenceKm a column must beat
                                  // to count as a shield when a ridge sits on
                                  // already-continental ground. Below this, a
                                  // suture sag on a divergent cell may open.
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
    arcRibbonM: 420,              // extinct-arc island body (Curaçao), not a cone
    ridgePlateauM: 1100,          // plume sitting on a spreading ridge (Iceland)
    arcRemnantMyr: 40,            // after this, an arc is a ribbon even if present lingers
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


function midpointSphere(a, b) {
    const m = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const len = Math.hypot(m[0], m[1], m[2]) || 1;
    return [m[0] / len, m[1] / len, m[2] / len];
}


function tangentToward(from, to) {
    const d = vec3.dot(from, to);
    const t = [to[0] - d * from[0], to[1] - d * from[1], to[2] - d * from[2]];
    if (Math.hypot(t[0], t[1], t[2]) < 1e-9) {
        const ref = Math.abs(from[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        vec3.cross(t, from, ref);
    }
    vec3.normalize(t, t);
    return t;
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
            const type = roll < 0.50 ? SUTURE_BELT : roll < 0.62 ? SUTURE_SAG : SUTURE_NONE;
            types[i * nB + j] = types[j * nB + i] = type;
        }
    }
    return types;
}


/* A continent is a composed still, not a chain of equal discs and not a
 * 200 Myr accident. Earth's masses are a fat shield with a few accreted
 * pieces: a waist, a peninsula, a drowned join. A lone ellipse is a blob.
 * A chain that walks away from the mass is a sausage.
 *
 * So: one dominant shield, then independently a lobe, a hooked peninsula,
 * a sliver, satellites. Facets are the default margin language. Joins
 * between huddled continents — isthmus, enclosed sea, open seaway — are
 * cut afterwards in planCuts. Matching coasts from a later rift are a
 * later trial.
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

    const continent = [], weights = [], elong = [], taper = [], kind = [];
    const firstBlock = [];
    for (let k = 0; k < nC; k++) {
        const frac = cShares[k] / cTotal;
        let want = 1;
        if (frac >= 0.22) want = 3;
        else if (frac >= 0.08) want = 2;
        want = Math.max(1, Math.round(1 + (want - 1) * opts.continentBlocks));

        const lobe = want >= 2 && randFloat() < (want >= 3 ? 0.78 : 0.58);
        const peninsula = want >= 2 && randFloat() < 0.50;
        const sliver = want >= 3 && randFloat() < 0.58;
        let nSat = 0;
        if (frac >= 0.16 && randFloat() < 0.62) nSat++;
        if (frac >= 0.28 && randFloat() < 0.40) nSat++;
        if (frac >= 0.08 && nSat === 0 && randFloat() < 0.35) nSat = 1;

        const extras = [];
        if (lobe) extras.push('lobe');
        if (peninsula) extras.push('peninsula');
        if (sliver) extras.push('sliver');
        for (let s = 0; s < nSat; s++) extras.push('satellite');

        firstBlock.push(continent.length);
        continent.push(k);
        kind.push('shield');
        elong.push(Math.min(continents.elong[k], Math.exp(0.18 * Math.abs(gauss()))));
        taper.push(continents.taper[k] * 0.7);
        const sub = [1];
        for (const e of extras) {
            continent.push(k);
            kind.push(e);
            if (e === 'peninsula') {
                elong.push(2.5 + 0.9 * randFloat());
                taper.push(0.22 + 0.16 * randFloat());
                sub.push(0.24 * Math.exp(0.25 * gauss()));
            } else if (e === 'sliver') {
                elong.push(2.8 + 1.0 * randFloat());
                taper.push(0.25 + 0.12 * randFloat());
                sub.push(0.10 * Math.exp(0.2 * gauss()));
            } else if (e === 'satellite') {
                elong.push(1.7 + 1.3 * randFloat());
                taper.push(0.12 * randFloat());
                sub.push(0.055 * Math.exp(0.2 * gauss()));
            } else {
                elong.push(1.15 + 0.40 * randFloat());
                taper.push(0.08 * (2 * randFloat() - 1));
                sub.push(0.34 * Math.exp(0.25 * gauss()));
            }
        }
        const subTotal = sub.reduce((a, b) => a + b, 0);
        for (let i = 0; i < sub.length; i++) {
            weights.push(cShares[k] * sub[i] / subTotal);
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

    const bearingOf = (P, k, dir) => {
        const f = frameFromTangent(P, continents.axes[k].u);
        return Math.atan2(
            dir[0] * f.v[0] + dir[1] * f.v[1] + dir[2] * f.v[2],
            dir[0] * f.u[0] + dir[1] * f.u[1] + dir[2] * f.u[2]);
    };

    const OFFSETS = [0, 0.79, -0.79, 1.57, -1.57, 2.36, -2.36, 3.14];
    for (let b = 0; b < nB; b++) {
        const k = continent[b];
        if (b === firstBlock[k]) { pos1[b] = continents.centres[k]; continue; }

        /* Every extra block hangs off the shield. A peninsula hooks off a
         * lobe when there is one, so the two wrap a pocket. A satellite
         * prefers the open ocean. */
        parent[b] = firstBlock[k];
        const P = pos1[parent[b]];
        const what = kind[b];
        let preferred;
        if (what === 'peninsula' || what === 'sliver') {
            let hook = -1;
            for (let j = firstBlock[k]; j < b; j++) {
                if (kind[j] === 'lobe' && radii[j] > 0) { hook = j; break; }
            }
            if (hook >= 0) {
                const sign = randFloat() < 0.5 ? 1 : -1;
                const span = what === 'sliver'
                    ? 0.55 + 0.35 * randFloat()
                    : 1.15 + 0.40 * randFloat();
                preferred = bearing[hook] + sign * span;
            } else {
                preferred = 2 * Math.PI * randFloat();
            }
        } else if (what === 'satellite') {
            let ax = 0, ay = 0, az = 0, nAway = 0;
            for (let j = 0; j < nC; j++) {
                if (j === k) continue;
                ax += P[0] - continents.centres[j][0];
                ay += P[1] - continents.centres[j][1];
                az += P[2] - continents.centres[j][2];
                nAway++;
            }
            if (nAway === 0) {
                preferred = 2 * Math.PI * randFloat();
            } else {
                preferred = bearingOf(P, k, tangentToward(P, [P[0] + ax, P[1] + ay, P[2] + az]));
                preferred += 0.5 * (randFloat() - 0.5);
            }
        } else {
            preferred = 2 * Math.PI * randFloat() + 0.9 * (randFloat() - 0.5);
        }

        if (what === 'satellite') {
            spread[b] = 1.15 + 0.35 * randFloat();
        } else if (what === 'peninsula' || what === 'sliver') {
            spread[b] = opts.blockSpread * (1.05 + 0.25 * randFloat());
        } else {
            spread[b] = opts.blockSpread * (0.85 + 0.30 * randFloat());
        }
        const arc = spread[b] * (radii[parent[b]] + radii[b]);

        const maxReach = (what === 'satellite' ? 1.85 : 1.15) * continents.radii[k];
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
     * the block's grown end — a peninsula or sliver gets one most often. */
    const facets = [];
    const gain = opts.blockFacets;
    for (let b = 0; b < nB; b++) {
        const list = [];
        facets.push(list);
        if (!(radii[b] > 0) || !gain) continue;
        const pen = kind[b] === 'peninsula' || kind[b] === 'sliver';
        if (kind[b] === 'satellite') {
            if (randFloat() < 0.4) {
                list.push({theta: 2 * Math.PI * randFloat(), off: 0.55 + 0.25 * randFloat()});
            }
            continue;
        }
        if (pen || randFloat() < gain * 0.55) {
            const az = (taper[b] >= 0 ? 0 : Math.PI) + 0.7 * (randFloat() - 0.5);
            const phi = (pen ? 0.22 : 0.32) + 0.20 * randFloat();
            const reach = (pen ? 0.92 : 0.80) + 0.18 * randFloat();
            /* Reach is against the ellipse's extent along the azimuth, so
             * a stretched block keeps its full length. */
            const ca = Math.cos(az), sa = Math.sin(az);
            const stretch = Math.sqrt(ca * ca / elong[b] + sa * sa * elong[b])
                / (1 + taper[b] * ca);
            const off = reach * Math.sin(phi) / stretch;
            list.push({theta: az + (Math.PI / 2 - phi), off, gate: az});
            list.push({theta: az - (Math.PI / 2 - phi), off, gate: az});
        }
        if (!pen && randFloat() < gain * 0.55) {
            list.push({theta: 2 * Math.PI * randFloat(), off: 0.50 + 0.28 * randFloat()});
        }
    }

    return {
        radii, elong, taper, facets, materialize,
        sutureType: drawSutureTypes(nB, randFloat), nB, continent, kind,
    };
}


/* Joins and inland seas are composed, not rolled as round ponds in the
 * interior. The Earth fixture authors the same kinds of cut directly. */
function planCuts(placement, plan, scale, randFloat, opts) {
    const {centres, axes} = plan.materialize(scale);
    const radii = plan.radii.map(r => r * scale);
    const nC = placement.centres.length;
    const continent = plan.continent;
    const kind = plan.kind || [];
    const fills = [];
    const stamps = [];
    const bCentres = [], bRadii = [], bAxes = [], bElong = [], bTaper = [], bFloor = [];

    const addBasin = (centre, radius, ax, elong, floorKm) => {
        if (!(radius > 0.05)) return;
        bCentres.push(centre);
        bRadii.push(radius);
        bAxes.push(ax);
        bElong.push(elong);
        bTaper.push(0);
        bFloor.push(floorKm);
    };

    const cBlocks = Array.from({length: nC}, () => []);
    for (let b = 0; b < plan.nB; b++) {
        if (radii[b] > 0) cBlocks[continent[b]].push(b);
    }

    const pairs = [];
    for (let i = 0; i < nC; i++) {
        for (let j = i + 1; j < nC; j++) {
            let best = null, bestGap = Infinity;
            for (const a of cBlocks[i]) {
                for (const b of cBlocks[j]) {
                    const d = angleBetween(centres[a], centres[b]);
                    const gap = d - radii[a] - radii[b];
                    if (gap < bestGap) {
                        bestGap = gap;
                        best = {a, b, d, i, j};
                    }
                }
            }
            if (best && bestGap <= 0.28) pairs.push({...best, gap: bestGap});
        }
    }
    pairs.sort((p, q) => p.gap - q.gap);

    const nJoins = Math.min(2, pairs.length);
    for (let n = 0; n < nJoins; n++) {
        const pair = pairs[n];
        const A = centres[pair.a], B = centres[pair.b];
        const M = midpointSphere(A, B);
        const along = tangentToward(M, B);
        const frame = frameFromTangent(M, along);
        const sideSign = randFloat() < 0.5 ? 1 : -1;
        const side = [
            frame.v[0] * sideSign, frame.v[1] * sideSign, frame.v[2] * sideSign,
        ];
        const overlap = Math.max(0, -pair.gap);
        const seaWidth = 0.14 + 0.08 * randFloat() + 0.40 * overlap;
        const seaLength = Math.max(0.34, 0.58 * Math.min(radii[pair.a], radii[pair.b]));
        const seaElong = Math.max(2.8, seaLength / seaWidth);
        const seaR = Math.sqrt(seaLength * seaWidth);
        const seaAxes = {u: frame.v, v: frame.u};

        if (n === 0) {
            /* Drown one flank of the join — that sea is the Caribbean.
             * The other flank stays land, which is the bridge. A cut
             * through the middle left two islands and no waist. */
            const seaPos = walkSphere(M, side, 0.12 + 0.12 * overlap);
            addBasin(seaPos, Math.max(seaR, 0.20), seaAxes, Math.max(3.2, seaElong),
                14 + 4 * randFloat());
            const back = [-side[0], -side[1], -side[2]];
            const length = Math.max(0.26, pair.d * 0.72);
            const width = 0.12 + 0.03 * randFloat();
            stamps.push({
                centre: walkSphere(M, back, 0.035),
                radius: Math.sqrt(length * width),
                axes: frame,
                elong: Math.max(2.3, length / width),
                taper: 0,
                thicknessKm: opts.seaLevelThicknessKm + 3.5,
            });
            const nIsl = 2 + (randFloat() < 0.65 ? 1 : 0);
            const far = walkSphere(M, side, 0.24 + 0.10 * overlap);
            for (let s = 0; s < nIsl; s++) {
                const t = (s - (nIsl - 1) / 2) * (0.12 + 0.05 * randFloat());
                const pos = walkSphere(far, frame.u, t);
                stamps.push({
                    centre: pos,
                    radius: 0.10 + 0.05 * randFloat(),
                    axes: frameFromTangent(pos, frame.u),
                    elong: 1.8 + 1.4 * randFloat(),
                    taper: 0.08 * randFloat(),
                    thicknessKm: opts.crustReferenceKm,
                });
            }
        } else {
            /* Long sea that opens at the rim, not a round pond in the
             * interior. Offset toward one ocean so a strait exists. */
            if (pair.gap > 0.02) {
                const length = Math.max(0.24, pair.d * 0.75);
                const width = 0.14 + 0.06 * randFloat();
                fills.push({
                    centre: M,
                    radius: Math.sqrt(length * width),
                    axes: frame,
                    elong: Math.max(1.4, length / width),
                    taper: 0,
                    thicknessKm: opts.crustReferenceKm,
                });
            }
            addBasin(walkSphere(M, side, 0.06), seaR * 1.1, seaAxes,
                Math.max(3.8, seaElong + 1.4), 15 + 4 * randFloat());
            if (randFloat() < 0.82) {
                const fromA = randFloat() < 0.5;
                const from = fromA ? A : B;
                const src = fromA ? pair.a : pair.b;
                const dir = tangentToward(from, M);
                const pos = walkSphere(from, dir, radii[src] * 0.55);
                stamps.push({
                    centre: pos,
                    radius: 0.095 + 0.035 * randFloat(),
                    axes: frameFromTangent(pos, dir),
                    elong: 3.2 + 0.8 * randFloat(),
                    taper: 0.24,
                    thicknessKm: opts.crustReferenceKm,
                });
            }
        }
    }

    const shares = placement.shares || placement.centres.map(() => 1);
    const total = shares.reduce((a, b) => a + b, 0) || 1;
    for (let k = 0; k < nC; k++) {
        const blocks = cBlocks[k];
        if (blocks.length === 0) continue;
        const shield = blocks[0];
        const R = radii[shield];

        for (const p of blocks) {
            if (kind[p] !== 'peninsula') continue;
            if (randFloat() > 0.75) continue;
            const d = angleBetween(centres[shield], centres[p]);
            if (d < 0.28) continue;
            const M = midpointSphere(centres[shield], centres[p]);
            const along = tangentToward(M, centres[p]);
            const frame = frameFromTangent(M, along);
            addBasin(walkSphere(M, frame.v, 0.04), 0.13 + 0.07 * randFloat(),
                {u: frame.v, v: frame.u}, 3.4 + 1.2 * randFloat(), 16 + 5 * randFloat());
        }

        if (shares[k] / total < 0.12 || randFloat() > 0.72) continue;
        let ax = 0, ay = 0, az = 0, nAway = 0;
        for (let j = 0; j < nC; j++) {
            if (j === k) continue;
            ax += centres[shield][0] - placement.centres[j][0];
            ay += centres[shield][1] - placement.centres[j][1];
            az += centres[shield][2] - placement.centres[j][2];
            nAway++;
        }
        const C = centres[shield];
        const cutDir = nAway === 0
            ? (axes[shield] && axes[shield].u) || placement.axes[k].u
            : tangentToward(C, [C[0] + ax, C[1] + ay, C[2] + az]);
        const frame = frameFromTangent(C, cutDir);
        const spin = 0.8 * (randFloat() - 0.5);
        const cs = Math.cos(spin), ss = Math.sin(spin);
        const dir = [
            frame.u[0] * cs + frame.v[0] * ss,
            frame.u[1] * cs + frame.v[1] * ss,
            frame.u[2] * cs + frame.v[2] * ss,
        ];
        const pos = walkSphere(C, dir, (0.55 + 0.22 * randFloat()) * R);
        addBasin(pos, (0.26 + 0.14 * randFloat()) * R, frameFromTangent(pos, dir),
            2.8 + 1.4 * randFloat(), 17 + 6 * randFloat());
    }

    return {
        fills,
        stamps,
        basins: bCentres.length
            ? {centres: bCentres, radii: bRadii, axes: bAxes, elong: bElong, taper: bTaper, floorKm: bFloor}
            : null,
    };
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
    const r_arcPeak = new Float32Array(numRegions);
    const r_arcAge = new Float32Array(numRegions);
    const r_arcDir = new Float32Array(numRegions * 3);
    const r_hotspot = new Float32Array(numRegions);
    const r_hotspotPeak = new Float32Array(numRegions);
    const r_hotspotAge = new Float32Array(numRegions);

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
    /* The cell octave. At N = 10k a cell is ~0.035 rad; 44 on the unit
     * sphere is a four-cell wavelength, and the second octave is two. */
    const octave = new Float32Array(numRegions);
    const shelf = new Float32Array(numRegions);
    const octaveNoise = makeFbm(new SimplexNoise(makeRandFloat(seed ^ 0x3c6ef372)), 2, 0.5);
    const shelfNoise = new SimplexNoise(makeRandFloat(seed ^ 0x7f4a7c15));
    const GULF_F = 9, BAY_F = 16, GRAIN_F = 24, OCTAVE_F = 44, SHELF_F = 3;
    for (let r = 0; r < numRegions; r++) {
        const x = r_xyz[3 * r], y = r_xyz[3 * r + 1], z = r_xyz[3 * r + 2];
        gulf[r] = gulfNoise(GULF_F * x, GULF_F * y, GULF_F * z);
        bay[r] = bayNoise(BAY_F * x, BAY_F * y, BAY_F * z);
        grain[r] = grainNoise(GRAIN_F * x, GRAIN_F * y, GRAIN_F * z);
        contrast[r] = 1 + opts.coastContrast * contrastNoise(x, y, z);
        octave[r] = octaveNoise(OCTAVE_F * x, OCTAVE_F * y, OCTAVE_F * z);
        shelf[r] = shelfNoise.noise3D(SHELF_F * x, SHELF_F * y, SHELF_F * z);
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
            /* Full strength from the shoreline out to the rim, fading into
             * the interior. Divided by the block's radius so the swing is
             * the same number of cells on every block. */
            const mOct = smooth01(0.45, 0.85, raw);
            const oct = w * (opts.coastOctave / (radii[b1] * scale)) * octave[r] * mOct;
            depth[r] = raw + cut + wig + oct;
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
    const scale = (lo + hi) / 2;
    measure(scale, true);

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
        /* the shoreline sits further out where the shelf is narrow, and
           further in where a wide shelf drowns the rim */
        const shoreHere = Math.min(0.97, Math.max(0.05, shore * (1 + opts.shelfVary * shelf[r])));
        const base = d < shoreHere
            /* interior: a coastal plain climbing to a flat platform at the
               equilibrium thickness. Not a dome — distance from the coast
               says nothing about how high a real continent stands */
            ? opts.seaLevelThicknessKm + (opts.crustReferenceKm - opts.seaLevelThicknessKm) *
              smooth01(0, opts.coastalPlain, 1 - d / shoreHere)
            /* the shelf, between the shoreline and the edge of the craton */
            : opts.crustShelfKm + (opts.seaLevelThicknessKm - opts.crustShelfKm) * (1 - d) / (1 - shoreHere);
        /* then the weld running through here, if any: an old belt stands
           up as rounded highlands, a sag floods into a shallow sea */
        r_thickness[r] = sutureKm[r]
            ? Math.max(opts.crustMinKm, Math.min(opts.crustMaxKm, base + sutureKm[r]))
            : base;
    }
    applyBasins(r_xyz, r_thickness, r_crust_type, opts, null);
    if (!opts.basinPlacement && !opts.cratonPlacement) {
        applyCuts(r_xyz, r_thickness, r_crust_type,
            planCuts(placement, plan, scale, randFloat, opts), opts);
    }
    return {
        r_crust_type, r_crust_age, r_thickness, r_orogeny, r_orogenyDir,
        r_arc, r_arcPeak, r_arcAge, r_arcDir,
        r_hotspot, r_hotspotPeak, r_hotspotAge,
    };
}


/* Enclosed seas — Mediterranean, Hudson Bay — are drowned continental
 * crust, not ocean floor. A basin is the same stretched cap as a craton
 * but it thins the column until it sits below sea level. The Earth
 * fixture authors a few; the random path cuts joins in planCuts. */
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


function stampCaps(r_xyz, r_thickness, r_crust_type, caps, opts) {
    if (!caps || caps.length === 0) return;
    const n = r_thickness.length;
    const p = [0, 0, 0], t = [0, 0, 0];
    const minLand = opts.seaLevelThicknessKm + 0.8;
    for (const cap of caps) {
        if (!(cap.radius > 0)) continue;
        const thick = Math.max(minLand, cap.thicknessKm || opts.crustReferenceKm);
        for (let r = 0; r < n; r++) {
            p[0] = r_xyz[3 * r]; p[1] = r_xyz[3 * r + 1]; p[2] = r_xyz[3 * r + 2];
            const d = capDistance(p, cap.centre, cap.axes, cap.elong, cap.taper || 0, t) / cap.radius;
            if (d >= 1) continue;
            r_crust_type[r] = CRUST_CONTINENTAL;
            const w = Math.pow(1 - d, 1.2);
            const next = r_thickness[r] * (1 - w) + thick * w;
            r_thickness[r] = Math.max(r_thickness[r], next, minLand);
        }
    }
}


function applyCuts(r_xyz, r_thickness, r_crust_type, cuts, opts) {
    if (!cuts) return;
    stampCaps(r_xyz, r_thickness, r_crust_type, cuts.fills, opts);
    if (cuts.basins) {
        applyBasins(r_xyz, r_thickness, r_crust_type,
            Object.assign({}, opts, {basinPlacement: cuts.basins}), null);
    }
    stampCaps(r_xyz, r_thickness, r_crust_type, cuts.stamps, opts);
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


/* Thickness must not average a shield with the neighbouring abyssal
 * column. Twenty steps of that mix drop the margin below crustTypeKm
 * and the type pass turns it to ocean — which is what ate land once
 * rifts stopped cloning crust back into the gap. */
function sampleFieldMatching(field, cells, weights, type, want) {
    let sum = 0, w = 0;
    for (let i = 0; i < cells.length; i++) {
        if (type[cells[i]] !== want) continue;
        sum += weights[i] * field[cells[i]];
        w += weights[i];
    }
    if (w <= 0) return field[cells[0]];
    return sum / w;
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
        r_thickness, r_orogeny, r_orogenyDir, r_arc, r_arcDir,
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
            if (r_arcDir) addOrogenyDir(r_arcDir, r, r_xyz, plates, mine, other, opts.arcContinental, va, vb, rel);
            const added = Math.min(opts.orogenyAndean, 2 - r_orogeny[r]);
            r_orogeny[r] += added;
            if (added > 0) addOrogenyDir(r_orogenyDir, r, r_xyz, plates, mine, other, added, va, vb, rel);
            r_thickness[r] = Math.min(opts.crustMaxKm, r_thickness[r] + 0.35);
        } else if (r_crust_type[r] === CRUST_OCEANIC && facingOceanic && r_crust_age[r] < oldestFacing) {
            /* the younger, lighter slab stays up and carries the arc */
            r_arc[r] = Math.min(2, r_arc[r] + opts.arcOceanic);
            if (r_arcDir) addOrogenyDir(r_arcDir, r, r_xyz, plates, mine, other, opts.arcOceanic, va, vb, rel);
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

    const zeros = new Float32Array(numRegions);
    const zeros3 = new Float32Array(numRegions * 3);
    const prevType = map.r_crust_type, prevAge = map.r_crust_age,
          prevThickness = map.r_thickness, prevOrogeny = map.r_orogeny, prevArc = map.r_arc,
          prevHotspot = map.r_hotspot,
          prevOrogenyDir = map.r_orogenyDir || zeros3,
          prevArcPeak = map.r_arcPeak || zeros,
          prevArcAge = map.r_arcAge || zeros,
          prevArcDir = map.r_arcDir || zeros3,
          prevHotPeak = map.r_hotspotPeak || zeros,
          prevHotAge = map.r_hotspotAge || zeros;

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
    const nextArcPeak = new Float32Array(numRegions);
    const nextArcAge = new Float32Array(numRegions);
    const nextArcDir = new Float32Array(numRegions * 3);
    const nextHotspot = new Float32Array(numRegions);
    const nextHotPeak = new Float32Array(numRegions);
    const nextHotAge = new Float32Array(numRegions);

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
            /* A ridge in the ocean is new floor. A ridge that has landed
             * on a continent is not: thick crust holds and advects. Copying
             * a continental column into a cell that was ocean is the clone
             * that grew some seeds from 47% crust to 69%. Writing ocean
             * over a cell that was already continent eats the margin one
             * ring per step — 20 steps ate some seeds down to 10% land.
             * Conservation is: do not create continent at a ridge, and do
             * not destroy a shield because a boundary doodle crossed it.
             * Already-thin crust on a divergent cell (suture sag, shelf)
             * may still open. */
            const holdKm = opts.crustReferenceKm * opts.riftCratonShare;
            const sourceCont = prevType[source_r] === CRUST_CONTINENTAL;
            const hereCont = prevType[r] === CRUST_CONTINENTAL
                && prevThickness[r] >= holdKm;
            if (!(sourceCont && hereCont)) {
                nextType[r] = CRUST_OCEANIC;
                nextAge[r] = 0;
                nextThickness[r] = opts.crustOceanKm;
                gained[now]++;
                continue;
            }
        }

        /* Everywhere else the crust simply travels with its plate. */
        sampleWeights(mesh, r_xyz, back, source_r, out_r, cells, weights);
        nextAge[r] = sampleField(prevAge, cells, weights) + dtMyr;
        nextThickness[r] = sampleFieldMatching(
            prevThickness, cells, weights, prevType, prevType[source_r]);
        nextOrogeny[r] = sampleField(prevOrogeny, cells, weights) * opts.orogenyDecay;
        nextArc[r] = sampleField(prevArc, cells, weights) * opts.orogenyDecay;
        nextArcPeak[r] = sampleField(prevArcPeak, cells, weights);
        nextArcAge[r] = sampleField(prevArcAge, cells, weights);
        nextHotspot[r] = sampleField(prevHotspot, cells, weights) * opts.hotspotDecay;
        nextHotPeak[r] = sampleField(prevHotPeak, cells, weights);
        nextHotAge[r] = sampleField(prevHotAge, cells, weights);
        samplePacked3(prevOrogenyDir, cells, weights, sampledDir);
        advectTangent(rotatedDir, sampledDir, plate.pole, plate.omega * dtMyr, x);
        nextOrogenyDir[3 * r]     = rotatedDir[0] * opts.orogenyDecay;
        nextOrogenyDir[3 * r + 1] = rotatedDir[1] * opts.orogenyDecay;
        nextOrogenyDir[3 * r + 2] = rotatedDir[2] * opts.orogenyDecay;
        samplePacked3(prevArcDir, cells, weights, sampledDir);
        advectTangent(rotatedDir, sampledDir, plate.pole, plate.omega * dtMyr, x);
        nextArcDir[3 * r]     = rotatedDir[0];
        nextArcDir[3 * r + 1] = rotatedDir[1];
        nextArcDir[3 * r + 2] = rotatedDir[2];
        if (r_boundary[r] === BOUNDARY_CONVERGENT) lost[nextPlate[r]]++;
    }

    /* Mantle plumes sit still while the plates slide over them, which is what
     * writes an age-progressive chain of volcanoes onto the moving floor. */
    const hotBefore = Float32Array.from(nextHotspot);
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
    refreshLifetime(nextHotspot, nextHotPeak, nextHotAge, hotBefore, dtMyr, numRegions);

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
    const arcBefore = Float32Array.from(nextArc);
    const painted = paintConvergentMargins(mesh, {
        r_xyz, plates,
        r_plate: nextPlate,
        r_crust_type: nextType,
        r_crust_age: nextAge,
        r_thickness: nextThickness,
        r_orogeny: nextOrogeny,
        r_orogenyDir: nextOrogenyDir,
        r_arc: nextArc,
        r_arcDir: nextArcDir,
    }, opts);
    refreshLifetime(nextArc, nextArcPeak, nextArcAge, arcBefore, dtMyr, numRegions);
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
    map.r_arcPeak = nextArcPeak;
    map.r_arcAge = nextArcAge;
    map.r_arcDir = nextArcDir;
    map.r_hotspot = nextHotspot;
    map.r_hotspotPeak = nextHotPeak;
    map.r_hotspotAge = nextHotAge;
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
            ...childMotion(parent, randFloat, opts),
            scale: parent.scale || 1,
            bornMyr: map.elapsedMyr,
            parent: parent.id,
            origin: 'piece',
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
        ...childMotion(parent, randFloat, opts, opts.microplateSpin),
        scale: parent.scale || 1,
        bornMyr: map.elapsedMyr,
        parent: parent.id,
        origin: 'backarc',
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
        ...childMotion(plate, randFloat, opts),
        scale: plate.scale || 1,
        bornMyr: map.elapsedMyr,
        parent: plate.id,
        origin: 'rift',
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
    /* A marginal-sea arc is a ribbon one cell wide between a basin and
       the deep ocean. Blended against either it goes under, so it is
       smoothed only along itself and reaches Shape as a body: runs of
       islands where the floor is young, straits where it is old. */
    smoothField(mesh, meters, map.r_seaArc || null, opts.coastBlend);
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
    if (!r_arc && !r_hotspot) return meters;
    const {numRegions} = mesh;
    const ribbon = opts.islandBody === 'ribbon';
    const plateau = opts.islandBody === 'plateau';
    const body = ribbon || plateau;
    const crestNoise = makeFbm(new SimplexNoise(makeRandFloat(seed ^ 0x1c8f4a2d)), 3, 0.5);
    const freq = opts.crestFrequency != null ? opts.crestFrequency : 8;
    const emerge = body ? 0 : opts.arcEmergeThreshold;
    const ampArc = ribbon ? opts.arcRibbonM : opts.arcCrestM;
    const ampHot = plateau ? opts.ridgePlateauM : opts.hotspotUpliftM;
    for (let r = 0; r < numRegions; r++) {
        if (r_crust_type && r_crust_type[r] !== CRUST_OCEANIC) continue;
        const arc = r_arc ? Math.max(0, r_arc[r] - emerge) : 0;
        const hot = r_hotspot ? Math.max(0, r_hotspot[r] - emerge) : 0;
        if (arc === 0 && hot === 0) continue;
        const x = freq * r_xyz[3 * r], y = freq * r_xyz[3 * r + 1], z = freq * r_xyz[3 * r + 2];
        const n = crestNoise(x, y, z);
        /* A ribbon or plateau is a body, not a peak. Negative noise must
         * not punch a hole in the sausage. */
        const ridge = body ? 0.72 + 0.28 * n : 1.6 * n;
        if (!body && ridge <= 0) continue;
        if (body) {
            /* A Curaçao ribbon is a few hundred metres above the sea, not
             * 420 m on top of the abyss — that never emerges. Lift the
             * cell to that height. */
            const dest = ridge * (
                ampArc * Math.min(1, arc) + ampHot * Math.min(1, hot));
            if (dest > meters[r]) meters[r] = dest;
        } else {
            meters[r] += ridge * (ampArc * arc + ampHot * hot);
        }
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
    const grain = new Float32Array(numRegions);
    for (let r = 0; r < numRegions; r++) {
        grain[r] = opts.detailNoise * detail(r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2]);
        r_elevation[r] = metersToElevation(meters[r]) + grain[r];
    }
    polarStraits(mesh, r_xyz, r_elevation, opts, meters);
    solveSeaLevel(mesh, r_elevation, meters, grain, opts);
}


/* Put sea level where the planet has the land fraction it was asked for.
 *
 * How much of a planet is dry is set by how much water it has, not by how
 * much continental crust it grew — `seaLevelThicknessKm` has always been the
 * dial for that, but it is expressed in crustal thickness and lands wherever
 * it lands. `landFraction` states the target directly and this solves for it,
 * so the figure is exact and the same on every seed rather than drifting with
 * the roll. Null leaves sea level alone, which is what the model did before.
 *
 * No iteration is needed. A cell is land when
 *
 *     metersToElevation(meters - shift) + grain > 0
 *
 * and metersToElevation is monotonic, so that is just
 *
 *     shift < meters - elevationToMeters(-grain)
 *
 * Sorting that per-cell threshold gives the shift for any land count
 * directly. Counting cells rather than area is deliberate: `stats` counts
 * cells, and a solve that targeted a different quantity than the measurement
 * would report a land fraction nobody asked for.
 */
function solveSeaLevel(mesh, r_elevation, meters, grain, opts) {
    if (opts.landFraction == null) return;
    const n = mesh.numRegions;
    const want = Math.round(Math.min(1, Math.max(0, opts.landFraction)) * n);

    const threshold = new Float64Array(n);
    for (let r = 0; r < n; r++) threshold[r] = meters[r] - elevationToMeters(-grain[r]);
    const sorted = Float64Array.from(threshold).sort();

    /* Land is every cell whose threshold beats the shift, so `want` of them
     * means cutting between the want-th largest and the one below it. */
    let shift;
    if (want <= 0) shift = sorted[n - 1] + 1;
    else if (want >= n) shift = sorted[0] - 1;
    else shift = 0.5 * (sorted[n - want - 1] + sorted[n - want]);
    if (!Number.isFinite(shift)) return;

    for (let r = 0; r < n; r++) {
        meters[r] -= shift;
        r_elevation[r] = metersToElevation(meters[r]) + grain[r];
    }
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


function hopDistance(mesh, seed, n) {
    const dist = new Int32Array(n).fill(-1);
    const q = [];
    for (let r = 0; r < n; r++) {
        if (!seed[r]) continue;
        dist[r] = 0;
        q.push(r);
    }
    const nb = [];
    for (let h = 0; h < q.length; h++) {
        mesh.r_circulate_r(nb, q[h]);
        for (const k of nb) {
            if (dist[k] >= 0) continue;
            dist[k] = dist[q[h]] + 1;
            q.push(k);
        }
    }
    return dist;
}


/* Same walk, but it will not cross ocean. A belt grows into the mass it
 * sits on. Hopping through water painted the same profile onto the far
 * shore of a seaway. */
function hopDistanceLand(mesh, seed, isLand, n) {
    const dist = new Int32Array(n).fill(-1);
    const q = [];
    for (let r = 0; r < n; r++) {
        if (!seed[r] || !isLand[r]) continue;
        dist[r] = 0;
        q.push(r);
    }
    const nb = [];
    for (let h = 0; h < q.length; h++) {
        mesh.r_circulate_r(nb, q[h]);
        for (const k of nb) {
            if (!isLand[k] || dist[k] >= 0) continue;
            dist[k] = dist[q[h]] + 1;
            q.push(k);
        }
    }
    return dist;
}


function landComponents(mesh, isLand, n) {
    const id = new Int32Array(n).fill(-1);
    const size = [];
    const nb = [];
    let nC = 0;
    for (let r = 0; r < n; r++) {
        if (!isLand[r] || id[r] >= 0) continue;
        const q = [r];
        id[r] = nC;
        for (let h = 0; h < q.length; h++) {
            mesh.r_circulate_r(nb, q[h]);
            for (const k of nb) {
                if (!isLand[k] || id[k] >= 0) continue;
                id[k] = nC;
                q.push(k);
            }
        }
        size.push(q.length);
        nC++;
    }
    return {id, size, nC};
}


function meanXyz(r_xyz, pick, n) {
    const c = [0, 0, 0];
    let w = 0;
    for (let r = 0; r < n; r++) {
        if (!pick[r]) continue;
        c[0] += r_xyz[3 * r];
        c[1] += r_xyz[3 * r + 1];
        c[2] += r_xyz[3 * r + 2];
        w++;
    }
    if (w === 0) return [0, 0, 1];
    const len = Math.hypot(c[0], c[1], c[2]) || 1;
    return [c[0] / len, c[1] / len, c[2] / len];
}


function distToGeodesic(p, a, b) {
    const n0 = a[1] * b[2] - a[2] * b[1];
    const n1 = a[2] * b[0] - a[0] * b[2];
    const n2 = a[0] * b[1] - a[1] * b[0];
    const len = Math.hypot(n0, n1, n2) || 1;
    return Math.abs(Math.asin(Math.max(-1, Math.min(1, (p[0] * n0 + p[1] * n1 + p[2] * n2) / len))));
}


function onShortArc(p, a, b) {
    const m = midpointSphere(a, b);
    return angleBetween(p, m) <= 0.5 * angleBetween(a, b) + 0.12;
}


function setStrike(dir, r, pos, along) {
    const d = along[0] * pos[0] + along[1] * pos[1] + along[2] * pos[2];
    const t = [along[0] - d * pos[0], along[1] - d * pos[1], along[2] - d * pos[2]];
    const len = Math.hypot(t[0], t[1], t[2]) || 1;
    dir[3 * r] = t[0] / len;
    dir[3 * r + 1] = t[1] / len;
    dir[3 * r + 2] = t[2] / len;
}


/* A tectonic story, authored, not accumulated. The 200 Myr run paints
 * sea-floor age from plate motion and leaves its final boundaries. Belts
 * are authored shapes placed by those boundaries: a coastal chain where
 * an ocean plate converges on a continent, a collision plateau where two
 * continental sides converge, shoulders around a valley where
 * continental crust diverges, a fault range on a transform, an
 * escarpment on a passive margin with young floor off it, an island arc
 * on the young side of an ocean trench. Width and height follow the
 * closing speed the run measured, so a fast trench builds an Andes and
 * a slow one a coast range. The Earth fixture does not run this pass. It
 * paints from authored plate margins.
 *
 * The run's own orogeny is wiped first. It accumulated wherever a
 * boundary swept during the run, which is a smear, not a belt. */
function composeTectonicStory(mesh, map, randFloat, opts) {
    const {r_xyz, r_crust_type, r_plate, plates, r_crust_age} = map;
    const n = mesh.numRegions;
    const thick = map.r_thickness;
    const seaKm = opts.seaLevelThicknessKm;

    /* Marginal seas. A small plate that calved off a margin behind a
     * trench is the Sea of Japan story: the basin behind the arc floods
     * and the sliver in front carries the volcanoes. A small plate wedged
     * between masses under extension is the Caribbean. One under
     * compression stays highland, the way Anatolia does. The drowned
     * crust stays continental, like every enclosed sea here, and it
     * deepens with hops in from the edge, so the shoreline lands on a
     * blended contour inside the boundary rather than on it. */
    const seaArc = new Uint8Array(n);
    const nb0 = [];
    if (thick && map.r_boundary) {
        const bType = map.r_boundary;
        const nP = plates.length;
        const area = new Int32Array(nP), land = new Int32Array(nP), shore = new Int32Array(nP);
        const conv = new Int32Array(nP), ext = new Int32Array(nP);
        const touches = Array.from({length: nP}, () => new Set());
        const edge = new Uint8Array(n);
        const seaward = new Uint8Array(n);   /* a cell with water beside it at birth */
        for (let r = 0; r < n; r++) {
            const p = r_plate[r];
            area[p]++;
            if (r_crust_type[r] === CRUST_CONTINENTAL && thick[r] >= seaKm) land[p]++;
            mesh.r_circulate_r(nb0, r);
            let ocean = r_crust_type[r] === CRUST_OCEANIC;
            for (const q of nb0) {
                if (r_crust_type[q] === CRUST_OCEANIC) { ocean = true; seaward[r] = 1; }
                else if (thick[q] < seaKm) seaward[r] = 1;   /* shelf or basin counts as water */
                if (r_plate[q] === p) continue;
                edge[r] = 1;
                touches[p].add(r_plate[q]);
            }
            if (ocean) shore[p]++;
            if (edge[r]) {
                if (bType[r] === BOUNDARY_CONVERGENT) conv[p]++;
                else if (bType[r] !== BOUNDARY_NONE) ext[p]++;
            }
        }
        /* Along the arc, runs of islands and straits between them: a slow
           noise decides which stretches stand up. Per-cell crest noise
           gave specks; the Antilles are islands hundreds of km long. */
        const arcNoise = new SimplexNoise(randFloat);
        for (let p = 0; p < nP; p++) {
            if (area[p] < 20 || area[p] > 0.06 * n) continue;
            if (land[p] * 2 < area[p] || touches[p].size < 2) continue;
            /* marginal means on the margin: a landlocked one drowned into a
               round pond, which is the interior-sea failure this repo
               already knows */
            if (shore[p] < 5) continue;
            const backArc = plates[p].origin === 'backarc';
            const extension = ext[p] / Math.max(1, conv[p] + ext[p]);
            if (!backArc && extension < 0.45) continue;
            /* hops in from the plate's own edge */
            const dist = new Int32Array(n).fill(-1);
            const q = [];
            for (let r = 0; r < n; r++) {
                if (r_plate[r] === p && edge[r]) { dist[r] = 0; q.push(r); }
            }
            for (let h = 0; h < q.length; h++) {
                mesh.r_circulate_r(nb0, q[h]);
                for (const k of nb0) {
                    if (r_plate[k] !== p || dist[k] >= 0) continue;
                    dist[k] = dist[q[h]] + 1;
                    q.push(k);
                }
            }
            for (const r of q) {
                if (r_crust_type[r] !== CRUST_CONTINENTAL) continue;
                if (seaward[r] && thick[r] >= seaKm) {
                    /* The arc is the basin's seaward rim, whichever way
                       today's motion points: Japan is the ocean-facing
                       edge of its sea. It is young oceanic arc crust, not
                       a sliver of shield; a continental ribbon one cell
                       wide was averaged into the basin and never
                       surfaced. Its base sits just under the waterline so
                       the crest noise leaves straits between islands, and
                       the sea behind it opens to the ocean through them.
                       Put on the landward edge instead, it fused into a
                       hooked peninsula. */
                    r_crust_type[r] = CRUST_OCEANIC;
                    thick[r] = opts.crustOceanKm;
                    if (map.r_crust_age) {
                        const x = r_xyz[3 * r], y = r_xyz[3 * r + 1], z = r_xyz[3 * r + 2];
                        /* young floor plus the arc uplift stands a few
                           hundred metres up; older floor stays a strait */
                        map.r_crust_age[r] = arcNoise.noise3D(6 * x, 6 * y, 6 * z) > -0.25 ? 12 : 60;
                    }
                    seaArc[r] = 1;
                } else {
                    const floor = dist[r] === 0 ? seaKm - 4 : dist[r] === 1 ? seaKm - 7 : seaKm - 11;
                    thick[r] = Math.min(thick[r], floor);
                }
            }
        }
    }

    map.r_seaArc = seaArc;

    /* Land is continental crust standing above sea level: not the shelf,
     * not a drowned basin. Belts crest a cell in from the shoreline. */
    const isLand = new Uint8Array(n);
    for (let r = 0; r < n; r++) {
        isLand[r] = r_crust_type[r] === CRUST_CONTINENTAL && (!thick || thick[r] >= seaKm) ? 1 : 0;
    }

    const {id: comp, size, nC} = landComponents(mesh, isLand, n);
    if (nC === 0) return;

    const landPole = meanXyz(r_xyz, isLand, n);
    const pacific = [-landPole[0], -landPole[1], -landPole[2]];

    const oceanSeed = new Uint8Array(n);
    for (let r = 0; r < n; r++) oceanSeed[r] = isLand[r] ? 0 : 1;
    const landDist = hopDistance(mesh, oceanSeed, n); /* 0 on ocean, hops inland */
    const toLand = hopDistance(mesh, isLand, n);      /* 0 on land, hops offshore */

    const nb = [];
    const posOf = (r) => [r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2]];
    const isCoast = new Uint8Array(n);
    const oceanDir = new Float32Array(n * 3);
    for (let r = 0; r < n; r++) {
        if (!isLand[r]) continue;
        mesh.r_circulate_r(nb, r);
        let ox = 0, oy = 0, oz = 0, nOcean = 0;
        for (const k of nb) {
            if (isLand[k]) continue;
            ox += r_xyz[3 * k] - r_xyz[3 * r];
            oy += r_xyz[3 * k + 1] - r_xyz[3 * r + 1];
            oz += r_xyz[3 * k + 2] - r_xyz[3 * r + 2];
            nOcean++;
        }
        if (nOcean === 0) continue;
        isCoast[r] = 1;
        const pos = posOf(r);
        const t = tangentToward(pos, [pos[0] + ox, pos[1] + oy, pos[2] + oz]);
        oceanDir[3 * r] = t[0];
        oceanDir[3 * r + 1] = t[1];
        oceanDir[3 * r + 2] = t[2];
    }

    /* The boundaries as the run left them, and how hard each is closing. */
    const {r_boundary, r_convergence} = map.r_boundary && map.r_convergence
        ? map : classifyBoundaries(mesh, {r_xyz, r_plate, plates});
    const vRef = PLATE_OMEGA_MEAN;

    /* Unit tangent at a boundary cell, pointing at the plate across it. */
    const acrossDir = (r) => {
        let ox = 0, oy = 0, oz = 0, k = 0;
        mesh.r_circulate_r(nb, r);
        for (const q of nb) {
            if (r_plate[q] === r_plate[r]) continue;
            ox += r_xyz[3 * q] - r_xyz[3 * r];
            oy += r_xyz[3 * q + 1] - r_xyz[3 * r + 1];
            oz += r_xyz[3 * q + 2] - r_xyz[3 * r + 2];
            k++;
        }
        if (k === 0) return null;
        const pos = posOf(r);
        return tangentToward(pos, [pos[0] + ox, pos[1] + oy, pos[2] + oz]);
    };

    /* Breadth-first from one cell, calling visit(r, depth) on each cell
     * within `reach` hops; visit returns true to stop. */
    const walk = (start, reach, visit) => {
        const queue = [start], depth = [0];
        const seen = new Set(queue);
        for (let h = 0; h < queue.length; h++) {
            const r = queue[h], d = depth[h];
            if (visit(r, d)) return true;
            if (d >= reach) continue;
            mesh.r_circulate_r(nb, r);
            for (const q of nb) {
                if (seen.has(q)) continue;
                seen.add(q);
                queue.push(q);
                depth.push(d + 1);
            }
        }
        return false;
    };

    /* A boundary through land: this cell has a land neighbour on another
     * plate. The line itself is the axis of whatever it is doing. */
    const INLAND_COLLISION = 1, INLAND_RIFT = 2, INLAND_TRANSFORM = 3;
    const inland = new Uint8Array(n);
    for (let r = 0; r < n; r++) {
        if (!isLand[r] || seaArc[r] || r_boundary[r] === BOUNDARY_NONE || size[comp[r]] < 28) continue;
        let acrossLand = false;
        mesh.r_circulate_r(nb, r);
        for (const q of nb) {
            if (r_plate[q] !== r_plate[r] && isLand[q]) { acrossLand = true; break; }
        }
        if (!acrossLand) continue;
        const type = r_boundary[r];
        inland[r] = type === BOUNDARY_CONVERGENT ? INLAND_COLLISION
            : type === BOUNDARY_DIVERGENT ? INLAND_RIFT : INLAND_TRANSFORM;
    }

    /* A coast reads the nearest boundary on its own plate's edge. A
     * convergent one facing continent is a collision, facing ocean an
     * active margin. Nothing within reach is a passive margin. */
    const MARGIN_ACTIVE = 1, MARGIN_COLLISION = 2, MARGIN_RIFT = 3, MARGIN_TRANSFORM = 4;
    const REACH = 2;
    const margin = new Uint8Array(n);
    const closing = new Float32Array(n);
    for (let c = 0; c < n; c++) {
        if (!isCoast[c] || inland[c] || seaArc[c] || size[comp[c]] < 28) continue;
        const mine = r_plate[c];
        let b = -1;
        walk(c, REACH, (r) => {
            if (r_boundary[r] === BOUNDARY_NONE) return false;
            let edge = r_plate[r] === mine;
            if (!edge) {
                mesh.r_circulate_r(nb, r);
                for (const q of nb) if (r_plate[q] === mine) { edge = true; break; }
            }
            if (edge) b = r;
            return edge;
        });
        if (b < 0) continue;
        const type = r_boundary[b];
        if (type === BOUNDARY_CONVERGENT) {
            /* a collision needs a mass across the boundary; a sliver of
               someone else's land within reach is an accident of the
               partition, not India */
            let facingLand = 0;
            walk(b, 3, (r) => {
                if (r !== b && isLand[r] && r_plate[r] !== mine) facingLand++;
                return facingLand >= 5;
            });
            margin[c] = facingLand >= 5 ? MARGIN_COLLISION : MARGIN_ACTIVE;
        } else if (type === BOUNDARY_DIVERGENT) {
            margin[c] = MARGIN_RIFT;
        } else {
            margin[c] = MARGIN_TRANSFORM;
        }
        closing[c] = Math.abs(r_convergence[b]);
    }
    for (let r = 0; r < n; r++) if (inland[r]) closing[r] = Math.abs(r_convergence[r]);

    /* One strength per stretch of margin, not per cell: the mean closing
     * speed over the neighbouring cells of the same kind, against the
     * typical plate speed. A patchy per-cell strength gave a belt that
     * bulged and pinched every few cells. */
    const kindOf = (r) => margin[r] ? margin[r] : inland[r] ? 10 + inland[r] : 0;
    const strength = new Float32Array(n);
    for (let c = 0; c < n; c++) {
        const kind = kindOf(c);
        if (!kind) continue;
        let sum = 0, k = 0;
        walk(c, 4, (r) => {
            if (kindOf(r) !== kind) return false;
            sum += closing[r];
            k++;
            return false;
        });
        strength[c] = Math.min(1.2, Math.max(0.4, (sum / k) / vRef));
    }

    /* Wipe the run's land belts and ocean arcs. Keep ocean age and
     * hotspots. */
    if (!map.r_orogeny) map.r_orogeny = new Float32Array(n);
    if (!map.r_orogenyDir) map.r_orogenyDir = new Float32Array(n * 3);
    if (!map.r_arc) map.r_arc = new Float32Array(n);
    if (!map.r_arcDir) map.r_arcDir = new Float32Array(n * 3);
    const {r_orogeny, r_orogenyDir, r_arc, r_arcDir, r_thickness} = map;
    for (let r = 0; r < n; r++) {
        r_orogeny[r] = 0;
        r_orogenyDir[3 * r] = r_orogenyDir[3 * r + 1] = r_orogenyDir[3 * r + 2] = 0;
        r_arc[r] = 0;
        r_arcDir[3 * r] = r_arcDir[3 * r + 1] = r_arcDir[3 * r + 2] = 0;
    }

    for (let r = 0; r < n; r++) {
        if (!seaArc[r]) continue;
        r_arc[r] = 1.2;
        const across = acrossDir(r);
        setStrike(r_arcDir, r, posOf(r),
            across ? vec3.cross([], posOf(r), across) : vec3.cross([], posOf(r), pacific));
    }

    /* Strike at every seed: along the coast, or along the boundary. */
    const alongOf = new Float32Array(n * 3);
    for (let r = 0; r < n; r++) {
        let a = null;
        if (inland[r]) {
            const across = acrossDir(r);
            if (across) a = vec3.cross([], posOf(r), across);
        }
        if (!a && isCoast[r]) {
            a = vec3.cross([], posOf(r), [oceanDir[3 * r], oceanDir[3 * r + 1], oceanDir[3 * r + 2]]);
        }
        if (!a) continue;
        alongOf[3 * r] = a[0];
        alongOf[3 * r + 1] = a[1];
        alongOf[3 * r + 2] = a[2];
    }
    const alongAt = (seed) => {
        const a = [alongOf[3 * seed], alongOf[3 * seed + 1], alongOf[3 * seed + 2]];
        return a[0] === 0 && a[1] === 0 && a[2] === 0 ? vec3.cross([], posOf(seed), pacific) : a;
    };

    /* Land-only fill from a set of seeds, remembering which seed reached
     * each cell. Hopping through water painted the same profile onto the
     * far shore of a seaway. */
    const fillFrom = (isSeed) => {
        const dist = new Int32Array(n).fill(-1);
        const from = new Int32Array(n).fill(-1);
        const q = [];
        for (let r = 0; r < n; r++) {
            if (!isSeed(r)) continue;
            dist[r] = 0;
            from[r] = r;
            q.push(r);
        }
        for (let h = 0; h < q.length; h++) {
            mesh.r_circulate_r(nb, q[h]);
            for (const k of nb) {
                if (!isLand[k] || dist[k] >= 0) continue;
                dist[k] = dist[q[h]] + 1;
                from[k] = from[q[h]];
                q.push(k);
            }
        }
        return {dist, from};
    };

    /* The belt shapes, in cells from the seed. A chain rises to a crest
     * one cell in and decays. A collision holds a flat top: the plateau.
     * Width and crest scale with the closing speed. */
    const beltGain = (kind, d, s) => {
        if (kind === 'active') {
            /* the Andes are two to four cells at this grain; a fast,
               long-lived trench earns a Cordillera of five or six */
            const W = 2 + 1.5 * s, peak = 0.9 * Math.min(1, 0.6 + 0.4 * s);
            if (d >= W) return 0;
            if (d < 1) return peak * 0.5;
            return peak * Math.pow((W - d) / (W - 1), 1.5);
        }
        if (kind === 'coll') {
            /* a crest at the front, then the plateau, then the decay */
            const W = 2 + 2 * s, top = Math.max(1, Math.floor(0.5 * W)), peak = 0.85;
            if (d >= W) return 0;
            if (d === 0) return 0.55;
            if (d <= top) return peak;
            return peak * Math.pow((W - d) / (W - top), 1.4);
        }
        if (kind === 'rift') return [0, 0.45, 0.30, 0.12][d] || 0;        /* shoulders */
        if (kind === 'riftCoast') return [0.25, 0.40, 0.22, 0.08][d] || 0; /* rifted margin */
        if (kind === 'transform') return [0.25, 0.35, 0.12][d] || 0;
        return 0;
    };
    const residualProfile = [0.38, 0.72, 0.48, 0.24, 0.10];
    const escarpProfile = [0.30, 1.0, 0.60, 0.25];

    const paintBelt = (r, gain, kind, along) => {
        if (gain <= r_orogeny[r]) return;
        r_orogeny[r] = gain;
        const pos = posOf(r);
        setStrike(r_orogenyDir, r, pos, along);
        if (kind === 'active') {
            r_arc[r] = Math.max(r_arc[r], 0.4 * gain);
            setStrike(r_arcDir, r, pos, along);
        }
        if (r_thickness) {
            /* Collision stacks a wide root (Tibet). A chain is narrower.
             * A worn belt is thickness with little ridge gain. */
            const extra = kind === 'coll' ? 9 * gain
                : kind === 'active' ? 4.5 * gain
                : kind === 'escarp' ? 5 * gain
                : kind === 'old' ? 3.5 * gain
                : 3 * gain;
            r_thickness[r] = Math.min(opts.crustMaxKm, r_thickness[r] + extra);
        }
    };

    const paintKind = (isSeed, kind) => {
        const {dist, from} = fillFrom(isSeed);
        for (let r = 0; r < n; r++) {
            if (dist[r] < 0) continue;
            const g = beltGain(kind, dist[r], strength[from[r]]);
            if (g > 0) paintBelt(r, g, kind, alongAt(from[r]));
        }
    };
    paintKind(r => margin[r] === MARGIN_COLLISION || inland[r] === INLAND_COLLISION, 'coll');
    paintKind(r => margin[r] === MARGIN_ACTIVE, 'active');
    paintKind(r => inland[r] === INLAND_RIFT, 'rift');
    paintKind(r => margin[r] === MARGIN_RIFT, 'riftCoast');
    paintKind(r => margin[r] === MARGIN_TRANSFORM || inland[r] === INLAND_TRANSFORM, 'transform');

    /* The rift itself: a valley along the axis. From the coast the sea
     * runs in along it, further the faster it opens: a Red Sea, and a
     * seaway where the axis crosses a narrow mass. Inland of that the
     * floor sits at sea level, where Shape's lakes go. */
    if (r_thickness) {
        const along = new Int32Array(n).fill(-1);
        const q = [];
        for (let r = 0; r < n; r++) {
            if (inland[r] === INLAND_RIFT && landDist[r] <= 1) { along[r] = 0; q.push(r); }
        }
        for (let h = 0; h < q.length; h++) {
            mesh.r_circulate_r(nb, q[h]);
            for (const k of nb) {
                if (inland[k] !== INLAND_RIFT || along[k] >= 0) continue;
                along[k] = along[q[h]] + 1;
                q.push(k);
            }
        }
        for (let r = 0; r < n; r++) {
            if (inland[r] !== INLAND_RIFT) continue;
            const reach = 5 + 5 * strength[r];
            const floor = along[r] >= 0 && along[r] <= reach
                ? opts.seaLevelThicknessKm - 2.5
                : opts.seaLevelThicknessKm + 0.3;
            r_thickness[r] = Math.min(r_thickness[r], floor);
            r_orogeny[r] = 0;
        }
    }

    /* A passive margin with young floor off it still stands up: the rift
     * shoulder that southern Africa's escarpment and Brazil's serras are.
     * Old floor is a worn margin. A slow noise leaves some stretches as
     * coastal plain, so not every quiet coast is a wall. */
    const escNoise = new SimplexNoise(randFloat);
    const escSeed = new Uint8Array(n);
    const escGain = new Float32Array(n);
    for (let c = 0; c < n; c++) {
        if (!isCoast[c] || margin[c] || inland[c] || size[comp[c]] < 28) continue;
        let youngest = Infinity;
        walk(c, 3, (r) => {
            if (!isLand[r]) youngest = Math.min(youngest, r_crust_age[r]);
            return false;
        });
        const young = youngest === Infinity ? 0 : clamp01(1 - youngest / 140);
        const p = posOf(c);
        const mod = smooth01(0.1, 0.7, escNoise.noise3D(5 * p[0], 5 * p[1], 5 * p[2]));
        const g = (0.15 + 0.4 * young) * mod;
        if (g < 0.08) continue;
        escSeed[c] = 1;
        escGain[c] = g;
    }
    {
        const {dist, from} = fillFrom(r => escSeed[r]);
        for (let r = 0; r < n; r++) {
            if (dist[r] < 0 || dist[r] >= escarpProfile.length) continue;
            paintBelt(r, escarpProfile[dist[r]] * escGain[from[r]], 'escarp', alongAt(from[r]));
        }
    }

    /* A real front on the coast: what the residual and load passes below
     * read as "this mass has an active side". */
    const front = new Uint8Array(n);
    for (let r = 0; r < n; r++) {
        if (margin[r] === MARGIN_ACTIVE || margin[r] === MARGIN_COLLISION
                || inland[r] === INLAND_COLLISION) front[r] = 1;
    }

    /* A large mass with no active margin still has a high side. On Earth
     * that is an old orogen or a failed rift (Great Dividing Range,
     * Appalachians). Without it the shield is a pancake. Only the most
     * open stretch of coast is marked, so the rest stays a passive back. */
    const residual = new Uint8Array(n);
    for (let c = 0; c < nC; c++) {
        if (size[c] < 70) continue;
        let beltCoast = 0, landCells = 0;
        for (let r = 0; r < n; r++) {
            if (comp[r] !== c) continue;
            landCells++;
            if (front[r]) beltCoast++;
        }
        /* A handful of Andean cells on a peninsula is not a margin for
         * the whole shield. Residual still fires unless a real front
         * already occupies the coast. */
        if (beltCoast > Math.max(8, landCells * 0.03)) continue;
        const scored = [];
        for (let r = 0; r < n; r++) {
            if (comp[r] !== c || !isCoast[r]) continue;
            let open = 0, nOcean = 0;
            mesh.r_circulate_r(nb, r);
            for (const k of nb) {
                if (isLand[k]) continue;
                open += toLand[k];
                nOcean++;
            }
            if (nOcean) scored.push({r, s: open / nOcean});
        }
        if (scored.length < 6) continue;
        scored.sort((a, b) => b.s - a.s);
        const keep = Math.max(5, Math.floor(scored.length * 0.26));
        for (let i = 0; i < keep; i++) residual[scored[i].r] = 1;
    }
    {
        const {dist, from} = fillFrom(r => residual[r]);
        for (let r = 0; r < n; r++) {
            if (dist[r] < 0 || dist[r] >= residualProfile.length || r_orogeny[r] > 0) continue;
            paintBelt(r, residualProfile[dist[r]], 'old', alongAt(from[r]));
        }
    }

    /* Old welds already thickened the column. Restore a worn belt so the
     * suture reads as highlands, not only a slightly taller platform. */
    if (r_thickness) {
        for (let r = 0; r < n; r++) {
            if (!isLand[r] || r_orogeny[r] >= 0.2) continue;
            if (r_thickness[r] < opts.crustReferenceKm + 2.4) continue;
            const gain = 0.22 + 0.08 * Math.min(1,
                (r_thickness[r] - opts.crustReferenceKm) / opts.sutureBeltKm);
            paintBelt(r, gain, 'old', vec3.cross([], posOf(r), pacific));
        }
    }

    /* A belt loads the plate. The lithosphere flexes: a foredeep just
     * inland, then the mass tilts down to its passive coast. Elevation
     * follows distance to the orogen, not distance to the shoreline — a
     * radial dome from core to coast is the thing that made every
     * continent shade like a blob. */
    if (r_thickness) {
        const beltSeed = new Uint8Array(n);
        const passiveSeed = new Uint8Array(n);
        for (let r = 0; r < n; r++) {
            if (!isLand[r]) continue;
            if (r_orogeny[r] >= 0.35) beltSeed[r] = 1;
            if (isCoast[r] && !front[r] && !residual[r]) {
                passiveSeed[r] = 1;
            }
        }
        const toBelt = hopDistanceLand(mesh, beltSeed, isLand, n);
        const toPassive = hopDistanceLand(mesh, passiveSeed, isLand, n);
        const drownFloor = opts.seaLevelThicknessKm + 0.5;
        for (let r = 0; r < n; r++) {
            if (!isLand[r]) continue;
            if (r_orogeny[r] >= 0.42) continue;
            if (r_thickness[r] > opts.crustReferenceKm + 4) continue;
            let sag = 0;
            const dB = toBelt[r];
            const dP = toPassive[r];
            if (dB >= 1 && dB <= 5) {
                const t = dB <= 2 ? dB / 2 : 1 - (dB - 2) / 3.5;
                sag = Math.max(sag, 2.6 * Math.max(0, t));
            }
            if (dB >= 0 && dP >= 0 && dB + dP > 0) {
                sag = Math.max(sag, 1.4 * (dB / (dB + dP)));
            }
            /* Polar shields and one-coast masses have no opposite shore
             * to tilt toward. Sag grows with hops from the orogen so a
             * large interior is a gradient, not a second 650 m table. */
            if (dB >= 3) {
                sag = Math.max(sag, Math.min(3.2, 0.13 * (dB - 2)));
            }
            const dOcean = landDist[r] - 1;
            if (dOcean >= 0 && dOcean <= 2 && !front[r] && !residual[r]
                    && (dB < 0 || dB > 6)) {
                sag = Math.max(sag, 2.8 * (1 - dOcean / 3));
            }
            if (sag > 0) {
                r_thickness[r] = Math.max(drownFloor, r_thickness[r] - sag);
            }
        }
    }

    /* Quiet interiors are not tables either: a slow swell of a few
     * hundred metres, basins and domes at craton scale. */
    if (r_thickness) {
        const swell = new SimplexNoise(randFloat);
        for (let r = 0; r < n; r++) {
            if (!isLand[r] || r_orogeny[r] > 0.2 || landDist[r] < 3) continue;
            const p = posOf(r);
            const w = swell.noise3D(4 * p[0], 4 * p[1], 4 * p[2]);
            r_thickness[r] = Math.max(opts.seaLevelThicknessKm + 0.3, r_thickness[r] + 1.2 * w);
        }
    }

    /* Island arcs where the run left an ocean trench: the young side of
     * an ocean-ocean convergent boundary, away from land. */
    let trenchArcs = 0;
    for (let r = 0; r < n; r++) {
        if (isLand[r] || r_boundary[r] !== BOUNDARY_CONVERGENT || toLand[r] < 3) continue;
        if (Math.abs(r_convergence[r]) < 0.35 * vRef) continue;
        let older = -1, facingLand = false;
        mesh.r_circulate_r(nb, r);
        for (const q of nb) {
            if (r_plate[q] === r_plate[r]) continue;
            if (isLand[q]) facingLand = true;
            older = Math.max(older, r_crust_age[q]);
        }
        if (facingLand || older < 0 || r_crust_age[r] > older) continue;   /* the older side sinks */
        const across = acrossDir(r);
        if (!across) continue;
        r_arc[r] = Math.max(r_arc[r], 1.0);
        setStrike(r_arcDir, r, posOf(r), vec3.cross([], posOf(r), across));
        trenchArcs++;
    }

    /* Trench on the water next to an active coast, so the crust view and
     * the bathymetry agree with the belt. */
    if (map.r_boundary) {
        for (let r = 0; r < n; r++) {
            if (margin[r] !== MARGIN_ACTIVE) continue;
            mesh.r_circulate_r(nb, r);
            for (const k of nb) {
                if (isLand[k]) continue;
                map.r_boundary[k] = BOUNDARY_CONVERGENT;
            }
        }
    }

    /* Oceania: when the run left no trench in the open ocean, one
     * island-arc chain there, a geodesic between two Pacific points. */
    const pacOcean = [];
    for (let r = 0; r < n; r++) {
        if (isLand[r] || toLand[r] < 4) continue;
        const d = r_xyz[3 * r] * pacific[0]
            + r_xyz[3 * r + 1] * pacific[1]
            + r_xyz[3 * r + 2] * pacific[2];
        if (d > 0.18) pacOcean.push(r);
    }
    if (trenchArcs < 12 && pacOcean.length >= 8) {
        let a = pacOcean[Math.floor(randFloat() * pacOcean.length)];
        let b = a, best = -1;
        for (let tries = 0; tries < 24; tries++) {
            const c = pacOcean[Math.floor(randFloat() * pacOcean.length)];
            const ang = angleBetween(
                [r_xyz[3 * a], r_xyz[3 * a + 1], r_xyz[3 * a + 2]],
                [r_xyz[3 * c], r_xyz[3 * c + 1], r_xyz[3 * c + 2]]);
            if (ang > best && ang < 1.8) { best = ang; b = c; }
        }
        const A = [r_xyz[3 * a], r_xyz[3 * a + 1], r_xyz[3 * a + 2]];
        const B = [r_xyz[3 * b], r_xyz[3 * b + 1], r_xyz[3 * b + 2]];
        const halfW = 0.048;
        const along = tangentToward(A, B);
        for (let r = 0; r < n; r++) {
            if (isLand[r]) continue;
            const p = [r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2]];
            if (!onShortArc(p, A, B)) continue;
            const d = distToGeodesic(p, A, B);
            if (d >= halfW) continue;
            const w = 1 - d / halfW;
            r_arc[r] = Math.max(r_arc[r], 0.85 + 0.5 * w);
            setStrike(r_arcDir, r, p, along);
        }
    }

    /* Caribbean: a small sea, mostly wrapped by land, gets an island arc
     * across its mouth rather than a wall of continent. */
    const openSeed = new Uint8Array(n);
    for (let r = 0; r < n; r++) if (!isLand[r] && toLand[r] >= 7) openSeed[r] = 1;
    const toOpen = hopDistance(mesh, openSeed, n);
    const mouth = [];
    for (let r = 0; r < n; r++) {
        if (isLand[r] || toLand[r] > 4) continue;
        if (toOpen[r] < 0 || toOpen[r] < 5) continue;
        mesh.r_circulate_r(nb, r);
        let nextOpen = false;
        for (const k of nb) {
            if (!isLand[k] && toOpen[k] >= 0 && toOpen[k] < toOpen[r]) nextOpen = true;
        }
        if (nextOpen) mouth.push(r);
    }
    if (mouth.length >= 4 && mouth.length < n * 0.04) {
        for (const r of mouth) {
            const p = [r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2]];
            r_arc[r] = Math.max(r_arc[r], 1.15);
            setStrike(r_arcDir, r, p, vec3.cross([], p, pacific));
            mesh.r_circulate_r(nb, r);
            for (const k of nb) {
                if (isLand[k]) continue;
                r_arc[k] = Math.max(r_arc[k], 0.7);
            }
        }
    }
}


/* The birth crust on its own, for a caller that seeds the plates from it.
 * Same derivation as `simulateTectonics`, so the two agree. */
function planCrust(mesh, r_xyz, seed, options) {
    const opts = World.derive(Object.assign({}, World.DEFAULTS, DEFAULTS, options));
    return Object.assign(initCrust(mesh, r_xyz, seed, opts), {r_xyz});
}


/* Runs the whole model and leaves r_elevation, the crust fields and the
 * boundary classification on `map`. */
function simulateTectonics(mesh, map, seed, options) {
    const opts = World.derive(Object.assign({}, World.DEFAULTS, DEFAULTS, options));
    const randFloat = makeRandFloat(seed ^ 0x85ebca6b);

    /* The birth crust comes first: the partition is fitted to it.
     * `generatePlates` leaves the plan it was seeded from on the map;
     * a caller that seeded plates blind gets the same plan made here. */
    const birth = map.birthCrust || initCrust(mesh, map.r_xyz, seed, opts);
    delete map.birthCrust;
    Object.assign(map, birth);

    /* One value per cell, so the field belongs to this mesh and this crust.
     * Rebuilt on every run, never cached across them: a field from a
     * previous mesh indexed with this one reads undefined and hands NaN
     * weights to the ownership pass, which collapses the planet to a
     * couple of plates; a field from a previous crust tolls the wrong
     * coasts. */
    map.boundaryWarp = makeBoundaryWarp(mesh, map.r_xyz, seed, opts, map.r_crust_type);
    map.tectonicFieldsFor = `${mesh.numRegions}:${seed}`;
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
    map.hotspots = Array.from({length: opts.hotspots},
        () => randomUnitVector(randFloat));

    /* The continent plan is a still. The run paints sea-floor age, arcs
     * and belts; it does not redraw coasts. Matching coasts from a later
     * rift are a later trial. */
    const birthType = Uint8Array.from(map.r_crust_type);
    const birthThickness = Float32Array.from(map.r_thickness);
    const oceanKm = opts.crustOceanKm;
    const restoreContinents = () => {
        const n = birthType.length;
        for (let r = 0; r < n; r++) {
            if (birthType[r] === CRUST_CONTINENTAL) {
                map.r_crust_type[r] = CRUST_CONTINENTAL;
                map.r_thickness[r] = birthThickness[r];
            } else if (map.r_crust_type[r] === CRUST_CONTINENTAL) {
                map.r_crust_type[r] = CRUST_OCEANIC;
                map.r_thickness[r] = oceanKm;
            }
        }
    };

    for (let step = 0; step < opts.steps; step++) {
        map.elapsedMyr += opts.stepMyr;
        const collisions = stepTectonics(mesh, map, opts);
        restoreContinents();

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
    composeTectonicStory(mesh, map, randFloat, opts);
    stampLifetime(map);
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
    classifyBoundaries, paintConvergentMargins, stampLifetime,
    placeCratons, initCrust, planCrust, applyBasins,
    oceanDepthMeters, continentHeightMeters,
    crustToMeters, applyIslandCrests, crustToElevation, polarStraits, solveSeaLevel,
    simulateTectonics,
};
