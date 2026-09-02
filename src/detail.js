/*
 * Detail pass: a second mesh that carries the heightmap the renderer sees.
 *
 * The simulation stays on its tuned 10k–40k mesh. This module builds a
 * finer sphere, samples the simulation's metres field onto it, then
 * warps that height the way World Orogen does: normalised FBM in the
 * tangent plane, greedy walk, blend. Island crests go on after.
 * A coastal-water pass then raises drowned-margin islands and opens a
 * short low neck on an inland sea. Oriented phasor ridges and a
 * first-stage erosion pass follow, so the belts have grain and the
 * slopes drain somewhere.
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
const World = require('./world');


const DEFAULTS = {
    /* Grain of the sketch the diffusion model eats. Cell count is derived
     * from this and the planet radius in freezeConfig. n is only a fallback
     * when a caller passes detailN (tests, inspect). */
    shapeSpacingKm: 23,
    n: 200000,                    // regions on the detail mesh; derived at run
    /* World Orogen warpTerrain (terrain-post.js / terrain-config.js). */
    warpStrength: 0.75,           // their Terrain Warp slider default
    warpFreq: 4,                  // unit-sphere; ~10000 km wavelength
    warpOctaves: 4,               // the 5th octave put ±100 km of wiggle at 600 km
                                  // wavelength on every coast; real coasts are far
                                  // cleaner than that
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
    iceTemp: 0.28,                // same threshold as Look.LAND_ICE; kept here so this module does not import GLSL
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
    floodNoiseM: 4,
    floodCarveRadius: 0.22,
    creepIters: 3,
    creepStrength: 0.11,
    noiseBaseM: 16,               // craton grain. On a coastal plain sloping ~1 m/km,
                                  // 35 m of noise moved the shoreline ±40 km at 120 km
                                  // wavelength — uniform fuzz on every coast
    noiseActivityM: 160,          // extra on belts
    noiseOctaves: 4,
    noiseWavelengthKm: 120,

    /* Coastal water. Warp is damped at land/ocean swaps so it cannot
     * open a Channel or raise Britain. Layout owns the basin; this pass
     * owns the shore: shelf islands, and a 1–2 cell mouth on an inland
     * sea that already almost meets the ocean. */
    shelfLoM: -220,               // drowned continental crust shallow enough to emerge
    shelfHiM: 0,                  // only raise what is still water; a coastal plain stays
    shelfIslandM: 48,             // a body, not a volcano
    shelfNoiseThresh: 0.35,
    shelfWavelengthKm: 160,
    shelfMaxBodyCells: 700,       // bigger than this is the shelf itself, not an island
    straitMinBasin: 80,           // skip ponds; a body of water here is at least a few cells
    straitMaxLandHops: 4,         // ~90 km. Wider mouths stay Layout's gap
    straitMaxM: 80,               // a flooded shelf neck, not a mountain isthmus
    straitFloorM: -42,
    straitMinSplit: 4000,         // do not cut Panama: both sides would stay huge
};


function cellSpacingKm(numRegions, opts) {
    return World.cellSpacingKm(numRegions, opts);
}

