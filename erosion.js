/*
 * First-stage erosion on the detail mesh.
 *
 * Rough shaping only: every land cell drains to the sea, a few stream-power
 * steps cut valleys, talus relaxes steep faces, ice carves U-valleys and
 * fjords where the climate says it belongs, and soil creep rounds hillslopes.
 * Real river networks, discharge and lakes wait for the post-diffusion pass.
 *
 * Inland seas are left alone. The flood seeds from the world ocean, never
 * from a closed basin, and does not fill depressions the way a topology
 * fixup would.
 */
'use strict';

const SimplexNoise = require('simplex-noise');
const {makeRandFloat} = require('@redblobgames/prng');
const Tectonics = require('./tectonics');

const EARTH_RADIUS_KM = 6371;
const EARTH_AREA_KM2 = 4 * Math.PI * EARTH_RADIUS_KM * EARTH_RADIUS_KM;


function cellAreaKm2(numRegions) {
    return EARTH_AREA_KM2 / numRegions;
}

function chordKm(r_xyz, a, b) {
    const dx = r_xyz[3 * a] - r_xyz[3 * b];
    const dy = r_xyz[3 * a + 1] - r_xyz[3 * b + 1];
    const dz = r_xyz[3 * a + 2] - r_xyz[3 * b + 2];
    const chord = Math.hypot(dx, dy, dz);
    if (chord < 1e-8) return 1e-3;
    const half = Math.min(1, 0.5 * chord);
    return 2 * EARTH_RADIUS_KM * Math.asin(half);
}


class MinHeap {
    constructor(keys) {
        this._key = keys;
        this._data = [];
    }
    get size() { return this._data.length; }
    push(cell) {
        const data = this._data;
        const key = this._key;
        data.push(cell);
        let i = data.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (key[data[i]] >= key[data[p]]) break;
            const t = data[i]; data[i] = data[p]; data[p] = t;
            i = p;
        }
    }
    pop() {
        const data = this._data;
        const key = this._key;
        const top = data[0];
        const last = data.pop();
        if (data.length === 0) return top;
        data[0] = last;
        let i = 0;
        const n = data.length;
        for (;;) {
            let s = i;
            const l = 2 * i + 1, r = l + 1;
            if (l < n && key[data[l]] < key[data[s]]) s = l;
            if (r < n && key[data[r]] < key[data[s]]) s = r;
            if (s === i) break;
            const t = data[i]; data[i] = data[s]; data[s] = t;
            i = s;
        }
        return top;
    }
}


function markOcean(meters, n) {
    const ocean = new Uint8Array(n);
    for (let r = 0; r < n; r++) if (meters[r] < 0) ocean[r] = 1;
    return ocean;
}


/* Largest connected body of water is the world ocean. Closed basins stay
 * inland seas and are not treated as outlets. */
function worldOceanMask(mesh, ocean) {
    const n = mesh.numRegions;
    const label = new Int32Array(n).fill(-1);
    const sizes = [];
    const neighbors = [];
    for (let r = 0; r < n; r++) {
        if (!ocean[r] || label[r] >= 0) continue;
        const id = sizes.length;
        let size = 0;
        const queue = [r];
        label[r] = id;
        for (let h = 0; h < queue.length; h++) {
            size++;
            mesh.r_circulate_r(neighbors, queue[h]);
            for (let i = 0; i < neighbors.length; i++) {
                const nb = neighbors[i];
                if (ocean[nb] && label[nb] < 0) {
                    label[nb] = id;
                    queue.push(nb);
                }
            }
        }
        sizes.push(size);
    }
    let main = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;
    const open = new Uint8Array(n);
    for (let r = 0; r < n; r++) if (ocean[r] && label[r] === main) open[r] = 1;
    return open;
}


function cellNoise(r, amp) {
    let h = (Math.imul(r, 2654435761) >>> 0);
    h = Math.imul((h >>> 16) ^ h, 0x45d9f3b) >>> 0;
    h = ((h >>> 16) ^ h) >>> 0;
    return (h / 0xffffffff) * amp;
}


/* Barnes priority-flood from the world ocean, carve-biased so spill points
 * become canyons instead of filled lake beds. Land stays land: this is
 * drainage, not a new coastline. */
