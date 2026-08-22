/*
 * Detail pass: a second mesh that carries the heightmap the renderer sees.
 *
 * The simulation stays on its tuned 10k–40k mesh. This module builds a
 * finer sphere, samples the simulation's metres field onto it, then
 * warps that height the way World Orogen does: normalised FBM in the
 * tangent plane, greedy walk, blend. Island crests go on after.
 * Oriented phasor ridges and a first-stage erosion pass follow, so the
 * belts have grain and the slopes drain somewhere.
 *
 * Climate, plates and crust stay where they were computed and are
 * sampled without the warp, so a trench can still be judged against its
 * arc.
 */
'use strict';

const SimplexNoise = require('simplex-noise');
const {makeRandFloat} = require('@redblobgames/prng');
const Climate = require('./climate');
const Tectonics = require('./tectonics');
const Erosion = require('./erosion');

const EARTH_RADIUS_KM = 6371;

const DEFAULTS = {
    n: 200000,                    // regions on the detail mesh
    /* World Orogen warpTerrain (terrain-post.js / terrain-config.js). */
    warpStrength: 0.75,           // their Terrain Warp slider default
    warpFreq: 4,                  // unit-sphere; ~10000 km wavelength
    warpOctaves: 5,
    warpMaxAmp: 0.13,             // radians at strength=1 (~830 km)
    warpBiasBase: 0.25,
    warpBiasStrengthScale: 0.5,
    warpHotspotDampen: 0.8,
    warpCoastKeep: 0.12,          // keep land/ocean when the lookup would swap them
    islandWavelengthKm: 900,      // octave 0 of the crest noise; finer octaves
                                  // break the ridge into a chain rather than a wall

    /* Phasor ridges. Wavelength and envelope in km, so they read the same
     * at any detail N. Amplitude is metres of extra relief on the belt. */
    ridgeKernels: 4000,
    ridgeWavelengthKm: 55,
    ridgeBandwidthKm: 180,
    ridgeJitter: 0.22,            // radians of per-kernel strike wobble
    ridgeAmpM: 900,
    ridgeBias: 0.30,              // sawtooth shift: peaks taller than troughs
    ridgeOrogenyMin: 0.12,        // belts weaker than this do not seed kernels
    ridgeElevRampM: 400,          // full amplitude once this far above the sea
    ridgeSmoothKm: 220,
    ridgeWarpFreq: 110,
    ridgeWarpAmp: 0.006,          // unit-sphere; ~38 km of phase meander
    ridgeWarpOctaves: 5,

    /* First-stage erosion. Grain on a ~50 km cell, not a fjord map.
     * A real Norwegian fjord is 1–6 km across, so one drowned coastal
     * cell is the whole feature. Catchment-scaled amplitudes cut
     * hundred-cell canyons and read as a drainage diagram. */
    hydraulicIters: 6,
    streamK: 0.0012,
    streamM: 0.5,
    streamDt: 1,
    streamCap: 0.22,              // one step never pulls more than this toward the receiver
    depositFrac: 0.45,
    depositSlope: 12,             // steep receivers keep less sediment (physical slope)
    thermalIters: 1,
    talusSlope: 0.7,              // ~35°, a dry talus
    thermalK: 0.12,
    thermalShare: 0.4,
    glacialIters: 3,
    glacialStrength: 0.55,
    iceTemp: 0.28,                // matches LAND_ICE in the renderer
    iceRamp: 0.18,
    paleoIceTemp: 0.58,           // last-glacial ice line; fjords on the high-latitude coasts
    paleoIceRamp: 0.16,
    iceSheetFluvial: 0.04,        // almost no running water on a live ice sheet
    iceSheetCarveScale: 0.08,     // ice sheets are domes, not alpine U-valleys
    iceSheetFjordScale: 0.06,     // Antarctica's coast is ice shelves, not Norway
    iceSheetFjordLat0: 64,        // degrees; start fading fjords toward the pole
    iceSheetFjordLat1: 72,        // no Norway-style drowning on a polar ice continent
    iceWarpDamp: 0.18,            // domain warp on ice sheets; they have smooth outlines
    glacialCarveM: 28,
    glacialConvergeM: 10,
    glacialDepositM: 6,
    glacialFjordM: 40,            // one coastal cell, tens of metres — not a 200 km inlet
    glacialFlowMin: 0.2,
    glacialFjordMin: 1.2,         // only concentrated outlets, not every icy shore
    glacialFlowCap: 6,            // catchments above this do not carve any deeper
    glacialWiden: 0.12,
    glacialTerminus: 0.3,
    glacialFjordIceMin: 0.25,
    glacialSmooth: 0.22,
    fjordFloorM: -55,             // drowned coasts, not abyssal trenches
    floodCarve: 0.18,
    floodMidFrac: 0.75,
    floodMidCarve: 0.28,
    floodEpsM: 0.25,
    floodNoiseM: 8,
    floodCarveRadius: 0.22,
    creepIters: 3,
    creepStrength: 0.11,
    noiseBaseM: 35,               // craton grain
    noiseActivityM: 160,          // extra on belts
    noiseOctaves: 4,
    noiseWavelengthKm: 120,
};


