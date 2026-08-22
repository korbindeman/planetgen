/*
 * Climate for the planet generator.
 *
 * Like tectonics.js this is free of WebGL and DOM, so it can be run and
 * measured headlessly (see scripts/climate-stats.mjs).
 *
 * Moisture used to be a function of latitude times a distance-to-ocean
 * falloff. That cannot produce the thing that most distinguishes Earth's
 * climate map from a set of stripes: the subtropical dry belt is not a
 * clean girdle. The Sahara and the Namib are dry while Florida and
 * south-east China, at the same latitude, are wet.
 *
 * The difference is which way the wind blows. So instead of painting
 * moisture on by latitude, carry it: air picks up water over the ocean,
 * travels downwind, rains some out at every step, and arrives inland
 * already depleted. Latitude then only sets how readily air rains out —
 * the Hadley circulation — rather than how much water is there.
 *
 * That single change produces the asymmetry for nothing. In the trade-wind
 * belt the wind is easterly, so a continent's east coast gets fresh
 * maritime air and its west coast gets air that has already crossed the
 * land; under the westerlies it is the other way round. Rain shadows
 * behind mountains come out of the same mechanism.
 */
'use strict';

const SimplexNoise = require('simplex-noise');
const {makeRandFloat} = require('@redblobgames/prng');

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

const DEFAULTS = {
    /* How readily air rains out, by latitude: the Hadley cells. */
    itczStrength: 0.55,           // equatorial convergence
    itczWidth: 12,                // degrees
    stormStrength: 0.40,          // mid-latitude storm track
    stormCentre: 52,
    stormWidth: 18,
    subsidenceStrength: 0.34,     // subtropical high, suppresses rain
    subsidenceCentre: 26,
    subsidenceWidth: 11,
    rainBase: 0.45,

    orographicGain: 2.6,          // extra rainout per unit of upwind elevation gain
    rainEfficiency: 0.14,         // share of the passing air that rains out per cell;
                                  // at ~226 km per cell this empties a parcel over a
                                  // continent's width rather than in a few steps
    recycling: 0.64,              // share of rain that the land returns to the passing
                                  // air; without it every interior is a desert, because
                                  // about half the Amazon's rain is water the forest
                                  // itself evaporated back. Raised when continents became
                                  // solid masses rather than strings: air now crosses far
                                  // more land before it reaches an interior
    evaporation: 0.55,            // ocean humidity at freezing
    evaporationWarm: 0.60,        // extra ocean humidity when warm
    moistureGain: 1.62,           // maps delivered rain onto the 0..1 biome axis

    seasonShift: 12,              // degrees the rain belt moves with the sun
    windSeasonShift: 3,           // how far the wind bands themselves move. Less than
                                  // the rain belt: Earth's ITCZ swings much further
                                  // than the trades do, and shifting the wind bands
                                  // the full amount averages a cell over both trade
                                  // and westerly regimes, cancelling the asymmetry
    seasonBias: 0.62,             // how much the wetter season counts for
    windTilt: 0.35,               // meridional lean of the prevailing winds
    iterations: 90,               // advection sweeps; the flow is a directed graph
    smoothing: 1,

    lapse: 0.55,                  // temperature lost per unit of elevation
    temperatureNoise: 0.1,
};


/* Three cells per hemisphere, as on Earth: easterly trades to 30 degrees,
 * westerlies to 60, polar easterlies beyond. Returns the direction the wind
 * blows *towards*, as a unit tangent vector.
 *
 * The winds also lean meridionally — trades blow equatorward, westerlies
 * poleward — which is what stops a purely zonal flow from circling a
 * latitude line forever without ever crossing a coast. */