function priorityFloodCarve(mesh, meters, ocean, carveStrength, opts) {
    const n = mesh.numRegions;
    const open = worldOceanMask(mesh, ocean);
    const neighbors = [];
    const eps = opts.floodEpsM;
    const noiseAmp = opts.floodNoiseM;

    const surface = new Float32Array(meters);
    const drainTo = new Int32Array(n).fill(-1);
    const visited = new Uint8Array(n);
    const key = new Float32Array(n);
    for (let r = 0; r < n; r++) key[r] = meters[r] + cellNoise(r, noiseAmp);

    const heap = new MinHeap(key);
    for (let r = 0; r < n; r++) {
        if (ocean[r]) { visited[r] = 1; continue; }
        mesh.r_circulate_r(neighbors, r);
        for (let i = 0; i < neighbors.length; i++) {
            if (open[neighbors[i]]) {
                visited[r] = 1;
                drainTo[r] = neighbors[i];
                heap.push(r);
                break;
            }
        }
    }

    while (heap.size > 0) {
        const r = heap.pop();
        const surfR = surface[r];
        mesh.r_circulate_r(neighbors, r);
        for (let i = 0; i < neighbors.length; i++) {
            const nb = neighbors[i];
            if (visited[nb]) continue;
            visited[nb] = 1;
            drainTo[nb] = r;
            if (meters[nb] < surfR + eps) {
                surface[nb] = surfR + eps;
                key[nb] = surface[nb] + cellNoise(nb, noiseAmp);
            }
            heap.push(nb);
        }
    }

    const path = [];
    for (let r = 0; r < n; r++) {
        if (ocean[r]) continue;
        const deficit = surface[r] - meters[r];
        if (deficit <= eps) continue;

        path.length = 0;
        let peakIdx = -1, peakElev = -Infinity;
        let cur = r;
        while (cur >= 0 && !ocean[cur]) {
            path.push(cur);
            if (meters[cur] > peakElev) {
                peakElev = meters[cur];
                peakIdx = path.length - 1;
            }
            cur = drainTo[cur];
        }
        if (peakIdx < 0 || path.length === 0) continue;

        const carveAmount = deficit * carveStrength;
        const radius = Math.max(3, Math.ceil(path.length * opts.floodCarveRadius));
        const startIdx = Math.max(0, peakIdx - radius);
        const endIdx = Math.min(path.length - 1, peakIdx + radius);
        let kernelSum = 0;
        for (let k = startIdx; k <= endIdx; k++) {
            kernelSum += 1 - Math.abs(k - peakIdx) / (radius + 1);
        }
        if (kernelSum > 0) {
            for (let k = startIdx; k <= endIdx; k++) {
                const weight = (1 - Math.abs(k - peakIdx) / (radius + 1)) / kernelSum;
                meters[path[k]] -= carveAmount * weight;
                if (meters[path[k]] < 0) meters[path[k]] = 0;
            }
        }
        meters[r] += deficit * (1 - carveStrength);
    }

    const order = [];
    for (let r = 0; r < n; r++) if (!ocean[r]) order.push(r);
    order.sort((a, b) => surface[a] - surface[b]);
    for (let i = 0; i < order.length; i++) {
        const r = order[i];
        const target = drainTo[r];
        if (target < 0) continue;
        const targetElev = ocean[target] ? 0 : meters[target];
        if (meters[r] <= targetElev) meters[r] = targetElev + eps;
    }
}


function steepestDown(mesh, meters, r, neighbors) {
    mesh.r_circulate_r(neighbors, r);
    const h = meters[r];
    let best = -1, bestDrop = -Infinity;
    for (let i = 0; i < neighbors.length; i++) {
        const nb = neighbors[i];
        const drop = h - meters[nb];
        if (drop > bestDrop) { bestDrop = drop; best = nb; }
    }
    if (bestDrop > 0) return best;
    let minAscent = Infinity;
    best = -1;
    for (let i = 0; i < neighbors.length; i++) {
        const nb = neighbors[i];
        const ascent = meters[nb] - h;
        if (ascent < minAscent) { minAscent = ascent; best = nb; }
    }
    return best;
}


function smoothstep(x, edge0, edge1) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}


