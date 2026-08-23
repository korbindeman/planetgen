/*
 * Shared look. Both renderers consume this; neither should own colours.
 *
 * Ocean and biome tables live in colormap.js (the texture both sample).
 * This file is everything painted on top: ice, rock, lighting, overlay
 * palettes, annotation ink, and the TD-export hypsometric ramps.
 *
 * The JS surfaceAlbedo and the GLSL string are built from the same
 * constants. Change a number here, not in a renderer.
 */
'use strict';

const colormap = require('./colormap');
const Climate = require('./climate');
const Tectonics = require('./tectonics');

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function lerp3(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function smoothstep(edge0, edge1, x) {
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function glNum(x) {
    const rounded = Math.round(Number(x) * 1e6) / 1e6;
    const s = rounded.toString();
    return /[.eE]/.test(s) ? s : s + '.0';
}

function glVec3(rgb) {
    return `vec3(${glNum(rgb[0])}, ${glNum(rgb[1])}, ${glNum(rgb[2])})`;
}

function rgbHex(c) {
    return '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');
}

/* --- ice, snow, rock ------------------------------------------------ */

const LAND_ICE = 0.28;
const SEA_ICE = 0.18;
/* A cool white. The colormap's snow sample carries a warm cast that made
   Antarctica read as sand at map scale. */
const SNOW_RGB = [0.93, 0.95, 0.97];
const ROCK_RGB = [0.45, 0.40, 0.34];
const LAPSE = Climate.DEFAULTS.lapse;

const SURFACE = {
    landIce: LAND_ICE,
    seaIce: SEA_ICE,
    snow: SNOW_RGB,
    rock: ROCK_RGB,
    lapse: LAPSE,
    orographic: 0.5,
    biomeU0: 0.51,
    biomeUSpan: 0.48,
    alpineLo: 0.28,
    alpineHi: 0.72,
    rockMixBase: 0.4,
    rockMixTemp: 0.45,
    seaIceWarm: 0.06,
    seaIceCold: 0.08,
    sheetWarm: 0.06,
    sheetCold: 0.04,
    iceBand: 0.07,
    snowMix: 0.45,
    polarWarm: 0.45,
    polarCold: 0.28,
    capBase: 0.55,
    capPolar: 0.45,
    iceMixBase: 0.45,
    iceMixPolar: 0.55,
};

/* --- lighting ------------------------------------------------------- */

const LIGHT = {
    azimuth: Math.PI / 3,
    d: 60,
    invTex: 1 / 2048,
    c: 0.15,
    slope: 6,
    flat: 2.5,
};

const LIGHT_X = Math.cos(LIGHT.azimuth);
const LIGHT_Y = Math.sin(LIGHT.azimuth);

const globeLightUniforms = {
    u_light_angle: [LIGHT_X, LIGHT_Y],
    u_inverse_texture_size: LIGHT.invTex,
    u_d: LIGHT.d,
    u_c: LIGHT.c,
    u_slope: LIGHT.slope,
    u_flat: LIGHT.flat,
};

/* --- overlay palettes (used by planet.js) --------------------------- */

const PLATE = {
    hueStep: 0.618033988749895,
    land: {s: 0.58, v: 0.94},
    ocean: {s: 0.50, v: 0.48},
};

const CRUST = {
    ridge: [1.0, 0.35, 0.2],
    trench: [0.25, 0.9, 1.0],
    transform: [1.0, 0.95, 0.35],
    continent: {base: [0.35, 0.5, 0.3], relief: [0.6, -0.18, -0.1]},
    ocean: {base: [0.05, 0.15, 0.3], young: [0.15, 0.45, 0.6]},
    ageMyr: 200,
    orogenyW: 0.7,
    arcW: 0.3,
};

const CLIMATE_OCEAN = [0.13, 0.15, 0.2];
const CLIMATE_STOPS = [
    [0.00, [0.85, 0.72, 0.42]],
    [0.35, [0.76, 0.70, 0.34]],
    [0.55, [0.55, 0.68, 0.30]],
    [0.75, [0.24, 0.56, 0.28]],
    [1.00, [0.05, 0.32, 0.45]],
];

const OVERLAY_LEGEND = {
    plates: 'color = plate   dark = underwater   arrow = motion   age = time since the plate formed',
    crust: 'sea floor: pale = young, dark = old   land: red = orogeny   orange = ridge   cyan = trench   yellow = transform',
    climate: 'moisture only: sand = arid   olive = steppe   green = forest   teal = saturated',
};

/* --- annotation / chrome -------------------------------------------- */

const BOUNDARY_INK = [0.06, 0.06, 0.08, 1];

const PLATE_ARROW = {
    scale: 0.38,
    referenceOmega: 0.006,
    rgb: [255, 225, 74],
    hex: '#ffe14a',
    halo: [17, 17, 17],
    haloHex: '#111111',
    label: [255, 255, 255],
    labelHex: '#ffffff',
};

const NORTH_POLE = {
    rgb: [0.89, 0.18, 0.14],
    alpha: 1,
    fadeAlpha: 0.2,
    stem0: 0.78,
    stem1: 1.18,
    base: 1.04,
    arm: 0.05,
    ringLatDeg: 78,
    ringSteps: 48,
};

const CROP_COLORS = [
    [245, 217, 10],
    [255, 90, 54],
    [90, 210, 255],
];
const CROP_COLORS_HEX = CROP_COLORS.map(rgbHex);

const TD_HILLSHADE = {
    zenithDeg: 45,
    azimuthDeg: 315,
    cell: 220,
    min: 0.15,
};

/* --- colormap sample + albedo --------------------------------------- */

const CM_W = colormap.width;
const CM_H = colormap.height;
const CM = colormap.data;

function sampleColormap(u, v) {
    const x = Math.max(0, Math.min(CM_W - 1, Math.floor(u * CM_W)));
    const y = Math.max(0, Math.min(CM_H - 1, Math.floor(v * CM_H)));
    const p = (y * CM_W + x) * 4;
    return [CM[p] / 255, CM[p + 1] / 255, CM[p + 2] / 255];
}

function mix3(a, b, t) {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ];
}

