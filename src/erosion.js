/*
 * First-stage erosion on the detail mesh.
 *
 * Rough shaping only: every land cell routes downhill, a light incision
 * cuts valley ramps along the drain tree, talus relaxes steep faces, ice
 * carves U-valleys and fjords where the climate says it belongs, and soil
 * creep rounds hillslopes. The drain tree is a sketch product. Real river
 * networks wait for Carve.
 *
 * Inland seas are left alone. The flood seeds from the world ocean, never
 * from a closed basin. Depressions deeper than the lake cap stay lakes.
 *
 * A live ice sheet is not a Norway coast. Fluvial incision and fjord
 * drowning are suppressed there — there is no running water, and the
 * visible edge is an ice shelf, not a drowned glacial valley. Fjords are
 * cut from *paleo* ice (the last-glacial line), so Canada and Scandinavia
 * keep them after the ice has gone.
 */
'use strict';

const SimplexNoise = require('simplex-noise');
const {makeRandFloat} = require('@redblobgames/prng');
const Tectonics = require('./tectonics');
const Route = require('./route');


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


function routeOpts(opts, ocean, protect, editHeight, carve) {
    return Object.assign({}, Route.DEFAULTS, opts, {
        ocean,
        protect,
        editHeight,
        floodCarve: carve != null ? carve : opts.floodCarve,
    });
}