function cellSpacingKm(numRegions) {
    return 2 * EARTH_RADIUS_KM * Math.sqrt(Math.PI / numRegions);
}

function noiseFrequency(wavelengthKm) {
    return 2 * Math.PI * EARTH_RADIUS_KM / wavelengthKm;
}

function smoothstep(x, edge0, edge1) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}


/* World Orogen warpTerrain, almost line-for-line.
 *
 * Displace in the tangent plane by normalised FBM, walk this mesh toward
 * the displaced point, copy that cell's elevation, blend back. Frequency 4
 * and a 0.13 rad cap (times the slider) are theirs. Pole is Z here, so
 * east is cross(north, pos) rather than their Y-up frame. */
function warpTerrain(mesh, r_xyz, r_elevation, seed, r_hotspot, opts, r_temperature) {
    const strength = opts.warpStrength;
    if (strength <= 0) return r_elevation;

    const N = mesh.numRegions;
    const noise = new SimplexNoise(makeRandFloat(seed + 9999));
    const fbm = Tectonics.makeFbm(noise, opts.warpOctaves, 2 / 3);
    const freq = opts.warpFreq;
    const maxAmp = opts.warpMaxAmp * strength;
    const iceTemp = opts.iceTemp;
    const iceRamp = opts.iceRamp;
    const iceDamp = opts.iceWarpDamp;
    const out = new Float32Array(r_elevation);
    const neighbors = [];

    for (let r = 0; r < N; r++) {
        const px = r_xyz[3 * r], py = r_xyz[3 * r + 1], pz = r_xyz[3 * r + 2];

        let ex = -py, ey = px, ez = 0;
        const elen = Math.hypot(ex, ey);
        if (elen > 1e-10) { ex /= elen; ey /= elen; }
        else { ex = 1; ey = 0; }

        const nx = py * ez - pz * ey;
        const ny = pz * ex - px * ez;
        const nz = px * ey - py * ex;
        const nlen = Math.hypot(nx, ny, nz) || 1;
        const nnx = nx / nlen, nny = ny / nlen, nnz = nz / nlen;

        const pfx = px * freq, pfy = py * freq, pfz = pz * freq;
        let amp = maxAmp;
        if (r_temperature && iceDamp < 1) {
            const ice = smoothstep(r_temperature[r], iceTemp, iceTemp - iceRamp);
            amp *= 1 - (1 - iceDamp) * ice;
        }
        const d1 = fbm(pfx, pfy, pfz) * amp;
        const d2 = fbm(pfx + 31.7, pfy + 47.3, pfz + 19.1) * amp;

        let wx = px + ex * d1 + nnx * d2;
        let wy = py + ey * d1 + nny * d2;
        let wz = pz + ez * d1 + nnz * d2;
        const wlen = Math.hypot(wx, wy, wz) || 1;
        wx /= wlen; wy /= wlen; wz /= wlen;

        let cur = r;
        let bestDot = wx * px + wy * py + wz * pz;
        for (let guard = 0; guard < 64; guard++) {
            let moved = -1;
            mesh.r_circulate_r(neighbors, cur);
            for (let i = 0; i < neighbors.length; i++) {
                const nb = neighbors[i];
                const dot = wx * r_xyz[3 * nb] + wy * r_xyz[3 * nb + 1] + wz * r_xyz[3 * nb + 2];
                if (dot > bestDot) {
                    bestDot = dot;
                    moved = nb;
                }
            }
            if (moved === -1) break;
            cur = moved;
        }
        out[r] = r_elevation[cur];
    }

    const warpBias = opts.warpBiasBase + opts.warpBiasStrengthScale * strength;
    for (let r = 0; r < N; r++) {
        const orig = r_elevation[r];
        const warped = out[r];
        let bias = warpBias;
        if (r_hotspot) {
            const hotFrac = Math.min(1, Math.abs(r_hotspot[r]) / (Math.abs(orig) || 1));
            bias *= 1 - opts.warpHotspotDampen * hotFrac;
        }
        /* Warp is texture, not a new geography. An 800 km lookup will
         * otherwise close the Med and Drake Passage by sampling a
         * continent onto a strait. */
        if ((orig >= 0) !== (warped >= 0)) bias *= opts.warpCoastKeep != null ? opts.warpCoastKeep : 0.12;
        r_elevation[r] = orig + (warped - orig) * bias;
    }
    return r_elevation;
}