function surfaceAlbedo(e, m, temp) {
    const S = SURFACE;
    m = clamp01(m);
    if (e < 0) {
        const ocean = sampleColormap(0.5 * (e + 1), m);
        const ice = smoothstep(S.seaIce + S.seaIceWarm, S.seaIce - S.seaIceCold, temp);
        return mix3(ocean, S.snow, ice);
    }
    const t = clamp01(temp);
    const elev = clamp01(e);
    const moisture = m * (1 - S.orographic * elev);
    const biome = sampleColormap(S.biomeU0 + S.biomeUSpan * t, moisture);
    const alpine = smoothstep(S.alpineLo, S.alpineHi, elev);
    const rockMix = alpine * (S.rockMixBase + S.rockMixTemp * t);
    const rock = mix3(biome, S.rock, rockMix);
    /* Cold at sea level is an ice sheet and paints solid white; cold only
       because of altitude is alpine snow and ice, which streak over rock
       the way the real Andes and Alaska do. However cold and high a
       mountain block gets, its whitening is capped so rock always shows —
       stacking snow and ice mixes was what turned every cold range into a
       flat white blob. */
    const seaLevelTemp = temp + S.lapse * elev;
    const sheet = smoothstep(S.landIce + S.sheetWarm, S.landIce - S.sheetCold, seaLevelTemp);
    const iceRaw = smoothstep(S.landIce + S.iceBand, S.landIce - S.iceBand, temp);
    const snowMix = alpine * (1 - t) * S.snowMix;
    /* How much white a cold surface may reach scales with how polar the
       lowlands are: a subpolar Greenland fringe ices harder than a cold
       Andean crest at 50°S, which stays streaked rock however high. */
    const polar = smoothstep(S.polarWarm, S.polarCold, seaLevelTemp);
    const cap = S.capBase + S.capPolar * polar;
    const alpineWhite = Math.min(cap,
        snowMix + iceRaw * (S.iceMixBase + S.iceMixPolar * polar) * (1 - snowMix));
    return mix3(rock, S.snow, Math.max(sheet, alpineWhite));
}