function erodeComposite(mesh, r_xyz, meters, ocean, temperature, opts) {
    const n = mesh.numRegions;
    const hIters = opts.hydraulicIters | 0;
    const tIters = opts.thermalIters | 0;
    const gIters = opts.glacialIters | 0;
    const total = Math.max(hIters, tIters, gIters);
    if (total <= 0) return;

    const land = [];
    for (let r = 0; r < n; r++) if (!ocean[r]) land.push(r);
    if (land.length === 0) return;

    const neighbors = [];
    const drainTo = new Int32Array(n);
    const distKm = new Float32Array(n);
    const flow = new Float32Array(n);
    const delta = new Float32Array(n);
    const areaKm2 = cellAreaKm2(n);

    if (hIters > 0) {
        priorityFloodCarve(mesh, meters, ocean, opts.floodCarve, opts);
    }

    let glacIdx = null, iceTo = null, iceFlow = null, iceUp = null;
    if (gIters > 0 && opts.glacialStrength > 0 && temperature) {
        glacIdx = new Float32Array(n);
        const iceTemp = opts.iceTemp;
        const iceRamp = opts.iceRamp;
        for (let r = 0; r < n; r++) {
            if (ocean[r]) continue;
            glacIdx[r] = smoothstep(temperature[r], iceTemp, iceTemp - iceRamp) * opts.glacialStrength;
        }
        iceTo = new Int32Array(n);
        iceFlow = new Float32Array(n);
        iceUp = new Uint8Array(n);
    }

    const gScale = gIters > 0 ? 1 / gIters : 0;
    const gCarve = opts.glacialCarveM * gScale;
    const gConverge = opts.glacialConvergeM * gScale;
    const gDeposit = opts.glacialDepositM * gScale;
    const gFjord = opts.glacialFjordM * gScale;
    const htIters = Math.max(hIters, tIters);
    const midFloodAt = Math.round(htIters * opts.floodMidFrac);
    let midFloodDone = false;

    for (let iter = 0; iter < htIters; iter++) {
        if (!midFloodDone && iter >= midFloodAt && hIters > 0) {
            midFloodDone = true;
            priorityFloodCarve(mesh, meters, ocean, opts.floodMidCarve, opts);
        }

        const hydraulicNow = iter < hIters;
        if (hydraulicNow) {
            land.sort((a, b) => meters[b] - meters[a]);
        }

        if (hydraulicNow) {
            drainTo.fill(-1);
            for (let i = 0; i < land.length; i++) {
                const r = land[i];
                const t = steepestDown(mesh, meters, r, neighbors);
                if (t < 0) continue;
                drainTo[r] = t;
                distKm[r] = chordKm(r_xyz, r, t);
            }
            flow.fill(0);
            for (let i = 0; i < land.length; i++) flow[land[i]] = areaKm2;
            for (let i = 0; i < land.length; i++) {
                const r = land[i];
                const t = drainTo[r];
                if (t >= 0) flow[t] += flow[r];
            }
            for (let i = land.length - 1; i >= 0; i--) {
                const r = land[i];
                const t = drainTo[r];
                if (t < 0 || distKm[r] <= 0) continue;
                let factor = opts.streamK * Math.pow(flow[r], opts.streamM) * opts.streamDt / distKm[r];
                if (factor > opts.streamCap) factor = opts.streamCap;
                const hRecv = Math.max(meters[t], 0);
                let hNew = (meters[r] + factor * hRecv) / (1 + factor);
                if (hNew < hRecv) hNew = hRecv;
                if (hNew < 0) hNew = 0;
                const eroded = meters[r] - hNew;
                if (eroded > 0 && !ocean[t]) {
                    const tt = drainTo[t];
                    let recvSlope = 0;
                    if (tt >= 0 && distKm[t] > 0) {
                        recvSlope = Math.abs(meters[t] - meters[tt]) / (distKm[t] * 1000);
                    }
                    const depositFrac = opts.depositFrac / (1 + recvSlope * opts.depositSlope);
                    let deposit = eroded * depositFrac;
                    const cap = Math.max(0, hNew - meters[t]);
                    if (deposit > cap) deposit = cap;
                    meters[t] += deposit;
                }
                meters[r] = hNew;
            }
        }

        if (iter < tIters) {
            delta.fill(0);
            const talus = opts.talusSlope;
            const kT = opts.thermalK;
            for (let i = 0; i < land.length; i++) {
                const r = land[i];
                const h = meters[r];
                mesh.r_circulate_r(neighbors, r);
                let totalExcess = 0;
                const excNb = [], excVal = [], excDist = [];
                for (let k = 0; k < neighbors.length; k++) {
                    const nb = neighbors[k];
                    if (ocean[nb]) continue;
                    const nh = meters[nb];
                    if (nh >= h) continue;
                    const d = chordKm(r_xyz, r, nb) * 1000;
                    const slope = (h - nh) / d;
                    if (slope > talus) {
                        const excess = (slope - talus) * d;
                        excNb.push(nb);
                        excVal.push(excess);
                        excDist.push(d);
                        totalExcess += excess;
                    }
                }
                if (totalExcess <= 0) continue;
                let weighted = 0;
                const slopes = new Float32Array(excNb.length);
                for (let k = 0; k < excNb.length; k++) {
                    slopes[k] = (h - meters[excNb[k]]) / excDist[k];
                    weighted += excVal[k] * slopes[k];
                }
                const transfer = kT * totalExcess * opts.thermalShare;
                if (weighted > 0) {
                    for (let k = 0; k < excNb.length; k++) {
                        const share = (excVal[k] * slopes[k] / weighted) * transfer;
                        delta[r] -= share;
                        delta[excNb[k]] += share;
                    }
                } else {
                    for (let k = 0; k < excNb.length; k++) {
                        const share = (excVal[k] / totalExcess) * transfer;
                        delta[r] -= share;
                        delta[excNb[k]] += share;
                    }
                }
            }
            for (let i = 0; i < land.length; i++) meters[land[i]] += delta[land[i]];
            for (let i = 0; i < land.length; i++) {
                if (meters[land[i]] < 0) meters[land[i]] = 0;
            }
        }
    }

    /* Glacial last, so stream-power does not fill the fjords it just cut. */
    if (glacIdx) {
        for (let iter = 0; iter < gIters; iter++) {
            land.sort((a, b) => meters[b] - meters[a]);
            iceTo.fill(-1);
            iceUp.fill(0);
            for (let i = 0; i < land.length; i++) {
                const r = land[i];
                if (glacIdx[r] <= 0) continue;
                iceTo[r] = steepestDown(mesh, meters, r, neighbors);
            }
            for (let r = 0; r < n; r++) iceFlow[r] = glacIdx[r];
            for (let i = 0; i < land.length; i++) {
                const r = land[i];
                const t = iceTo[r];
                if (t >= 0 && iceFlow[r] > 0) {
                    iceFlow[t] += iceFlow[r];
                    iceUp[t]++;
                }
            }
            for (let i = 0; i < land.length; i++) {
                const r = land[i];
                if (iceFlow[r] <= opts.glacialFlowMin) continue;
                const deepening = gCarve * Math.pow(iceFlow[r], 0.6);
                meters[r] -= deepening;
                mesh.r_circulate_r(neighbors, r);
                for (let k = 0; k < neighbors.length; k++) {
                    const nb = neighbors[k];
                    if (ocean[nb]) continue;
                    const d = chordKm(r_xyz, r, nb);
                    const slope = Math.abs(meters[r] - meters[nb]) / Math.max(1, d * 1000);
                    meters[nb] -= deepening * opts.glacialWiden * Math.max(0, 1 - slope);
                }
                if (iceUp[r] >= 2) {
                    meters[r] -= gConverge * Math.pow(iceFlow[r], 0.4);
                }
            }
            for (let i = 0; i < land.length; i++) {
                const r = land[i];
                if (iceFlow[r] <= opts.glacialFlowMin) continue;
                const t = iceTo[r];
                if (t < 0 || ocean[t]) continue;
                if (glacIdx[t] < glacIdx[r] * opts.glacialTerminus) {
                    meters[t] += gDeposit * Math.pow(iceFlow[r], 0.3);
                }
            }
            /* Fjords are allowed to drown the coast. That indent is the
             * feature; hydraulic and flood carving are not. */
            for (let r = 0; r < n; r++) {
                if (ocean[r]) continue;
                if (glacIdx[r] <= opts.glacialFjordIceMin || iceFlow[r] <= opts.glacialFjordMin) continue;
                mesh.r_circulate_r(neighbors, r);
                let coastal = false;
                for (let k = 0; k < neighbors.length; k++) {
                    if (ocean[neighbors[k]]) { coastal = true; break; }
                }
                if (!coastal) continue;
                meters[r] -= gFjord * Math.pow(iceFlow[r], 0.5);
                if (meters[r] < opts.fjordFloorM) meters[r] = opts.fjordFloorM;
            }
            for (let r = 0; r < n; r++) {
                if (!ocean[r] && meters[r] < 0 && glacIdx[r] <= 0) meters[r] = 0;
            }
        }

        const tmp = new Float32Array(meters);
        for (let r = 0; r < n; r++) {
            if (ocean[r] || glacIdx[r] <= 0) continue;
            mesh.r_circulate_r(neighbors, r);
            let sum = 0, count = 0;
            for (let k = 0; k < neighbors.length; k++) {
                if (!ocean[neighbors[k]]) { sum += meters[neighbors[k]]; count++; }
            }
            if (count > 0) {
                tmp[r] = meters[r] + (sum / count - meters[r]) * opts.glacialSmooth;
            }
        }
        for (let r = 0; r < n; r++) {
            if (!ocean[r] && glacIdx[r] > 0) meters[r] = tmp[r];
        }
    }
}