function windAt(out, px, py, pz, effLatDeg, opts) {
    const sinLat = Math.max(-1, Math.min(1, pz));
    const deg = Math.abs(effLatDeg);

    /* eastward tangent */
    let ex = -py, ey = px;
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) { out[0] = out[1] = out[2] = 0; return out; }
    ex /= len; ey /= len;

    const westerly = deg >= 30 && deg < 60;
    const zonal = westerly ? 1 : -1;              // +1 blows east, -1 blows west
    const poleward = westerly ? 1 : -1;           // westerlies lean poleward
    const hemisphere = effLatDeg >= 0 ? 1 : -1;

    /* northward tangent at this point */
    const cosLat = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));
    const nx = -sinLat * (px / Math.max(1e-9, cosLat));
    const ny = -sinLat * (py / Math.max(1e-9, cosLat));
    const nz = cosLat;

    const tilt = opts.windTilt * poleward * hemisphere;
    out[0] = zonal * ex + tilt * nx;
    out[1] = zonal * ey + tilt * ny;
    out[2] = tilt * nz;
    const m = Math.hypot(out[0], out[1], out[2]);
    if (m > 1e-9) { out[0] /= m; out[1] /= m; out[2] /= m; }
    return out;
}


/* How readily air rains out here, before any orographic help. */
function rainAptitude(deg, opts) {
    const itcz = Math.exp(-((deg / opts.itczWidth) ** 2));
    const storm = Math.exp(-(((deg - opts.stormCentre) / opts.stormWidth) ** 2));
    const subsidence = Math.exp(-(((deg - opts.subsidenceCentre) / opts.subsidenceWidth) ** 2));
    return opts.rainBase
        + opts.itczStrength * itcz
        + opts.stormStrength * storm
        - opts.subsidenceStrength * subsidence;
}


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


/* Weights describing where the air arriving at each cell came from.
 * A neighbour counts as upwind in proportion to how well the step from it
 * to us lines up with the wind. */
function buildUpwindGraph(mesh, r_xyz, shiftDeg, opts) {
    const {numRegions} = mesh;
    const out_r = [];

    let total = 0;
    for (let r = 0; r < numRegions; r++) total += mesh.r_circulate_r(out_r, r).length;

    const start = new Int32Array(numRegions + 1);
    const source = new Int32Array(total);
    const weight = new Float32Array(total);

    const wind = [0, 0, 0], step = [0, 0, 0];
    let cursor = 0;
    for (let r = 0; r < numRegions; r++) {
        start[r] = cursor;
        const px = r_xyz[3 * r], py = r_xyz[3 * r + 1], pz = r_xyz[3 * r + 2];
        const lat = Math.asin(Math.max(-1, Math.min(1, pz))) * 180 / Math.PI;
        windAt(wind, px, py, pz, lat - shiftDeg, opts);

        mesh.r_circulate_r(out_r, r);
        let sum = 0;
        const first = cursor;
        for (const n of out_r) {
            step[0] = px - r_xyz[3 * n];
            step[1] = py - r_xyz[3 * n + 1];
            step[2] = pz - r_xyz[3 * n + 2];
            /* keep only the part along the surface at this point */
            const radial = step[0] * px + step[1] * py + step[2] * pz;
            step[0] -= radial * px; step[1] -= radial * py; step[2] -= radial * pz;
            const len = Math.hypot(step[0], step[1], step[2]);
            let w = 0;
            if (len > 1e-12) {
                w = (step[0] * wind[0] + step[1] * wind[1] + step[2] * wind[2]) / len;
                if (w < 0) w = 0;
            }
            source[cursor] = n;
            weight[cursor] = w;
            sum += w;
            cursor++;
        }
        if (sum > 1e-9) {
            for (let i = first; i < cursor; i++) weight[i] /= sum;
        }
    }
    start[numRegions] = cursor;
    return {start, source, weight};
}