const SURFACE_GLSL = (() => {
    const S = SURFACE;
    return `
vec3 surfaceAlbedo(sampler2D colormap, vec3 tm) {
  float e = tm.x;
  float m = clamp(tm.y, 0.0, 1.0);
  float temp = tm.z;
  vec3 snow = ${glVec3(S.snow)};
  if (e < 0.0) {
    vec3 ocean = texture2D(colormap, vec2(0.5 * (e + 1.0), m)).rgb;
    float ice = smoothstep(${glNum(S.seaIce + S.seaIceWarm)}, ${glNum(S.seaIce - S.seaIceCold)}, temp);
    return mix(ocean, snow, ice);
  }
  float t = clamp(temp, 0.0, 1.0);
  float elev = clamp(e, 0.0, 1.0);
  float moisture = m * (1.0 - ${glNum(S.orographic)} * elev);
  vec3 biome = texture2D(colormap, vec2(${glNum(S.biomeU0)} + ${glNum(S.biomeUSpan)} * t, moisture)).rgb;
  vec3 rock = ${glVec3(S.rock)};
  float alpine = smoothstep(${glNum(S.alpineLo)}, ${glNum(S.alpineHi)}, elev);
  biome = mix(biome, rock, alpine * (${glNum(S.rockMixBase)} + ${glNum(S.rockMixTemp)} * t));
  float seaLevelTemp = temp + ${glNum(S.lapse)} * elev;
  float sheet = smoothstep(${glNum(S.landIce + S.sheetWarm)}, ${glNum(S.landIce - S.sheetCold)}, seaLevelTemp);
  float iceRaw = smoothstep(${glNum(S.landIce + S.iceBand)}, ${glNum(S.landIce - S.iceBand)}, temp);
  float snowMix = alpine * (1.0 - t) * ${glNum(S.snowMix)};
  float polar = smoothstep(${glNum(S.polarWarm)}, ${glNum(S.polarCold)}, seaLevelTemp);
  float cap = ${glNum(S.capBase)} + ${glNum(S.capPolar)} * polar;
  float alpineWhite = min(cap, snowMix + iceRaw * (${glNum(S.iceMixBase)} + ${glNum(S.iceMixPolar)} * polar) * (1.0 - snowMix));
  float white = max(sheet, alpineWhite);
  return mix(biome, snow, white);
}
`;
})();

function hillshade(dedx, dedy) {
    const k = LIGHT.d * 2 * LIGHT.invTex;
    const slx = dedy, sly = dedx, slz = k;
    const slLen = Math.hypot(slx, sly, slz) || 1;
    const sx = slx / slLen, sy = sly / slLen, sz = slz / slLen;
    const lz = LIGHT.slope + (LIGHT.flat - LIGHT.slope) * sz;
    const lLen = Math.hypot(LIGHT_X, LIGHT_Y, lz) || 1;
    const lx = LIGHT_X / lLen, ly = LIGHT_Y / lLen, lzN = lz / lLen;
    return LIGHT.c + Math.max(0, lx * sx + ly * sy + lzN * sz);
}