/* Both meshes are Fibonacci spheres plus a south pole, so index is a
 * decent z-hint. The walk from there is a handful of hops. */
function simIndexHint(d, detailN, simN) {
    if (d >= detailN - 1) return simN - 1;
    if (simN <= 1) return 0;
    return Math.max(0, Math.min(simN - 2,
        Math.round(d * (simN - 1) / Math.max(1, detailN - 1))));
}


function keepRidgeLine(mesh, field) {
    if (!field) return;
    const {numRegions} = mesh;
    const keep = new Float32Array(numRegions);
    const neighbors = [];
    for (let r = 0; r < numRegions; r++) {
        const v = field[r];
        if (v <= 0) continue;
        mesh.r_circulate_r(neighbors, r);
        let highest = true;
        for (let i = 0; i < neighbors.length; i++) {
            if (field[neighbors[i]] > v) { highest = false; break; }
        }
        if (highest) keep[r] = v;
    }
    field.set(keep);
}


function smoothOrogenyDir(mesh, r_orogeny, r_orogenyDir, floor, passes) {
    if (passes <= 0 || !r_orogenyDir) return r_orogenyDir;
    const n = mesh.numRegions;
    let cur = new Float32Array(r_orogenyDir);
    let next = new Float32Array(n * 3);
    const neighbors = [];
    for (let pass = 0; pass < passes; pass++) {
        next.set(cur);
        for (let r = 0; r < n; r++) {
            const w0 = r_orogeny[r];
            if (w0 < floor) continue;
            let ax = cur[3 * r] * w0, ay = cur[3 * r + 1] * w0, az = cur[3 * r + 2] * w0;
            mesh.r_circulate_r(neighbors, r);
            for (let i = 0; i < neighbors.length; i++) {
                const nb = neighbors[i];
                const w = r_orogeny[nb];
                if (w < floor) continue;
                ax += cur[3 * nb] * w;
                ay += cur[3 * nb + 1] * w;
                az += cur[3 * nb + 2] * w;
            }
            const len = Math.hypot(ax, ay, az);
            if (len > 1e-6) {
                next[3 * r] = ax / len;
                next[3 * r + 1] = ay / len;
                next[3 * r + 2] = az / len;
            }
        }
        const tmp = cur; cur = next; next = tmp;
    }
    return cur;
}


/* Directional Gabor / phasor ridges along belts, oriented by the compression
 * recorded at collision time. Phase advances along that axis, so the ridgelines
 * run with the orogen strike. Domain-warped so they meander instead of tracing
 * small-circles. */