function erodeComposite(mesh, r_xyz, meters, ocean, temperature, moisture, opts) {
    const n = mesh.numRegions;
    const hIters = opts.hydraulicIters | 0;
    const tIters = opts.thermalIters | 0;
    const gIters = opts.glacialIters | 0;
    const total = Math.max(hIters, tIters, gIters);
    if (total <= 0) return null;

    const land = [];
    for (let r = 0; r < n; r++) if (!ocean[r]) land.push(r);
    if (land.length === 0) return null;

    const graph = Route.dualMesh(mesh, r_xyz, opts.radiusKm);
    const neighbors = [];
    const delta = new Float32Array(n);

    let glacIdx = null, paleoIdx = null, iceSheet = null;
    let iceTo = null, iceFlow = null, iceUp = null;
    if (gIters > 0 && opts.glacialStrength > 0 && temperature) {
        glacIdx = new Float32Array(n);
        paleoIdx = new Float32Array(n);
        iceSheet = new Float32Array(n);
        const iceTemp = opts.iceTemp;
        const iceRamp = opts.iceRamp;
        const paleoTemp = opts.paleoIceTemp != null ? opts.paleoIceTemp : iceTemp + 0.32;
        const paleoRamp = opts.paleoIceRamp != null ? opts.paleoIceRamp : iceRamp;
        for (let r = 0; r < n; r++) {
            if (ocean[r]) continue;
            glacIdx[r] = smoothstep(temperature[r], iceTemp, iceTemp - iceRamp) * opts.glacialStrength;
            paleoIdx[r] = smoothstep(temperature[r], paleoTemp, paleoTemp - paleoRamp) * opts.glacialStrength;
            iceSheet[r] = glacIdx[r];
        }
        iceTo = new Int32Array(n);
        iceFlow = new Float32Array(n);
        iceUp = new Uint8Array(n);
    }

    let routing = null;
    if (hIters > 0) {
        routing = Route.route(graph, meters, moisture, routeOpts(opts, ocean, iceSheet, true, opts.floodCarve));
        Route.incise(graph, meters, routing, Object.assign({}, opts, {protect: iceSheet}));
    }

    const gScale = gIters > 0 ? 1 / gIters : 0;
    const gCarve = opts.glacialCarveM * gScale;
    const gConverge = opts.glacialConvergeM * gScale;
    const gDeposit = opts.glacialDepositM * gScale;
    const gFjord = opts.glacialFjordM * gScale;
    const midFloodAt = Math.max(1, Math.round(tIters * opts.floodMidFrac));
    let midFloodDone = false;

    for (let iter = 0; iter < tIters; iter++) {
        if (!midFloodDone && iter >= midFloodAt && hIters > 0) {
            midFloodDone = true;
            routing = Route.route(graph, meters, moisture, routeOpts(opts, ocean, iceSheet, true, opts.floodMidCarve));
            Route.incise(graph, meters, routing, Object.assign({}, opts, {protect: iceSheet}));
        }

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
                const d = Route.chordKm(r_xyz, r, nb, opts.radiusKm) * 1000;
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

    /* Glacial last, so stream-power does not fill the fjords it just cut.
     * Route paleo ice so Canada and Norway still cut after the ice
     * retreated; scale the cut down on a live ice sheet so Antarctica
     * stays a dome. */
    if (paleoIdx) {
        const sheetCarve = opts.iceSheetCarveScale != null ? opts.iceSheetCarveScale : 0.12;
        const sheetFjord = opts.iceSheetFjordScale != null ? opts.iceSheetFjordScale : 0.10;
        const lat0 = Math.sin((opts.iceSheetFjordLat0 != null ? opts.iceSheetFjordLat0 : 65) * Math.PI / 180);
        const lat1 = Math.sin((opts.iceSheetFjordLat1 != null ? opts.iceSheetFjordLat1 : 73) * Math.PI / 180);
        const flowCap = opts.glacialFlowCap != null ? opts.glacialFlowCap : 6;
        const flowAt = (r) => iceFlow[r] < flowCap ? iceFlow[r] : flowCap;
        for (let iter = 0; iter < gIters; iter++) {
            land.sort((a, b) => meters[b] - meters[a]);
            iceTo.fill(-1);
            iceUp.fill(0);
            for (let i = 0; i < land.length; i++) {
                const r = land[i];
                if (paleoIdx[r] <= 0) continue;
                iceTo[r] = steepestDown(mesh, meters, r, neighbors);
            }
            for (let r = 0; r < n; r++) iceFlow[r] = paleoIdx[r];
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
                const sheet = iceSheet ? iceSheet[r] : 0;
                const latGate = smoothstep(Math.abs(r_xyz[3 * r + 2]), lat0, lat1);
                const protect = Math.max(sheet, latGate);
                const scale = 1 - protect * (1 - sheetCarve);
                const deepening = gCarve * scale * Math.pow(flowAt(r), 0.6);
                meters[r] -= deepening;
                mesh.r_circulate_r(neighbors, r);
                for (let k = 0; k < neighbors.length; k++) {
                    const nb = neighbors[k];
                    if (ocean[nb]) continue;
                    const d = Route.chordKm(r_xyz, r, nb, opts.radiusKm);
                    const slope = Math.abs(meters[r] - meters[nb]) / Math.max(1, d * 1000);
                    meters[nb] -= deepening * opts.glacialWiden * Math.max(0, 1 - slope);
                }
                if (iceUp[r] >= 2) {
                    meters[r] -= gConverge * scale * Math.pow(flowAt(r), 0.4);
                }
            }
            for (let i = 0; i < land.length; i++) {
                const r = land[i];
                if (iceFlow[r] <= opts.glacialFlowMin) continue;
                const t = iceTo[r];
                if (t < 0 || ocean[t]) continue;
                if (paleoIdx[t] < paleoIdx[r] * opts.glacialTerminus) {
                    meters[t] += gDeposit * Math.pow(flowAt(r), 0.3);
                }
            }
            /* Fjords are allowed to drown the coast. That indent is the
             * feature; hydraulic and flood carving are not. A live ice
             * sheet does not get them: its coast is an ice shelf. Polar
             * coasts past ~65° are ice-sheet even when the temperature
             * at the waterline is a shade above iceTemp. */
            for (let r = 0; r < n; r++) {
                if (ocean[r]) continue;
                const sheet = iceSheet ? iceSheet[r] : 0;
                const latGate = smoothstep(Math.abs(r_xyz[3 * r + 2]), lat0, lat1);
                const protect = Math.max(sheet, latGate);
                const fjordIce = paleoIdx[r] * (1 - protect * (1 - sheetFjord));
                if (fjordIce <= opts.glacialFjordIceMin || iceFlow[r] <= opts.glacialFjordMin) continue;
                mesh.r_circulate_r(neighbors, r);
                let coastal = false;
                for (let k = 0; k < neighbors.length; k++) {
                    if (ocean[neighbors[k]]) { coastal = true; break; }
                }
                if (!coastal) continue;
                meters[r] -= gFjord * (1 - protect * (1 - sheetFjord)) * Math.pow(flowAt(r), 0.5);
                if (meters[r] < opts.fjordFloorM) meters[r] = opts.fjordFloorM;
            }
            for (let r = 0; r < n; r++) {
                if (!ocean[r] && meters[r] < 0 && paleoIdx[r] <= 0) meters[r] = 0;
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

    if (hIters > 0) {
        routing = Route.route(graph, meters, moisture, routeOpts(opts, ocean, iceSheet, false));
    }
    return routing;
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


function applyErosion(mesh, r_xyz, meters, temperature, moisture, r_orogeny, r_arc, seed, opts) {
    const n = mesh.numRegions;
    const ocean = Route.markOcean(meters, n);
    applyActivityNoise(mesh, r_xyz, meters, ocean, r_orogeny, r_arc, seed, opts);
    const routing = erodeComposite(mesh, r_xyz, meters, ocean, temperature, moisture, opts);
    applySoilCreep(mesh, meters, ocean, opts.creepIters, opts.creepStrength);
    if (!routing) return routing;
    const graph = Route.dualMesh(mesh, r_xyz, opts.radiusKm);
    return Route.route(graph, meters, moisture, routeOpts(opts, ocean, null, false));
}


module.exports = {
    applyErosion,
    applyActivityNoise,
    erodeComposite,
    applySoilCreep,
};