function northPoleLines() {
    const rgb = NORTH_POLE.rgb;
    const red = [rgb[0], rgb[1], rgb[2], NORTH_POLE.alpha];
    const redFade = [rgb[0], rgb[1], rgb[2], NORTH_POLE.fadeAlpha];
    const {stem0, stem1, base, arm, ringLatDeg, ringSteps} = NORTH_POLE;
    const lines = [
        {a: [0, 0, stem0], b: [0, 0, stem1], ca: redFade, cb: red},
    ];
    const arms = [[arm, 0, base], [-arm, 0, base], [0, arm, base], [0, -arm, base]];
    for (const p of arms) lines.push({a: [0, 0, stem1], b: p, ca: red, cb: red});
    const lat = ringLatDeg * Math.PI / 180;
    const ringZ = Math.sin(lat), ringR = Math.cos(lat);
    for (let i = 0; i < ringSteps; i++) {
        const a0 = (i / ringSteps) * Math.PI * 2;
        const a1 = ((i + 1) / ringSteps) * Math.PI * 2;
        lines.push({
            a: [ringR * Math.cos(a0), ringR * Math.sin(a0), ringZ],
            b: [ringR * Math.cos(a1), ringR * Math.sin(a1), ringZ],
            ca: red, cb: red,
        });
    }
    return lines;
}

/* --- TD-export ramps (not the globe) -------------------------------- */

function elevRgb(m) {
    if (m < 0) {
        const t = Math.min(1, -m / Tectonics.OCEAN_DEPTH_M);
        return lerp3([72, 130, 176], [12, 28, 58], t);
    }
    const t = Math.min(1, m / Tectonics.LAND_PEAK_M);
    if (t < 0.35) return lerp3([92, 148, 78], [196, 196, 118], t / 0.35);
    if (t < 0.7) return lerp3([196, 196, 118], [142, 104, 64], (t - 0.35) / 0.35);
    return lerp3([142, 104, 64], [244, 244, 248], (t - 0.7) / 0.3);
}

function tempRgb(c) {
    const t = clamp01((c + 20) / 50);
    if (t < 0.5) return lerp3([40, 70, 170], [240, 240, 240], t / 0.5);
    return lerp3([240, 240, 240], [190, 40, 30], (t - 0.5) / 0.5);
}

function precipRgb(mm) {
    const t = clamp01(Math.sqrt(mm / 3200));
    if (t < 0.5) return lerp3([214, 196, 150], [120, 168, 92], t / 0.5);
    return lerp3([120, 168, 92], [28, 92, 150], (t - 0.5) / 0.5);
}

function hillshadeField(elev, width, height) {
    const out = new Float32Array(width * height);
    const zenith = TD_HILLSHADE.zenithDeg * Math.PI / 180;
    const azimuth = TD_HILLSHADE.azimuthDeg * Math.PI / 180;
    const zcos = Math.cos(zenith), zsin = Math.sin(zenith);
    const cell = TD_HILLSHADE.cell;
    for (let y = 0; y < height; y++) {
        const y0 = y === 0 ? y : y - 1;
        const y1 = y === height - 1 ? y : y + 1;
        for (let x = 0; x < width; x++) {
            const x0 = x === 0 ? x : x - 1;
            const x1 = x === width - 1 ? x : x + 1;
            const dzdx = (elev[y * width + x1] - elev[y * width + x0]) / (2 * cell);
            const dzdy = (elev[y1 * width + x] - elev[y0 * width + x]) / (2 * cell);
            const slope = Math.atan(Math.hypot(dzdx, dzdy));
            const aspect = Math.atan2(-dzdy, dzdx);
            const shade = zcos * Math.cos(slope) + zsin * Math.sin(slope) * Math.cos(azimuth - aspect);
            out[y * width + x] = Math.max(TD_HILLSHADE.min, Math.min(1, shade));
        }
    }
    return out;
}

module.exports = {
    LAND_ICE,
    SEA_ICE,
    SNOW_RGB,
    ROCK_RGB,
    LAPSE,
    SURFACE,
    LIGHT,
    globeLightUniforms,
    PLATE,
    CRUST,
    CLIMATE_OCEAN,
    CLIMATE_STOPS,
    OVERLAY_LEGEND,
    BOUNDARY_INK,
    PLATE_ARROW,
    NORTH_POLE,
    CROP_COLORS,
    CROP_COLORS_HEX,
    sampleColormap,
    surfaceAlbedo,
    SURFACE_GLSL,
    hillshade,
    northPoleLines,
    elevRgb,
    tempRgb,
    precipRgb,
    hillshadeField,
};