function assignClimate(mesh, {r_xyz, r_elevation, r_moisture, r_temperature}, seed, options) {
    const opts = Object.assign({}, DEFAULTS, options);
    const noise = new SimplexNoise(makeRandFloat(seed || 1));
    const {numRegions} = mesh;

    const moisture = r_moisture || new Float32Array(numRegions);
    const temperature = r_temperature || new Float32Array(numRegions);

    /* Temperature first: evaporation and rain both depend on it. */
    const isOcean = new Uint8Array(numRegions);
    const latDeg = new Float32Array(numRegions);
    for (let r = 0; r < numRegions; r++) {
        const pz = Math.max(-1, Math.min(1, r_xyz[3 * r + 2]));
        const lat = Math.asin(pz);
        latDeg[r] = lat * 180 / Math.PI;
        temperature[r] = Math.cos(lat) - opts.lapse * Math.max(0, r_elevation[r])
            + opts.temperatureNoise * noise.noise3D(r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2]);
        if (r_elevation[r] < 0) isOcean[r] = 1;
    }

    /* Solve one season: the whole three-cell circulation sits `shiftDeg` off
     * the equator, as it does when it follows the sun. */
    const solveSeason = (shiftDeg) => {
        const windShift = shiftDeg * (opts.windSeasonShift / Math.max(1e-6, opts.seasonShift));
        const {start, source, weight} = buildUpwindGraph(mesh, r_xyz, windShift, opts);

        const aptitude = new Float32Array(numRegions);
        const rainFraction = new Float32Array(numRegions);
        for (let r = 0; r < numRegions; r++) {
            /* Sea counts as zero, not as its depth: air coming ashore over
             * flat ground is not being lifted over a four-kilometre step. */
            const here = Math.max(0, r_elevation[r]);
            let elev = 0;
            for (let i = start[r]; i < start[r + 1]; i++) {
                elev += weight[i] * Math.max(0, r_elevation[source[i]]);
            }
            /* Air forced up over ground rains; air descending the lee side
             * does not, which is what puts a desert behind a range. */
            const lift = Math.max(0, here - elev);
            aptitude[r] = clamp01(rainAptitude(Math.abs(latDeg[r] - shiftDeg), opts)
                + opts.orographicGain * lift);
            rainFraction[r] = clamp01(opts.rainEfficiency * aptitude[r]);
        }

        /* Warm seas give up more water than cold ones, which is why the
         * tropics feed the wet belts and the polar oceans do not. */
        const humidity = new Float32Array(numRegions);
        for (let r = 0; r < numRegions; r++) {
            if (isOcean[r]) humidity[r] = opts.evaporation + opts.evaporationWarm * clamp01(temperature[r]);
        }

        /* Relax the flow. Ocean cells are sources held at their evaporation
         * value; land cells take what arrives, rain some of it out, and pass
         * the rest on. Rainout damps the loop that a zonal wind would
         * otherwise make around a latitude line, so this converges. */
        const incoming = new Float32Array(numRegions);
        for (let iter = 0; iter < opts.iterations; iter++) {
            for (let r = 0; r < numRegions; r++) {
                let arrived = 0;
                for (let i = start[r]; i < start[r + 1]; i++) arrived += weight[i] * humidity[source[i]];
                incoming[r] = arrived;
                if (isOcean[r]) continue;                // held at its evaporation value
                /* Some of what falls goes straight back up. Warm wet ground
                 * returns a lot and keeps the air moist far inland; a cold or
                 * already-dry place returns little. That asymmetry is why an
                 * equatorial interior can be rainforest while a subtropical
                 * one at the same distance from the sea is desert. */
                const returned = opts.recycling * clamp01(temperature[r]);
                humidity[r] = arrived * (1 - rainFraction[r] * (1 - returned));
            }
        }

        /* What actually falls is the water that arrived times how readily
         * this place rains it out. Coastal deserts come from the second
         * factor being low even though the first is high; continental
         * interiors from the first being low even where the second is not. */
        const season = new Float32Array(numRegions);
        for (let r = 0; r < numRegions; r++) {
            season[r] = isOcean[r] ? 1 : clamp01(opts.moistureGain * incoming[r] * aptitude[r]);
        }
        return season;
    };

    /* Average the two solstices rather than solving one static circulation.
     * This is what a monsoon is: a continental interior that the wind reaches
     * from the sea in one season and not the other still gets its rain, so
     * big landmasses are not uniformly desert the way a single fixed wind
     * field makes them. */
    const summer = solveSeason(opts.seasonShift);
    const winter = solveSeason(-opts.seasonShift);
    for (let r = 0; r < numRegions; r++) {
        /* Weighted towards the wetter season: a place that is soaked for half
         * the year is not half a desert. */
        const wet = Math.max(summer[r], winter[r]);
        const dry = Math.min(summer[r], winter[r]);
        moisture[r] = clamp01(opts.seasonBias * wet + (1 - opts.seasonBias) * dry);
    }
    smoothField(mesh, moisture, null, opts.smoothing);

    return {r_moisture: moisture, r_temperature: temperature};
}


module.exports = {
    DEFAULTS,
    assignClimate,
    windAt,
    rainAptitude,
    clamp01,
    smoothField,
};
