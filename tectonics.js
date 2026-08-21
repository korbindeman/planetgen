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
 */

/* Earth's plates come in two populations: a handful of majors holding
 * ~90% of the surface, then a microplate tail. A uniform flood fill gives
 * every plate the same expected area instead, which is why a randomly
 * partitioned sphere reads as a set of interchangeable blobs.
 *
 * Tuned against Earth's 20 largest plates:
 *   this model  top-1 18%  top-3 49%  top-7 89%
 *   Earth       top-1 20%  top-3 49%  top-7 90%
 */
const PLATE_MAJOR_FRACTION = 0.35;   // share of plates that are "major"
const PLATE_MAJOR_SHARE = 0.90;      // share of the surface they hold
const PLATE_SIGMA_MAJOR = 0.20;      // lognormal spread within each population
const PLATE_SIGMA_MINOR = 0.70;

function plateWeights(count, randFloat) {
    const gauss = () => {   // Box-Muller, so the weights come out lognormal
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


function pickRandomRegions(mesh, count, randInt) {
    const chosen = new Set();
    while (chosen.size < count && chosen.size < mesh.numRegions) {
        chosen.add(randInt(mesh.numRegions));
    }
    return chosen;
}


function generatePlates(mesh, numPlates, seed) {
    const r_plate = new Int32Array(mesh.numRegions);
    r_plate.fill(-1);
    const plate_r = pickRandomRegions(mesh, Math.min(numPlates, mesh.numRegions), makeRandInt(seed));
    const seeds = Array.from(plate_r);
    const randInt = makeRandInt(seed);
    const randFloat = makeRandFloat(seed ^ 0x5f3759df);
    const weight = plateWeights(seeds.length, randFloat);

    /* Weighted competitive growth. Each plate keeps its own frontier; each
       round picks a plate with probability proportional to its weight and
       expands one cell of that plate's frontier. The pick within a plate is
       random rather than breadth-first, which is what keeps boundaries
       ragged instead of circular. */
    const frontier = seeds.map(r => [r]);
    seeds.forEach(r => { r_plate[r] = r; });
    let active = seeds.map((_, i) => i);
    let totalWeight = active.reduce((a, i) => a + weight[i], 0);
    let claimed = seeds.length;
    const out_r = [];

    while (claimed < mesh.numRegions && active.length > 0) {
        let x = randFloat() * totalWeight, pick = active[active.length - 1];
        for (const i of active) { x -= weight[i]; if (x <= 0) { pick = i; break; } }

        const f = frontier[pick];
        const pos = randInt(f.length);
        const current_r = f[pos];
        f[pos] = f[f.length - 1];
        f.pop();

        mesh.r_circulate_r(out_r, current_r);
        for (const neighbor_r of out_r) {
            if (r_plate[neighbor_r] === -1) {
                r_plate[neighbor_r] = seeds[pick];
                f.push(neighbor_r);
                claimed++;
            }
        }
        if (f.length === 0) {
            active = active.filter(i => i !== pick);
            totalWeight = active.reduce((a, i) => a + weight[i], 0);
        }
    }
    return {plate_r, r_plate};
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

function assignPlateMotion(mesh, plate_r, r_plate, seed) {
    const randFloat = makeRandFloat(seed ^ 0x9e3779b9);
    const plate_pole = [], plate_omega = [];
    for (const p of plate_r) {
        plate_pole[p] = randomUnitVector(randFloat);
        plate_omega[p] = randomOmega(randFloat);
    }
    removeNetRotation(mesh, plate_r, r_plate, plate_pole, plate_omega);
    return {plate_pole, plate_omega};
}


/* Published plate models are quoted in a no-net-rotation frame: the plates
 * move relative to each other, not all one way. Poles sampled independently
 * leave a net drift worth about a quarter of the total motion, so subtract
 * the area-weighted mean rotation from every plate. */
function removeNetRotation(mesh, plate_r, r_plate, plate_pole, plate_omega) {
    const area = new Map();
    for (let r = 0; r < mesh.numRegions; r++) {
        area.set(r_plate[r], (area.get(r_plate[r]) || 0) + 1);
    }
    const net = [0, 0, 0];
    let total = 0;
    for (const p of plate_r) {
        const a = area.get(p) || 0;
        vec3.scaleAndAdd(net, net, plate_pole[p], a * plate_omega[p]);
        total += a;
    }
    if (total === 0) return;
    vec3.scale(net, net, 1 / total);
    for (const p of plate_r) {
        const w = vec3.scaleAndAdd([], vec3.scale([], plate_pole[p], plate_omega[p]), net, -1);
        const mag = vec3.length(w);
        plate_omega[p] = mag;
        plate_pole[p] = mag > 1e-12 ? vec3.scale([], w, 1 / mag) : [0, 0, 1];
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

function classifyBoundaries(mesh, {r_xyz, r_plate, plate_pole, plate_omega}) {
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

            plateVelocity(va, plate_pole[r_plate[current_r]], plate_omega[r_plate[current_r]], mid);
            plateVelocity(vb, plate_pole[r_plate[neighbor_r]], plate_omega[r_plate[neighbor_r]], mid);
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
    stepMyr: 10,                  // 200 Myr of history
    crustSmoothing: 2,            // smoothing of the crust-type field before thresholding
    continentFraction: 0.45,      // Earth: continental crust is ~41% of the
                                  // surface, of which ~29% is dry land
    crustReferenceKm: 34,         // thickness undisturbed continental crust relaxes towards
    seaLevelThicknessKm: 26,      // thickness that floats exactly at sea level
    crustOceanKm: 7,
    crustMinKm: 22,               // fully rifted margin
    crustMaxKm: 68,               // Tibet
    crustInitialPeakKm: 41,
    shelfThinningKm: 0.15,         // per step, at a rifting margin
    collisionThickenKm: 0.9,      // per step, continent against continent
    collisionThrust: 0.34,        // share of an overridden column thrust onto the winner
    riftStretchShare: 0.28,       // share of a margin's column pulled into an opening rift
    crustBreakKm: 9,              // thinner than this and the margin has broken: sea floor
    riftIntactShare: 0.80,        // only crust this fraction of reference thickness stretches
    emergentFraction: 0.71,       // share of continental crust starting above sea level
    orogenyDecay: 0.84,           // erosion between steps
    orogenyReliefM: 1500,         // extra relief at full orogeny, on top of isostasy
    rootRelax: 0.030,             // crustal roots relax back towards normal
    arcOceanic: 0.55,             // island arc over ocean-ocean subduction
    arcContinental: 0.85,         // Andean arc over ocean-continent
    orogenyAndean: 0.5,
    orogenyCollision: 1.0,
    weldThreshold: 0.008,         // contact cells, as a share of the sphere
    riftChance: 0.08,             // per step, chance of splitting a big plate
    riftMinArea: 0.12,            // only plates larger than this can rift
    coastBlend: 1,                // relaxation rings across the continental margin
    healPasses: 2,                // majority-filter passes that keep plates coherent
    minFragment: 0.004,           // detached plate pieces smaller than this are absorbed
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
function initCrust(mesh, r_xyz, seed, opts) {
    const {numRegions} = mesh;
    /* Few octaves and a fast falloff, so continents come out as a handful of
     * large masses rather than a scatter of islands. */
    const fbm = makeFbm(new SimplexNoise(makeRandFloat(seed ^ 0x2545f491)), 3, 0.42);

    const r_crust_type = new Uint8Array(numRegions);
    const r_crust_age = new Float32Array(numRegions);
    const r_thickness = new Float32Array(numRegions);
    const r_orogeny = new Float32Array(numRegions);
    const r_arc = new Float32Array(numRegions);

    const field = new Float32Array(numRegions);
    for (let r = 0; r < numRegions; r++) {
        field[r] = fbm(r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2]);
    }
    /* smooth before thresholding so the coast is not peppered with specks */
    smoothField(mesh, field, null, opts.crustSmoothing);
    /* threshold at the quantile that hits the target continental area */
    const sorted = Float32Array.from(field).sort();
    const cutoff = sorted[Math.floor((1 - opts.continentFraction) * (numRegions - 1))];

    const continental = [];
    for (let r = 0; r < numRegions; r++) {
        if (field[r] > cutoff) { r_crust_type[r] = CRUST_CONTINENTAL; continental.push(r); }
        else { r_crust_type[r] = CRUST_OCEANIC; r_thickness[r] = opts.crustOceanKm; }
    }

    /* Thickness follows the noise field's rank rather than its raw value, so
     * the share of continental crust that starts above sea level is a direct
     * dial rather than a side effect of the noise distribution. Rank 0 is the
     * outermost margin, rank 1 the deepest interior; the reference thickness
     * (sea level) sits at 1 - emergentFraction. */
    continental.sort((a, b) => field[a] - field[b]);
    const breakpoint = 1 - opts.emergentFraction;
    for (let i = 0; i < continental.length; i++) {
        const rank = continental.length > 1 ? i / (continental.length - 1) : 1;
        r_thickness[continental[i]] = rank < breakpoint
            ? opts.crustMinKm + (opts.crustReferenceKm - opts.crustMinKm) * (rank / breakpoint)
            : opts.crustReferenceKm + (opts.crustInitialPeakKm - opts.crustReferenceKm) *
              Math.pow((rank - breakpoint) / (1 - breakpoint), 0.8);
    }
    return {r_crust_type, r_crust_age, r_thickness, r_orogeny, r_arc};
}


/* Regions within `depth` rings of a plate boundary. Only these can change
 * hands in one step, which keeps the candidate search off the interiors. */
function boundaryBand(mesh, r_plate, depth) {
    const {numRegions} = mesh;
    const band = new Uint8Array(numRegions);
    const out_r = [];
    let frontier = [];
    for (let r = 0; r < numRegions; r++) {
        mesh.r_circulate_r(out_r, r);
        for (const neighbor_r of out_r) {
            if (r_plate[neighbor_r] !== r_plate[r]) { band[r] = 1; frontier.push(r); break; }
        }
    }
    for (let d = 1; d < depth; d++) {
        const next = [];
        for (const r of frontier) {
            mesh.r_circulate_r(out_r, r);
            for (const neighbor_r of out_r) {
                if (!band[neighbor_r]) { band[neighbor_r] = 1; next.push(neighbor_r); }
            }
        }
        frontier = next;
    }
    return band;
}


/* One timestep. Every region asks which plate's crust has rotated into it.
 * No answer means the plates opened a gap, so new ocean floor forms there;
 * more than one means they converged, so the denser crust goes down and the
 * survivor records an arc or an orogeny. */
function stepTectonics(mesh, map, opts) {
    const {r_xyz, plate_pole, plate_omega} = map;
    const {numRegions} = mesh;
    const dtMyr = opts.stepMyr;
    const prevPlate = map.r_plate;
    const prevType = map.r_crust_type, prevAge = map.r_crust_age,
          prevThickness = map.r_thickness, prevOrogeny = map.r_orogeny, prevArc = map.r_arc;

    const nextPlate = new Int32Array(numRegions).fill(-1);
    const nextType = new Uint8Array(numRegions);
    const nextAge = new Float32Array(numRegions);
    const nextThickness = new Float32Array(numRegions);
    const nextOrogeny = new Float32Array(numRegions);
    const nextArc = new Float32Array(numRegions);

    const band = boundaryBand(mesh, prevPlate, 4);
    /* The claim test below is discrete: near any boundary a cell can fail to
     * be claimed simply because the back-rotated point landed one cell over.
     * Only treat a failed claim as new sea floor where the velocity field is
     * actually divergent, otherwise the mesh quantisation would eat crust
     * along every margin including the convergent and transform ones. */
    const {r_boundary: stepBoundary} = classifyBoundaries(mesh, map);
    const collisions = new Map();     // "a,b" -> cells of continent-continent contact
    const gaps = [];
    const out_r = [], ring = [], candidates = [];
    const stamp = new Int32Array(numRegions).fill(-1);
    const back = [0, 0, 0], x = [0, 0, 0];

    for (let r = 0; r < numRegions; r++) {
        x[0] = r_xyz[3 * r]; x[1] = r_xyz[3 * r + 1]; x[2] = r_xyz[3 * r + 2];

        candidates.length = 0;
        if (!band[r]) {
            candidates.push(prevPlate[r]);
        } else {
            /* every plate present within 4 rings is a candidate */
            ring.length = 0;
            ring.push(r);
            stamp[r] = r;
            let head = 0, tail = 1;
            for (let depth = 0; depth < 4; depth++) {
                const end = tail;
                for (; head < end; head++) {
                    mesh.r_circulate_r(out_r, ring[head]);
                    for (const neighbor_r of out_r) {
                        if (stamp[neighbor_r] !== r) { stamp[neighbor_r] = r; ring.push(neighbor_r); tail++; }
                    }
                }
            }
            for (const q of ring) {
                if (candidates.indexOf(prevPlate[q]) === -1) candidates.push(prevPlate[q]);
            }
        }

        /* which candidates actually cover this cell after rotating forward? */
        let winner = -1, winner_r = -1, winnerScore = -Infinity;
        let losers = 0, loserContinental = 0, loserPlate = -1, loserThickness = 0;
        for (const p of candidates) {
            rotateAbout(back, x, plate_pole[p], -plate_omega[p] * dtMyr);
            const source_r = nearestRegion(mesh, r_xyz, back, r, out_r);
            if (prevPlate[source_r] !== p) continue;

            /* Continental crust is buoyant and does not subduct. Between two
               oceanic slabs the older, colder, denser one goes down. */
            const score = prevType[source_r] === CRUST_CONTINENTAL
                ? 1e6 + prevThickness[source_r]
                : -prevAge[source_r];
            if (score > winnerScore) {
                if (winner !== -1) {
                    losers++;
                    if (prevType[winner_r] === CRUST_CONTINENTAL) {
                        loserContinental++; loserPlate = winner;
                        loserThickness = Math.max(loserThickness, prevThickness[winner_r]);
                    }
                }
                winnerScore = score; winner = p; winner_r = source_r;
            } else {
                losers++;
                if (prevType[source_r] === CRUST_CONTINENTAL) {
                    loserContinental++; loserPlate = p;
                    loserThickness = Math.max(loserThickness, prevThickness[source_r]);
                }
            }
        }

        if (winner === -1) {
            if (stepBoundary[r] === BOUNDARY_DIVERGENT) { gaps.push(r); continue; }
            /* quantisation, not rifting: carry this cell forward unchanged */
            nextPlate[r] = prevPlate[r];
            nextType[r] = prevType[r];
            nextAge[r] = prevAge[r] + dtMyr;
            nextThickness[r] = prevThickness[r];
            nextOrogeny[r] = prevOrogeny[r] * opts.orogenyDecay;
            nextArc[r] = prevArc[r] * opts.orogenyDecay;
            continue;
        }

        nextPlate[r] = winner;
        nextType[r] = prevType[winner_r];
        nextAge[r] = prevAge[winner_r] + dtMyr;
        nextThickness[r] = prevThickness[winner_r];
        nextOrogeny[r] = prevOrogeny[winner_r] * opts.orogenyDecay;
        nextArc[r] = prevArc[winner_r] * opts.orogenyDecay;

        if (losers > 0) {
            const winnerContinental = prevType[winner_r] === CRUST_CONTINENTAL;
            if (winnerContinental && loserContinental > 0) {
                /* Suture: neither side can sink, so the crust piles up. The
                 * overridden column is thrust on top rather than destroyed,
                 * which is what conserves continental crust through a
                 * collision and what builds a plateau rather than a ridge. */
                const thrust = loserThickness * opts.collisionThrust;
                nextThickness[r] = Math.min(opts.crustMaxKm,
                                            nextThickness[r] + opts.collisionThickenKm + thrust);
                nextOrogeny[r] = Math.min(2, nextOrogeny[r] + opts.orogenyCollision);
                if (loserPlate !== -1 && loserPlate !== winner) {
                    const key = winner < loserPlate ? `${winner},${loserPlate}` : `${loserPlate},${winner}`;
                    collisions.set(key, (collisions.get(key) || 0) + 1);
                }
            } else if (winnerContinental) {
                /* ocean going down under a continent: an Andean arc */
                nextArc[r] = Math.min(2, nextArc[r] + opts.arcContinental);
                nextOrogeny[r] = Math.min(2, nextOrogeny[r] + opts.orogenyAndean);
                nextThickness[r] = Math.min(opts.crustMaxKm, nextThickness[r] + 0.35);
            } else {
                /* ocean under ocean: an island arc, with no crustal root */
                nextArc[r] = Math.min(2, nextArc[r] + opts.arcOceanic);
            }
        }
    }

    /* Gaps are where the plates pulled apart: brand new ocean floor at age
     * zero. Fill outwards from settled cells so it joins the plate it
     * actually rifted from. */
    if (gaps.length > 0) {
        let frontier = gaps.slice();
        let guard = 0;
        while (frontier.length > 0 && guard++ < 64) {
            const deferred = [];
            for (const r of frontier) {
                let claim = -1;
                mesh.r_circulate_r(out_r, r);
                for (const neighbor_r of out_r) {
                    if (nextPlate[neighbor_r] !== -1) { claim = nextPlate[neighbor_r]; break; }
                }
                if (claim === -1) { deferred.push(r); continue; }

                /* A rift does not become sea floor the moment it opens. It
                 * first pulls the neighbouring continent out into it, thinning
                 * it: that stretched crust is a hyperextended margin, and it is
                 * what gives a passive margin its width. Only once the margin
                 * has thinned to the floor does the gap flood as ocean. */
                let donor = -1, donorThickness = 0;
                mesh.r_circulate_r(out_r, r);
                for (const neighbor_r of out_r) {
                    if (nextType[neighbor_r] !== CRUST_CONTINENTAL) continue;
                    if (nextThickness[neighbor_r] > donorThickness) {
                        donor = neighbor_r;
                        donorThickness = nextThickness[neighbor_r];
                    }
                }
                nextPlate[r] = claim;
                nextOrogeny[r] = 0;
                nextArc[r] = 0;
                /* Only reasonably intact crust gets pulled into a rift. Once a
                 * margin has been thinned it breaks instead of stretching
                 * further, which keeps hyperextended crust to a narrow strip
                 * rather than letting it drown whole continents. */
                const stretched = donorThickness * opts.riftStretchShare;
                if (donor !== -1 && stretched > opts.crustBreakKm &&
                    donorThickness > opts.crustReferenceKm * opts.riftIntactShare) {
                    /* the column is split between the two cells, so stretching
                       thins the margin instead of manufacturing crust */
                    nextType[r] = CRUST_CONTINENTAL;
                    nextThickness[r] = stretched;
                    nextThickness[donor] = donorThickness * (1 - opts.riftStretchShare);
                    nextAge[r] = prevAge[r];
                } else {
                    nextType[r] = CRUST_OCEANIC;
                    nextAge[r] = 0;
                    nextThickness[r] = opts.crustOceanKm;
                }
            }
            if (deferred.length === frontier.length) {
                /* nothing settled this round; hand the rest to their old plate */
                for (const r of deferred) {
                    nextPlate[r] = prevPlate[r];
                    nextType[r] = CRUST_OCEANIC;
                    nextAge[r] = 0;
                    nextThickness[r] = opts.crustOceanKm;
                }
                break;
            }
            frontier = deferred;
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

    /* Advecting ownership cell by cell leaves specks of one plate stranded
     * inside another, and over twenty steps that shreds the map into
     * interpenetrating slivers. Real plates are coherent bodies, so tidy the
     * ownership field back up before the next step. */
    healPlates(mesh, nextPlate, opts);

    map.r_plate = nextPlate;
    map.r_crust_type = nextType;
    map.r_crust_age = nextAge;
    map.r_thickness = nextThickness;
    map.r_orogeny = nextOrogeny;
    map.r_arc = nextArc;
    return collisions;
}



/* Majority filter, then drop the stranded fragments: a cell surrounded by
 * another plate joins it, and a detached islet of a plate is absorbed by
 * whatever encloses it. Only ownership moves; the crust each cell carries
 * stays where it is. */
function healPlates(mesh, r_plate, opts) {
    const {numRegions} = mesh;
    const out_r = [];
    const tally = new Map();

    for (let pass = 0; pass < opts.healPasses; pass++) {
        const updated = r_plate.slice();
        for (let r = 0; r < numRegions; r++) {
            mesh.r_circulate_r(out_r, r);
            tally.clear();
            let own = 0;
            for (const neighbor_r of out_r) {
                const p = r_plate[neighbor_r];
                tally.set(p, (tally.get(p) || 0) + 1);
                if (p === r_plate[r]) own++;
            }
            if (own >= 2) continue;                 // still attached to its own plate
            let best = r_plate[r], bestCount = own;
            for (const [p, count] of tally) if (count > bestCount) { best = p; bestCount = count; }
            updated[r] = best;
        }
        r_plate.set(updated);
    }

    /* connected components, so a plate that got cut in two loses the offcut */
    const component = new Int32Array(numRegions).fill(-1);
    const sizes = [];
    const owner = [];
    const queue = [];
    for (let r = 0; r < numRegions; r++) {
        if (component[r] !== -1) continue;
        const id = sizes.length;
        component[r] = id; owner.push(r_plate[r]);
        queue.length = 0; queue.push(r);
        let size = 0;
        for (let head = 0; head < queue.length; head++) {
            const current_r = queue[head];
            size++;
            mesh.r_circulate_r(out_r, current_r);
            for (const neighbor_r of out_r) {
                if (component[neighbor_r] === -1 && r_plate[neighbor_r] === owner[id]) {
                    component[neighbor_r] = id;
                    queue.push(neighbor_r);
                }
            }
        }
        sizes.push(size);
    }
    /* the biggest component of each plate is the real plate */
    const largest = new Map();
    for (let id = 0; id < sizes.length; id++) {
        const p = owner[id];
        if (!largest.has(p) || sizes[id] > sizes[largest.get(p)]) largest.set(p, id);
    }
    const minimum = Math.max(2, Math.round(opts.minFragment * numRegions));
    for (let r = 0; r < numRegions; r++) {
        const id = component[r];
        if (id === largest.get(owner[id]) || sizes[id] >= minimum) continue;
        /* absorb the offcut into whichever plate surrounds it most */
        mesh.r_circulate_r(out_r, r);
        tally.clear();
        for (const neighbor_r of out_r) {
            if (component[neighbor_r] === id) continue;
            const p = r_plate[neighbor_r];
            tally.set(p, (tally.get(p) || 0) + 1);
        }
        let best = -1, bestCount = 0;
        for (const [p, count] of tally) if (count > bestCount) { best = p; bestCount = count; }
        if (best !== -1) r_plate[r] = best;
    }
}


/* Two continents that have been colliding for a while stop being two
 * plates. This is what assembles supercontinents. */
function weldPlates(mesh, map, collisions, opts) {
    const threshold = opts.weldThreshold * mesh.numRegions;
    const area = new Map();
    for (let r = 0; r < mesh.numRegions; r++) {
        area.set(map.r_plate[r], (area.get(map.r_plate[r]) || 0) + 1);
    }
    const remap = new Map();
    const resolve = (p) => { while (remap.has(p)) p = remap.get(p); return p; };
    for (const [key, count] of collisions) {
        if (count < threshold) continue;
        let [a, b] = key.split(',').map(Number);
        a = resolve(a); b = resolve(b);
        if (a === b) continue;
        if ((area.get(a) || 0) < (area.get(b) || 0)) { const t = a; a = b; b = t; }
        remap.set(b, a);                 // the smaller plate is absorbed
    }
    if (remap.size === 0) return false;
    for (let r = 0; r < mesh.numRegions; r++) map.r_plate[r] = resolve(map.r_plate[r]);
    for (const b of remap.keys()) map.plate_r.delete(b);
    return true;
}


/* Without this the plate count only ever falls. A large plate splits along
 * a great circle and the halves take up new poles; continental crust caught
 * on the split is what becomes a rifted margin. */
function riftPlate(mesh, map, randFloat, opts) {
    const {r_xyz} = map;
    const area = new Map();
    for (let r = 0; r < mesh.numRegions; r++) {
        area.set(map.r_plate[r], (area.get(map.r_plate[r]) || 0) + 1);
    }
    const eligible = [...area.entries()].filter(([, a]) => a / mesh.numRegions > opts.riftMinArea);
    if (eligible.length === 0) return false;
    const target = eligible[Math.min(eligible.length - 1, Math.floor(randFloat() * eligible.length))][0];

    const centroid = [0, 0, 0];
    for (let r = 0; r < mesh.numRegions; r++) {
        if (map.r_plate[r] !== target) continue;
        centroid[0] += r_xyz[3 * r]; centroid[1] += r_xyz[3 * r + 1]; centroid[2] += r_xyz[3 * r + 2];
    }
    if (vec3.length(centroid) < 1e-9) return false;
    vec3.normalize(centroid, centroid);

    /* a random great circle through the plate's centroid */
    const cut = randomUnitVector(randFloat);
    vec3.scaleAndAdd(cut, cut, centroid, -vec3.dot(cut, centroid));
    if (vec3.length(cut) < 1e-6) return false;
    vec3.normalize(cut, cut);

    const side = (r) => r_xyz[3 * r] * cut[0] + r_xyz[3 * r + 1] * cut[1] + r_xyz[3 * r + 2] * cut[2] > 0;

    /* the new plate is identified by one of its own cells, as plates are
       throughout this code; it must not already be a plate id */
    let newId = -1;
    for (let r = 0; r < mesh.numRegions; r++) {
        if (map.r_plate[r] === target && side(r) && !map.plate_r.has(r)) { newId = r; break; }
    }
    if (newId === -1) return false;

    let moved = 0;
    for (let r = 0; r < mesh.numRegions; r++) {
        if (map.r_plate[r] === target && side(r)) { map.r_plate[r] = newId; moved++; }
    }
    if (moved === 0) return false;

    map.plate_r.add(newId);
    map.plate_pole[newId] = randomUnitVector(randFloat);
    map.plate_omega[newId] = randomOmega(randFloat);
    return true;
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
    Object.assign(map, initCrust(mesh, map.r_xyz, seed, opts));

    for (let step = 0; step < opts.steps; step++) {
        const collisions = stepTectonics(mesh, map, opts);
        if (opts.onStep) opts.onStep(step, map);
        let changed = weldPlates(mesh, map, collisions, opts);
        if (randFloat() < opts.riftChance && riftPlate(mesh, map, randFloat, opts)) changed = true;
        if (changed) {
            removeNetRotation(mesh, map.plate_r, map.r_plate, map.plate_pole, map.plate_omega);
        }
    }

    Object.assign(map, classifyBoundaries(mesh, map));
    crustToElevation(mesh, map, seed, opts);
    return map;
}


module.exports = {
    DEFAULTS,
    BOUNDARY_NONE, BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM,
    CRUST_OCEANIC, CRUST_CONTINENTAL,
    LAND_PEAK_M, LAND_POWER, OCEAN_DEPTH_M, OCEAN_POWER,
    elevationToMeters, metersToElevation,
    clamp01, smoothField,
    generatePlates, assignPlateMotion, removeNetRotation,
    plateVelocity, rotateAbout, nearestRegion,
    classifyBoundaries,
    oceanDepthMeters, continentHeightMeters,
    simulateTectonics,
};