function applyPhasorRidges(mesh, r_xyz, meters, r_orogeny, r_orogenyDir, seed, opts) {
    if (!r_orogeny || !r_orogenyDir) return meters;
    const n = mesh.numRegions;
    const floor = opts.ridgeOrogenyMin;
    const avgEdgeKm = (Math.PI * EARTH_RADIUS_KM) / Math.sqrt(n);
    const smoothPasses = Math.max(2, Math.round(opts.ridgeSmoothKm / avgEdgeKm));
    const dir = smoothOrogenyDir(mesh, r_orogeny, r_orogenyDir, floor, smoothPasses);

    const candidates = [];
    for (let r = 0; r < n; r++) {
        if (meters[r] < 0) continue;
        if (r_orogeny[r] < floor) continue;
        const dx = dir[3 * r], dy = dir[3 * r + 1], dz = dir[3 * r + 2];
        if (dx * dx + dy * dy + dz * dz < 0.05) continue;
        candidates.push(r);
    }
    if (candidates.length === 0) return meters;

    const rng = makeRandFloat(seed + 1313);
    for (let i = candidates.length - 1; i > 0; i--) {
        const j = (rng() * (i + 1)) | 0;
        const t = candidates[i]; candidates[i] = candidates[j]; candidates[j] = t;
    }

    const wavelengthRad = opts.ridgeWavelengthKm / EARTH_RADIUS_KM;
    const bandwidthRad = opts.ridgeBandwidthKm / EARTH_RADIUS_KM;
    const frequency = 1 / wavelengthRad;
    const invBw2 = -0.5 / (bandwidthRad * bandwidthRad);
    const envelopeCutoffSq = 9 * bandwidthRad * bandwidthRad;

    const numKernels = Math.min(opts.ridgeKernels, candidates.length);
    const kernels = [];
    for (let ki = 0; ki < numKernels; ki++) {
        const r = candidates[ki];
        const px = r_xyz[3 * r], py = r_xyz[3 * r + 1], pz = r_xyz[3 * r + 2];
        let dx = dir[3 * r], dy = dir[3 * r + 1], dz = dir[3 * r + 2];
        const radial = dx * px + dy * py + dz * pz;
        dx -= radial * px; dy -= radial * py; dz -= radial * pz;
        const dLen = Math.hypot(dx, dy, dz);
        if (dLen < 1e-6) continue;
        dx /= dLen; dy /= dLen; dz /= dLen;

        const jitter = (rng() - 0.5) * 2 * opts.ridgeJitter;
        const cosJ = Math.cos(jitter), sinJ = Math.sin(jitter);
        const cx = py * dz - pz * dy;
        const cy = pz * dx - px * dz;
        const cz = px * dy - py * dx;
        kernels.push({
            x: px, y: py, z: pz,
            dx: dx * cosJ + cx * sinJ,
            dy: dy * cosJ + cy * sinJ,
            dz: dz * cosJ + cz * sinJ,
            phase: rng() * 2 * Math.PI,
        });
    }
    if (kernels.length === 0) return meters;

    const PLAT = 36, PLON = 72;
    const grid = new Array(PLAT * PLON);
    for (let ki = 0; ki < kernels.length; ki++) {
        const k = kernels[ki];
        const lat = Math.asin(Math.max(-1, Math.min(1, k.z)));
        const lon = Math.atan2(k.y, k.x);
        const bi = Math.max(0, Math.min(PLAT - 1, Math.floor((lat + Math.PI / 2) / Math.PI * PLAT)));
        const bj = Math.max(0, Math.min(PLON - 1, Math.floor((lon + Math.PI) / (2 * Math.PI) * PLON)));
        const bin = bi * PLON + bj;
        if (!grid[bin]) grid[bin] = [];
        grid[bin].push(ki);
    }
    const searchBins = Math.max(1, Math.ceil(3 * bandwidthRad / (Math.PI / PLAT)));
    const warpNoise = new SimplexNoise(makeRandFloat(seed + 1717));
    const fbm = Tectonics.makeFbm(warpNoise, opts.ridgeWarpOctaves, 0.5);
    const wf = opts.ridgeWarpFreq, wa = opts.ridgeWarpAmp;

    for (let r = 0; r < n; r++) {
        if (meters[r] < 0) continue;
        const oro = r_orogeny[r];
        if (oro < floor * 0.5) continue;

        const px = r_xyz[3 * r], py = r_xyz[3 * r + 1], pz = r_xyz[3 * r + 2];
        const warpX = fbm(px * wf + 17.3, py * wf + 28.4, pz * wf + 9.1) * wa;
        const warpY = fbm(px * wf + 5.2, py * wf + 33.6, pz * wf + 22.8) * wa;
        const warpZ = fbm(px * wf + 11.7, py * wf + 6.9, pz * wf + 41.5) * wa;
        const wpx = px + warpX, wpy = py + warpY, wpz = pz + warpZ;

        const lat = Math.asin(Math.max(-1, Math.min(1, pz)));
        const lon = Math.atan2(py, px);
        const rbi = Math.max(0, Math.min(PLAT - 1, Math.floor((lat + Math.PI / 2) / Math.PI * PLAT)));
        const rbj = Math.max(0, Math.min(PLON - 1, Math.floor((lon + Math.PI) / (2 * Math.PI) * PLON)));

        let re = 0, im = 0, envSum = 0;
        for (let di = -searchBins; di <= searchBins; di++) {
            const bi = rbi + di;
            if (bi < 0 || bi >= PLAT) continue;
            for (let dj = -searchBins; dj <= searchBins; dj++) {
                const bj = ((rbj + dj) % PLON + PLON) % PLON;
                const cell = grid[bi * PLON + bj];
                if (!cell) continue;
                for (let ci = 0; ci < cell.length; ci++) {
                    const k = kernels[cell[ci]];
                    const ddx = px - k.x, ddy = py - k.y, ddz = pz - k.z;
                    const chordSq = ddx * ddx + ddy * ddy + ddz * ddz;
                    if (chordSq > envelopeCutoffSq) continue;
                    const envelope = Math.exp(chordSq * invBw2);
                    if (envelope < 0.01) continue;
                    const phaseCoord = wpx * k.dx + wpy * k.dy + wpz * k.dz;
                    const phase = 2 * Math.PI * frequency * phaseCoord + k.phase;
                    re += envelope * Math.cos(phase);
                    im += envelope * Math.sin(phase);
                    envSum += envelope;
                }
            }
        }
        if (envSum < 0.02) continue;

        const ridgeCentered = Math.atan2(im, re) / (2 * Math.PI) + opts.ridgeBias;
        const elevGate = Math.min(1, meters[r] / Math.max(1, opts.ridgeElevRampM));
        const oroGate = Math.min(1, oro);
        meters[r] += ridgeCentered * opts.ridgeAmpM * elevGate * oroGate;
        if (meters[r] < 0) meters[r] = 0;
    }
    return meters;
}