function applySoilCreep(mesh, meters, ocean, iterations, strength) {
    const n = mesh.numRegions;
    const neighbors = [];
    const interior = [];
    for (let r = 0; r < n; r++) {
        if (ocean[r]) continue;
        mesh.r_circulate_r(neighbors, r);
        let coastal = false;
        for (let i = 0; i < neighbors.length; i++) {
            if (ocean[neighbors[i]]) { coastal = true; break; }
        }
        if (!coastal) interior.push(r);
    }
    const tmp = new Float32Array(n);
    for (let iter = 0; iter < iterations; iter++) {
        for (let i = 0; i < interior.length; i++) {
            const r = interior[i];
            mesh.r_circulate_r(neighbors, r);
            let sum = 0, count = 0;
            for (let k = 0; k < neighbors.length; k++) {
                if (!ocean[neighbors[k]]) { sum += meters[neighbors[k]]; count++; }
            }
            tmp[r] = count === 0 ? meters[r] : meters[r] + (sum / count - meters[r]) * strength;
        }
        for (let i = 0; i < interior.length; i++) meters[interior[i]] = tmp[interior[i]];
    }
}


/* Quiet cratons stay subdued; belts and arcs take the grain. Applied in
 * metres, before erosion, so the valleys have something to cut into. */
function applyActivityNoise(mesh, r_xyz, meters, ocean, r_orogeny, r_arc, seed, opts) {
    const n = mesh.numRegions;
    const noise = new SimplexNoise(makeRandFloat(seed ^ 0x51eed));
    const fbm = Tectonics.makeFbm(noise, opts.noiseOctaves, 0.5);
    const freq = opts.noiseFreq;
    for (let r = 0; r < n; r++) {
        if (ocean[r]) continue;
        const oro = r_orogeny ? Math.min(1, Math.max(0, r_orogeny[r])) : 0;
        const arc = r_arc ? Math.min(1, Math.max(0, r_arc[r])) : 0;
        const activity = Math.min(1, oro + 0.35 * arc);
        const amp = opts.noiseBaseM + opts.noiseActivityM * activity;
        if (amp < 1) continue;
        const x = freq * r_xyz[3 * r], y = freq * r_xyz[3 * r + 1], z = freq * r_xyz[3 * r + 2];
        meters[r] += amp * fbm(x, y, z);
        if (meters[r] < 0) meters[r] = 0;
    }
}


function applyErosion(mesh, r_xyz, meters, temperature, r_orogeny, r_arc, seed, opts) {
    const n = mesh.numRegions;
    const ocean = markOcean(meters, n);
    applyActivityNoise(mesh, r_xyz, meters, ocean, r_orogeny, r_arc, seed, opts);
    erodeComposite(mesh, r_xyz, meters, ocean, temperature, opts);
    applySoilCreep(mesh, meters, ocean, opts.creepIters, opts.creepStrength);
    return meters;
}


module.exports = {
    applyErosion,
    applyActivityNoise,
    priorityFloodCarve,
    erodeComposite,
    applySoilCreep,
    markOcean,
};