function noiseFrequency(wavelengthKm, opts) {
    return 2 * Math.PI * opts.radiusKm / wavelengthKm;
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


function dropSpecks(mesh, field, minCells) {
    if (!field || minCells <= 1) return;
    const n = mesh.numRegions;
    const seen = new Uint8Array(n);
    const neighbors = [];
    for (let r = 0; r < n; r++) {
        if (field[r] <= 0 || seen[r]) continue;
        const stack = [r];
        seen[r] = 1;
        const cells = [r];
        while (stack.length) {
            const at = stack.pop();
            mesh.r_circulate_r(neighbors, at);
            for (let i = 0; i < neighbors.length; i++) {
                const nb = neighbors[i];
                if (seen[nb] || field[nb] <= 0) continue;
                seen[nb] = 1;
                stack.push(nb);
                cells.push(nb);
            }
        }
        if (cells.length < minCells) {
            for (let i = 0; i < cells.length; i++) field[cells[i]] = 0;
        }
    }
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
    const avgEdgeKm = (Math.PI * opts.radiusKm) / Math.sqrt(n);
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

    const wavelengthRad = opts.ridgeWavelengthKm / opts.radiusKm;
    const bandwidthRad = opts.ridgeBandwidthKm / opts.radiusKm;
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


function waterComponents(mesh, isLand, n) {
    const id = new Int32Array(n).fill(-1);
    const sizes = [];
    const nb = [];
    let nC = 0;
    for (let r = 0; r < n; r++) {
        if (isLand[r] || id[r] >= 0) continue;
        const q = [r];
        id[r] = nC;
        let size = 0;
        for (let i = 0; i < q.length; i++) {
            size++;
            mesh.r_circulate_r(nb, q[i]);
            for (let j = 0; j < nb.length; j++) {
                const k = nb[j];
                if (isLand[k] || id[k] >= 0) continue;
                id[k] = nC;
                q.push(k);
            }
        }
        sizes.push(size);
        nC++;
    }
    let world = 0;
    for (let c = 1; c < nC; c++) if (sizes[c] > sizes[world]) world = c;
    return {id, sizes, world};
}


function largeLandCount(mesh, isLand, minKeep) {
    const n = isLand.length;
    const seen = new Uint8Array(n);
    const nb = [];
    let nLarge = 0;
    for (let r = 0; r < n; r++) {
        if (!isLand[r] || seen[r]) continue;
        const q = [r];
        seen[r] = 1;
        let sz = 0;
        for (let i = 0; i < q.length; i++) {
            sz++;
            mesh.r_circulate_r(nb, q[i]);
            for (let j = 0; j < nb.length; j++) {
                const k = nb[j];
                if (!isLand[k] || seen[k]) continue;
                seen[k] = 1;
                q.push(k);
            }
        }
        if (sz >= minKeep) nLarge++;
    }
    return nLarge;
}


/* Inland seas are Layout holes. A mouth that is already a short, low
 * neck becomes a 1–2 cell strait. A mountain isthmus (Gibraltar as the
 * fixture paints it, Panama) stays. Shallow drowned continental crust
 * becomes island bodies of at least two cells. */
function sculptCoastalWater(mesh, r_xyz, meters, r_crust_type, seed, opts) {
    const n = mesh.numRegions;
    const CONTINENTAL = Tectonics.CRUST_CONTINENTAL;
    const isLand = new Uint8Array(n);
    for (let r = 0; r < n; r++) if (meters[r] >= 0) isLand[r] = 1;

    const water = waterComponents(mesh, isLand, n);
    const nb = [];
    const floor = opts.straitFloorM;
    const maxHops = opts.straitMaxLandHops;
    const maxM = opts.straitMaxM;
    const minBasin = opts.straitMinBasin;
    const minSplit = opts.straitMinSplit;

    for (let c = 0; c < water.sizes.length; c++) {
        if (c === water.world || water.sizes[c] < minBasin) continue;
        const dist = new Int32Array(n).fill(-1);
        const prev = new Int32Array(n).fill(-1);
        const q = [];
        for (let r = 0; r < n; r++) {
            if (water.id[r] !== c) continue;
            dist[r] = 0;
            q.push(r);
        }
        for (let i = 0; i < q.length; i++) {
            mesh.r_circulate_r(nb, q[i]);
            for (let j = 0; j < nb.length; j++) {
                const k = nb[j];
                if (dist[k] < 0) {
                    dist[k] = dist[q[i]] + 1;
                    prev[k] = q[i];
                    q.push(k);
                }
            }
        }
        let best = 1e9, who = -1;
        for (let r = 0; r < n; r++) {
            if (water.id[r] !== water.world || dist[r] < 0) continue;
            if (dist[r] < best) { best = dist[r]; who = r; }
        }
        if (who < 0) continue;
        const land = [];
        let cur = who, guard = 0;
        while (cur >= 0 && guard++ < n) {
            if (isLand[cur]) land.push(cur);
            if (water.id[cur] === c) break;
            cur = prev[cur];
        }
        if (land.length < 1 || land.length > maxHops) continue;
        let high = 0;
        for (let i = 0; i < land.length; i++) high = Math.max(high, meters[land[i]]);
        if (high > maxM) continue;
        const trial = new Uint8Array(isLand);
        for (let i = 0; i < land.length; i++) trial[land[i]] = 0;
        if (largeLandCount(mesh, trial, minSplit) > largeLandCount(mesh, isLand, minSplit)) continue;
        for (let i = 0; i < land.length; i++) {
            meters[land[i]] = Math.min(meters[land[i]], floor);
            isLand[land[i]] = 0;
        }
    }

    const lo = opts.shelfLoM, hi = opts.shelfHiM;
    const dest = opts.shelfIslandM;
    const thresh = opts.shelfNoiseThresh;
    const maxBody = opts.shelfMaxBodyCells;
    const freq = noiseFrequency(opts.shelfWavelengthKm, opts);
    const noise = new SimplexNoise(makeRandFloat(seed + 0x51e11d));
    const fbm = Tectonics.makeFbm(noise, 4, 0.55);
    const pick = new Float32Array(n);
    for (let r = 0; r < n; r++) {
        if (r_crust_type[r] !== CONTINENTAL) continue;
        if (meters[r] < lo || meters[r] >= hi) continue;
        const x = freq * r_xyz[3 * r], y = freq * r_xyz[3 * r + 1], z = freq * r_xyz[3 * r + 2];
        if (fbm(x, y, z) > thresh) pick[r] = 1;
    }
    dropSpecks(mesh, pick, 4);
    const seen = new Uint8Array(n);
    for (let r = 0; r < n; r++) {
        if (pick[r] <= 0 || seen[r]) continue;
        const cells = [r];
        seen[r] = 1;
        for (let i = 0; i < cells.length; i++) {
            mesh.r_circulate_r(nb, cells[i]);
            for (let j = 0; j < nb.length; j++) {
                const k = nb[j];
                if (seen[k] || pick[k] <= 0) continue;
                seen[k] = 1;
                cells.push(k);
            }
        }
        if (cells.length > maxBody) continue;
        let touchesLand = false;
        for (let i = 0; i < cells.length && !touchesLand; i++) {
            mesh.r_circulate_r(nb, cells[i]);
            for (let j = 0; j < nb.length; j++) {
                if (isLand[nb[j]] && pick[nb[j]] <= 0) { touchesLand = true; break; }
            }
        }
        if (touchesLand) continue;
        for (let i = 0; i < cells.length; i++) {
            if (meters[cells[i]] < dest) meters[cells[i]] = dest;
        }
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
    const opts = World.derive(Object.assign({}, World.DEFAULTS, DEFAULTS, options));
    const tectOpts = Object.assign({}, Tectonics.DEFAULTS, options);
    const {numRegions} = detailMesh;
    const simN = simMesh.numRegions;
    const simXyz = simMap.r_xyz;
    const simMeters = simMetersOf(simMap);

    const meters = new Float32Array(numRegions);
    const r_arc = new Float32Array(numRegions);
    const r_arcPeak = new Float32Array(numRegions);
    const r_arcAge = new Float32Array(numRegions);
    const r_arcDir = new Float32Array(numRegions * 3);
    const r_hotspot = new Float32Array(numRegions);
    const r_hotspotPeak = new Float32Array(numRegions);
    const r_hotspotAge = new Float32Array(numRegions);
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
    const hasArcPeak = !!simMap.r_arcPeak;
    const hasArcAge = !!simMap.r_arcAge;
    const hasArcDir = !!simMap.r_arcDir;
    const hasHot = !!simMap.r_hotspot;
    const hasHotPeak = !!simMap.r_hotspotPeak;
    const hasHotAge = !!simMap.r_hotspotAge;
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
        if (hasArcPeak) r_arcPeak[r] = Tectonics.sampleField(simMap.r_arcPeak, cells, weights);
        if (hasArcAge) r_arcAge[r] = Tectonics.sampleField(simMap.r_arcAge, cells, weights);
        if (hasArcDir) {
            Tectonics.samplePacked3(simMap.r_arcDir, cells, weights, dirScratch);
            r_arcDir[3 * r] = dirScratch[0];
            r_arcDir[3 * r + 1] = dirScratch[1];
            r_arcDir[3 * r + 2] = dirScratch[2];
        }
        if (hasHot) r_hotspot[r] = Tectonics.sampleField(simMap.r_hotspot, cells, weights);
        if (hasHotPeak) r_hotspotPeak[r] = Tectonics.sampleField(simMap.r_hotspotPeak, cells, weights);
        if (hasHotAge) r_hotspotAge[r] = Tectonics.sampleField(simMap.r_hotspotAge, cells, weights);
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
     * along that whole blob would be a wall of islands. Live volcanoes keep
     * the ridge line. Isolated 1-cell cones wait for Carve. A plume on a
     * spreading ridge is a plateau. Extinct-arc ribbons stay on the story
     * maps until those cells join into a sausage — lifting them here makes
     * a field of icy specks. */
    const emerge = tectOpts.arcEmergeThreshold;
    const crestLive = new Float32Array(numRegions);
    const crestHot = Float32Array.from(r_hotspot);
    const crestPlateau = new Float32Array(numRegions);
    const nb = [];
    const DIVERGENT = Tectonics.BOUNDARY_DIVERGENT;
    const OCEANIC = Tectonics.CRUST_OCEANIC;
    for (let r = 0; r < numRegions; r++) {
        if (r_crust_type[r] !== OCEANIC) {
            crestHot[r] = 0;
            continue;
        }
        crestLive[r] = r_arc[r];

        if (crestHot[r] < emerge) {
            crestHot[r] = 0;
            continue;
        }
        let onRidge = hasBoundary && r_boundary[r] === DIVERGENT;
        if (!onRidge && hasBoundary) {
            detailMesh.r_circulate_r(nb, r);
            for (let i = 0; i < nb.length; i++) {
                if (r_boundary[nb[i]] === DIVERGENT) { onRidge = true; break; }
            }
        }
        if (onRidge) {
            crestPlateau[r] = crestHot[r];
            crestHot[r] = 0;
        }
    }
    keepRidgeLine(detailMesh, crestLive);
    dropSpecks(detailMesh, crestLive, 2);
    keepRidgeLine(detailMesh, crestHot);
    dropSpecks(detailMesh, crestHot, 2);
    dropSpecks(detailMesh, crestPlateau, 6);

    const crestOpts = Object.assign({}, tectOpts, {
        crestFrequency: noiseFrequency(opts.islandWavelengthKm, opts),
    });
    Tectonics.applyIslandCrests(
        detailMesh, detailXyz, meters, r_crust_type, crestLive, crestHot, seed, crestOpts);
    Tectonics.applyIslandCrests(
        detailMesh, detailXyz, meters, r_crust_type, null, crestPlateau, seed,
        Object.assign({}, crestOpts, {islandBody: 'plateau'}));

    sculptCoastalWater(detailMesh, detailXyz, meters, r_crust_type, seed, opts);

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
        r_arcPeak: hasArcPeak ? r_arcPeak : null,
        r_arcAge: hasArcAge ? r_arcAge : null,
        r_arcDir: hasArcDir ? r_arcDir : null,
        r_hotspot: hasHot ? r_hotspot : null,
        r_hotspotPeak: hasHotPeak ? r_hotspotPeak : null,
        r_hotspotAge: hasHotAge ? r_hotspotAge : null,
        r_orogeny: hasOrogeny ? r_orogeny : null,
        r_orogenyDir: hasOrogenyDir ? r_orogenyDir : null,
        r_crust_age: hasAge ? r_crust_age : null,
        r_crust_type: hasType ? r_crust_type : null,
        r_boundary: hasBoundary ? r_boundary : null,
        r_plate: hasPlate ? r_plate : simMap.r_plate,
    };
}


function applyErosionPass(detailMesh, detailXyz, map, seed, options) {
    const opts = World.derive(Object.assign({}, World.DEFAULTS, DEFAULTS, options));
    const lapse = Climate.DEFAULTS.lapse;
    const meters = map.r_meters;
    const r_elevation = map.r_elevation;
    const r_temperature = map.r_temperature;
    Erosion.applyErosion(
        detailMesh, detailXyz, meters, r_temperature,
        map.r_orogeny, map.r_arc, seed,
        Object.assign({}, opts, {noiseFreq: noiseFrequency(opts.noiseWavelengthKm, opts)}));
    for (let r = 0; r < detailMesh.numRegions; r++) {
        const prevElev = r_elevation[r];
        r_elevation[r] = Tectonics.metersToElevation(meters[r]);
        if (r_temperature) r_temperature[r] -= lapse * (r_elevation[r] - prevElev);
    }
    return map;
}


module.exports = {
    DEFAULTS,
    cellSpacingKm,
    noiseFrequency,
    warpTerrain,
    applyPhasorRidges,
    sculptCoastalWater,
    applyDetailPass,
    applyErosionPass,
};