function simMetersOf(simMap) {
    if (simMap.r_meters) return simMap.r_meters;
    const n = simMap.r_elevation.length;
    const meters = new Float32Array(n);
    for (let r = 0; r < n; r++) meters[r] = Tectonics.elevationToMeters(simMap.r_elevation[r]);
    return meters;
}


function applyDetailPass(simMesh, simMap, detailMesh, detailXyz, seed, options) {
    const opts = Object.assign({}, DEFAULTS, options);
    const tectOpts = Object.assign({}, Tectonics.DEFAULTS, options);
    const {numRegions} = detailMesh;
    const simN = simMesh.numRegions;
    const simXyz = simMap.r_xyz;
    const simMeters = simMetersOf(simMap);

    const meters = new Float32Array(numRegions);
    const r_arc = new Float32Array(numRegions);
    const r_hotspot = new Float32Array(numRegions);
    const r_orogeny = new Float32Array(numRegions);
    const r_orogenyDir = new Float32Array(numRegions * 3);
    const r_crust_age = new Float32Array(numRegions);
    const r_moisture = new Float32Array(numRegions);
    const r_temperature = new Float32Array(numRegions);
    const r_crust_type = new Uint8Array(numRegions);
    const r_boundary = new Uint8Array(numRegions);
    const r_plate = new Int32Array(numRegions);
    const sourceLand = new Uint8Array(numRegions);

    const out_r = [];
    const cells = [];
    const weights = [];
    const here = [0, 0, 0];

    const hasArc = !!simMap.r_arc;
    const hasHot = !!simMap.r_hotspot;
    const hasOrogeny = !!simMap.r_orogeny;
    const hasOrogenyDir = !!simMap.r_orogenyDir;
    const hasAge = !!simMap.r_crust_age;
    const hasType = !!simMap.r_crust_type;
    const hasBoundary = !!simMap.r_boundary;
    const hasPlate = !!simMap.r_plate;
    const hasMoisture = !!simMap.r_moisture;
    const hasTemperature = !!simMap.r_temperature;
    const dirScratch = [0, 0, 0];

    for (let r = 0; r < numRegions; r++) {
        here[0] = detailXyz[3 * r];
        here[1] = detailXyz[3 * r + 1];
        here[2] = detailXyz[3 * r + 2];
        const at = Tectonics.nearestRegion(
            simMesh, simXyz, here, simIndexHint(r, numRegions, simN), out_r);
        Tectonics.sampleWeights(simMesh, simXyz, here, at, out_r, cells, weights);
        meters[r] = Tectonics.sampleField(simMeters, cells, weights);
        if (hasArc) r_arc[r] = Tectonics.sampleField(simMap.r_arc, cells, weights);
        if (hasHot) r_hotspot[r] = Tectonics.sampleField(simMap.r_hotspot, cells, weights);
        if (hasOrogeny) r_orogeny[r] = Tectonics.sampleField(simMap.r_orogeny, cells, weights);
        if (hasOrogenyDir) {
            Tectonics.samplePacked3(simMap.r_orogenyDir, cells, weights, dirScratch);
            r_orogenyDir[3 * r] = dirScratch[0];
            r_orogenyDir[3 * r + 1] = dirScratch[1];
            r_orogenyDir[3 * r + 2] = dirScratch[2];
        }
        if (hasAge) r_crust_age[r] = Tectonics.sampleField(simMap.r_crust_age, cells, weights);
        if (hasMoisture) r_moisture[r] = Tectonics.sampleField(simMap.r_moisture, cells, weights);
        if (hasTemperature) r_temperature[r] = Tectonics.sampleField(simMap.r_temperature, cells, weights);
        if (hasType) r_crust_type[r] = simMap.r_crust_type[at];
        if (hasBoundary) r_boundary[r] = simMap.r_boundary[at];
        if (hasPlate) r_plate[r] = simMap.r_plate[at];
        sourceLand[r] = simMap.r_elevation[at] >= 0 ? 1 : 0;
    }

    const r_elevation = new Float32Array(numRegions);
    for (let r = 0; r < numRegions; r++) {
        r_elevation[r] = Tectonics.metersToElevation(meters[r]);
    }
    warpTerrain(detailMesh, detailXyz, r_elevation, seed, hasHot ? r_hotspot : null, opts,
        hasTemperature ? r_temperature : null);
    for (let r = 0; r < numRegions; r++) {
        meters[r] = Tectonics.elevationToMeters(r_elevation[r]);
    }

    /* The transferred arc field is as wide as a sim cell (~226 km). Crests
     * along that whole blob would be a wall of islands. Keep only the ridge
     * line — cells that stand above their neighbours — so the same noise
     * that used to pick stretches of a 226 km front now picks stretches of
     * a one-cell chain. */
    const crestArc = Float32Array.from(r_arc);
    const crestHot = Float32Array.from(r_hotspot);
    keepRidgeLine(detailMesh, crestArc);
    keepRidgeLine(detailMesh, crestHot);

    Tectonics.applyIslandCrests(
        detailMesh, detailXyz, meters, r_crust_type, crestArc, crestHot, seed,
        Object.assign({}, tectOpts, {
            crestFrequency: noiseFrequency(opts.islandWavelengthKm),
        }));

    applyPhasorRidges(
        detailMesh, detailXyz, meters, hasOrogeny ? r_orogeny : null,
        hasOrogenyDir ? r_orogenyDir : null, seed, opts);

    const lapse = Climate.DEFAULTS.lapse;
    for (let r = 0; r < numRegions; r++) {
        const elevNow = Tectonics.metersToElevation(meters[r]);
        if (hasTemperature) r_temperature[r] -= lapse * (elevNow - r_elevation[r]);
        r_elevation[r] = elevNow;
        if (elevNow >= 0 && !sourceLand[r]) r_moisture[r] = 0.7;
    }

    const erosionOpts = Object.assign({}, opts, {
        noiseFreq: noiseFrequency(opts.noiseWavelengthKm),
    });
    Erosion.applyErosion(
        detailMesh, detailXyz, meters, hasTemperature ? r_temperature : null,
        hasOrogeny ? r_orogeny : null, hasArc ? r_arc : null, seed, erosionOpts);

    for (let r = 0; r < numRegions; r++) {
        const prevElev = r_elevation[r];
        r_elevation[r] = Tectonics.metersToElevation(meters[r]);
        if (hasTemperature) r_temperature[r] -= lapse * (r_elevation[r] - prevElev);
    }

    Tectonics.polarStraits(detailMesh, detailXyz, r_elevation, tectOpts, meters);

    return {
        plates: simMap.plates,
        plate_is_ocean: simMap.plate_is_ocean,
        plate_centroid: simMap.plate_centroid,
        plate_vec: simMap.plate_vec,
        extra_ocean_seeds: simMap.extra_ocean_seeds,
        hotspots: simMap.hotspots,
        nextPlateId: simMap.nextPlateId,
        elapsedMyr: simMap.elapsedMyr,
        targetPlateCount: simMap.targetPlateCount,
        r_xyz: detailXyz,
        r_elevation,
        r_moisture,
        r_temperature,
        r_meters: meters,
        r_arc: hasArc ? r_arc : null,
        r_hotspot: hasHot ? r_hotspot : null,
        r_orogeny: hasOrogeny ? r_orogeny : null,
        r_orogenyDir: hasOrogenyDir ? r_orogenyDir : null,
        r_crust_age: hasAge ? r_crust_age : null,
        r_crust_type: hasType ? r_crust_type : null,
        r_boundary: hasBoundary ? r_boundary : null,
        r_plate: hasPlate ? r_plate : simMap.r_plate,
    };
}


module.exports = {
    DEFAULTS,
    EARTH_RADIUS_KM,
    cellSpacingKm,
    noiseFrequency,
    warpTerrain,
    applyPhasorRidges,
    applyDetailPass,
};
