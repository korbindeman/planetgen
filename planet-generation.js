/*
 * From https://www.redblobgames.com/x/1843-planet-generation/
 * Copyright 2018 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Adapting mapgen4 code for a sphere. Quick & dirty, for procjam2018
 */

function seedFromUrl() {
    try {
        const q = new URLSearchParams(location.search).get('seed');
        if (q == null || q === '') return 88;
        const n = Number(q);
        return Number.isFinite(n) ? (n | 0) : 88;
    } catch (_) {
        return 88;
    }
}
let seed = seedFromUrl();
const LAND_ICE = 0.28;
const SEA_ICE = 0.18;

const SimplexNoise = require('simplex-noise');
const colormap = require('./colormap');
const {vec3, vec4, mat4, quat} = require('gl-matrix');
const {makeRandInt, makeRandFloat} = require('@redblobgames/prng');
const SphereMesh = require('./sphere-mesh');
const Tectonics = require('./tectonics');
const Climate = require('./climate');
const {BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM} = Tectonics;

const regl = require('regl')({
    canvas: "#output",
    extensions: ['OES_element_index_uint', 'OES_standard_derivatives']
});

const u_colormap = regl.texture({
    width: colormap.width,
    height: colormap.height,
    data: colormap.data,
    wrapS: 'clamp',
    wrapT: 'clamp'
});

const SURFACE_GLSL = `
vec3 surfaceAlbedo(sampler2D colormap, vec3 tm, float seaIce, float landIce) {
  float e = tm.x;
  float m = clamp(tm.y, 0.0, 1.0);
  float temp = tm.z;
  vec3 snow = texture2D(colormap, vec2(0.51, 0.92)).rgb;
  if (e < 0.0) {
    vec3 ocean = texture2D(colormap, vec2(0.5 * (e + 1.0), m)).rgb;
    float ice = smoothstep(seaIce + 0.06, seaIce - 0.08, temp);
    return mix(ocean, snow, ice);
  }
  float t = clamp(temp, 0.0, 1.0);
  float elev = clamp(e, 0.0, 1.0);
  float moisture = m * (1.0 - 0.5 * elev);
  vec3 biome = texture2D(colormap, vec2(0.51 + 0.48 * t, moisture)).rgb;
  vec3 rock = vec3(0.45, 0.40, 0.34);
  float alpine = smoothstep(0.28, 0.72, elev);
  biome = mix(biome, rock, alpine * (0.4 + 0.45 * t));
  biome = mix(biome, snow, alpine * (1.0 - t) * 0.65);
  float ice = smoothstep(landIce + 0.07, landIce - 0.07, temp);
  return mix(biome, snow, ice);
}
`;


/* UI parameters */
let N = 10000;
let P = 20;
let jitter = 0.75;
let rotation = -1;
let dragRotation = mat4.create();
let zoom = 1;
let northHeadingAngle = 0;
let viewAnimId = 0;
let drawMode = 'quads';
let viewMode = 'globe';
let draw_plateVectors = false;
let draw_plateBoundaries = false;
let merge_ocean_plates = false;
let connect_oceans = false;
let simulate_tectonics = true;
let sim_steps = Tectonics.DEFAULTS.steps;
let previewOverlay = null;   // null | 'plates' | 'crust' | 'climate'
let previewYaw = 0;

/* Which per-region overlay the surface is painted with, if any. */
function overlayMode() {
    if (viewPersistSuspended) return previewOverlay;
    if (previewOverlay) return previewOverlay;
    return ['plates', 'crust', 'climate'].indexOf(drawMode) !== -1 ? drawMode : null;
}

function usePlateOverlay() {
    return overlayMode() !== null;
}

let mapId = 0;
let equirectPanX = 0;
let equirectPanY = 0;
let equirectZoom = 1;

window.__PLANET_READY__ = false;

window.setN = newN => { N = newN; generateMesh(); };
window.setP = newP => { P = newP; generateMap(); };
window.setJitter = newJitter => { jitter = newJitter; generateMesh(); };
window.setRotation = newRotation => { rotation = newRotation; draw(); };
window.setDrawMode = newMode => {
    if (['quads', 'centroid', 'plates', 'crust', 'climate'].indexOf(newMode) === -1) return;
    drawMode = newMode;
    draw();
};
window.setViewMode = newMode => { applyViewMode(newMode); };
window.setDrawPlateVectors = flag => { draw_plateVectors = flag; draw(); };
window.setDrawPlateBoundaries = flag => { draw_plateBoundaries = flag; draw(); };
window.setMergeOceanPlates = flag => { merge_ocean_plates = !!flag; generateMap(); };
window.setConnectOceans = flag => { connect_oceans = !!flag; generateMap(); };
window.setSimulateTectonics = flag => { simulate_tectonics = !!flag; generateMap(); };
window.setSimSteps = steps => { sim_steps = Math.max(0, steps | 0); generateMap(); };
window.getSeed = () => seed;

const renderPoints = regl({
    frag: `
precision mediump float;
void main() {
   gl_FragColor = vec4(0, 0, 0, 1);
}
`,

    vert: `
precision mediump float;
uniform mat4 u_projection;
uniform float u_pointsize;
attribute vec3 a_xyz;
void main() {
  gl_Position = u_projection * vec4(a_xyz, 1);
  gl_PointSize = gl_Position.z > 0.0? 0.0 : u_pointsize;
}
`,

    depth: {
        enable: false,
    },
    
    uniforms: {
        u_projection: regl.prop('u_projection'),
        u_pointsize: regl.prop('u_pointsize'),
    },

    primitive: 'points',
    count: regl.prop('count'),
    attributes: {
        a_xyz: regl.prop('a_xyz'),
    },
});


const renderLines = regl({
    frag: `
precision mediump float;
uniform vec4 u_multiply_rgba, u_add_rgba;
varying vec4 v_rgba;
void main() {
   gl_FragColor = v_rgba * u_multiply_rgba + u_add_rgba;
}
`,

    vert: `
precision mediump float;
uniform mat4 u_projection;
attribute vec3 a_xyz;
attribute vec4 a_rgba;
varying vec4 v_rgba;
void main() {
  vec4 pos = u_projection * vec4(a_xyz, 1);
  v_rgba = (-2.0 * pos.z) * a_rgba;
  gl_Position = pos;
}
`,

    depth: {
        enable: false,
    },
    
    uniforms: {
        u_projection: regl.prop('u_projection'),
        u_multiply_rgba: regl.prop('u_multiply_rgba'),
        u_add_rgba: regl.prop('u_add_rgba'),
    },

    blend: {
        enable: true,
        func: {src: 'one', dst: 'one minus src alpha'},
        equation: {
            rgb: 'add',
            alpha: 'add'
        },
        color: [0, 0, 0, 0],
    },
    primitive: 'lines',
    count: regl.prop('count'),
    attributes: {
        a_xyz: regl.prop('a_xyz'),
        a_rgba: regl.prop('a_rgba'),
    },
});


const renderTriangles = regl({
    frag: `
precision mediump float;
uniform sampler2D u_colormap;
uniform float u_sea_ice, u_land_ice;
varying vec3 v_tm;
${SURFACE_GLSL}
void main() {
   gl_FragColor = vec4(surfaceAlbedo(u_colormap, v_tm, u_sea_ice, u_land_ice), 1);
}
`,

    vert: `
precision mediump float;
uniform mat4 u_projection;
attribute vec3 a_xyz;
attribute vec3 a_tm;
varying vec3 v_tm;
void main() {
  v_tm = a_tm;
  gl_Position = u_projection * vec4(a_xyz, 1);
}
`,

    uniforms: {
        u_colormap: u_colormap,
        u_projection: regl.prop('u_projection'),
        u_sea_ice: SEA_ICE,
        u_land_ice: LAND_ICE,
    },

    count: regl.prop('count'),
    attributes: {
        a_xyz: regl.prop('a_xyz'),
        a_tm: regl.prop('a_tm'),
    },
});


const renderIndexedTriangles = regl({
    frag: `
#extension GL_OES_standard_derivatives : enable

precision mediump float;

uniform sampler2D u_colormap;
uniform vec2 u_light_angle;
uniform float u_inverse_texture_size, u_slope, u_flat, u_c, u_d, u_outline_strength;
uniform float u_sea_ice, u_land_ice;

varying vec3 v_tm;
${SURFACE_GLSL}
void main() {
   float dedx = dFdx(v_tm.x);
   float dedy = dFdy(v_tm.x);
   vec3 slope_vector = normalize(vec3(dedy, dedx, u_d * 2.0 * u_inverse_texture_size));
   vec3 light_vector = normalize(vec3(u_light_angle, mix(u_slope, u_flat, slope_vector.z)));
   float light = u_c + max(0.0, dot(light_vector, slope_vector));
   float outline = 1.0 + u_outline_strength * max(dedx,dedy);
   vec3 albedo = surfaceAlbedo(u_colormap, v_tm, u_sea_ice, u_land_ice);
   gl_FragColor = vec4(albedo * light / outline, 1);
}
`,

    vert: `
precision mediump float;
uniform mat4 u_projection;
attribute vec3 a_xyz;
attribute vec3 a_tm;
varying vec3 v_tm;
void main() {
  v_tm = a_tm;
  gl_Position = u_projection * vec4(a_xyz, 1);
}
`,

    uniforms: {
        u_colormap: u_colormap,
        u_projection: regl.prop('u_projection'),
        u_light_angle: [Math.cos(Math.PI/3), Math.sin(Math.PI/3)],
        u_inverse_texture_size: 1.0 / 2048,
        u_d: 60,
        u_c: 0.15,
        u_slope: 6,
        u_flat: 2.5,
        u_outline_strength: 0,
        u_sea_ice: SEA_ICE,
        u_land_ice: LAND_ICE,
    },

    elements: regl.prop('elements'),
    attributes: {
        a_xyz: regl.prop('a_xyz'),
        a_tm: regl.prop('a_tm'),
    },
});

const renderFlatTriangles = regl({
    frag: `
precision mediump float;
varying vec3 v_rgb;
void main() {
   gl_FragColor = vec4(v_rgb, 1);
}
`,
    vert: `
precision mediump float;
uniform mat4 u_projection;
attribute vec3 a_xyz;
attribute vec3 a_tm;
varying vec3 v_rgb;
void main() {
  v_rgb = a_tm;
  gl_Position = u_projection * vec4(a_xyz, 1);
}
`,
    uniforms: {
        u_projection: regl.prop('u_projection'),
    },
    count: regl.prop('count'),
    attributes: {
        a_xyz: regl.prop('a_xyz'),
        a_tm: regl.prop('a_tm'),
    },
});

const renderFlatIndexed = regl({
    frag: `
precision mediump float;
varying vec3 v_rgb;
void main() {
   gl_FragColor = vec4(v_rgb, 1);
}
`,
    vert: `
precision mediump float;
uniform mat4 u_projection;
attribute vec3 a_xyz;
attribute vec3 a_tm;
varying vec3 v_rgb;
void main() {
  v_rgb = a_tm;
  gl_Position = u_projection * vec4(a_xyz, 1);
}
`,
    uniforms: {
        u_projection: regl.prop('u_projection'),
    },
    elements: regl.prop('elements'),
    attributes: {
        a_xyz: regl.prop('a_xyz'),
        a_tm: regl.prop('a_tm'),
    },
});

/**********************************************************************
 * Geometry
 */

let _randomNoise = new SimplexNoise(makeRandFloat(seed));

function parseSeed(raw) {
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) return null;
    return n | 0;
}

function applySeed(next) {
    seed = (next | 0);
    if (seed === 0) seed = 1;
    _randomNoise = new SimplexNoise(makeRandFloat(seed));
    const input = document.getElementById('seed-input');
    if (input) input.value = String(seed);
    syncSavedSeedsUI();
}

const SEED_HISTORY_MAX = 50;
let seedHistory = [seed];
let seedHistoryIndex = 0;

function syncSeedHistoryButtons() {
    const undo = document.getElementById('seed-undo');
    const redo = document.getElementById('seed-redo');
    if (undo) undo.disabled = seedHistoryIndex <= 0;
    if (redo) redo.disabled = seedHistoryIndex >= seedHistory.length - 1;
}

function commitSeed(next) {
    applySeed(next);
    if (seedHistory[seedHistoryIndex] === seed) {
        syncSeedHistoryButtons();
        return;
    }
    seedHistory = seedHistory.slice(0, seedHistoryIndex + 1);
    seedHistory.push(seed);
    if (seedHistory.length > SEED_HISTORY_MAX) {
        seedHistory = seedHistory.slice(seedHistory.length - SEED_HISTORY_MAX);
    }
    seedHistoryIndex = seedHistory.length - 1;
    generateMesh();
    syncSeedHistoryButtons();
}

window.setSeed = next => {
    const parsed = parseSeed(next);
    if (parsed == null) {
        const input = document.getElementById('seed-input');
        if (input) input.value = String(seed);
        return;
    }
    commitSeed(parsed);
};
/* Override a tectonic option and rebuild, so a parameter can be judged from a
   capture without editing the file. Preview scripts use this; the UI does not. */
window.setTectonicOption = (key, value) => {
    if (!(key in Tectonics.DEFAULTS)) throw new Error(`unknown tectonic option: ${key}`);
    Tectonics.DEFAULTS[key] = value;
    generateMesh();
};
window.shuffleSeed = () => {
    let next;
    do { next = (Math.random() * 0x7fffffff) | 0; } while (next === seed);
    commitSeed(next);
};
window.undoSeed = () => {
    if (seedHistoryIndex <= 0) return;
    seedHistoryIndex--;
    applySeed(seedHistory[seedHistoryIndex]);
    generateMesh();
    syncSeedHistoryButtons();
};
window.redoSeed = () => {
    if (seedHistoryIndex >= seedHistory.length - 1) return;
    seedHistoryIndex++;
    applySeed(seedHistory[seedHistoryIndex]);
    generateMesh();
    syncSeedHistoryButtons();
};

const SAVED_SEEDS_KEY = 'planetgen.savedSeeds';
const SAVED_SEED_NAME_MAX = 48;

function readSavedSeeds() {
    try {
        const raw = localStorage.getItem(SAVED_SEEDS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const seen = new Set();
        const items = [];
        for (const item of parsed) {
            const parsedSeed = parseSeed(item && item.seed);
            if (parsedSeed == null) continue;
            const nextSeed = parsedSeed === 0 ? 1 : parsedSeed;
            if (seen.has(nextSeed)) continue;
            seen.add(nextSeed);
            const name = item && typeof item.name === 'string'
                ? item.name.trim().slice(0, SAVED_SEED_NAME_MAX)
                : '';
            items.push({seed: nextSeed, name});
        }
        return items;
    } catch (_) {
        return [];
    }
}

function writeSavedSeeds(items) {
    try {
        localStorage.setItem(SAVED_SEEDS_KEY, JSON.stringify(items));
    } catch (_) {
        /* private mode / quota */
    }
}

function renderSavedSeedsList(items) {
    const list = document.getElementById('saved-seeds-list');
    if (!list) return;
    list.replaceChildren();
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'saved-seeds-empty';
        empty.textContent = 'No saved seeds';
        list.append(empty);
        return;
    }
    for (const item of items) {
        const row = document.createElement('div');
        row.className = 'saved-seed-row' + (item.seed === seed ? ' is-current' : '');

        const load = document.createElement('button');
        load.type = 'button';
        load.className = 'saved-seed-item';
        load.title = item.name ? `${item.name} (${item.seed})` : String(item.seed);
        load.addEventListener('click', () => window.setSeed(item.seed));

        const label = document.createElement('span');
        label.className = 'saved-seed-name';
        label.textContent = item.name || String(item.seed);

        load.append(label);
        if (item.name) {
            const num = document.createElement('span');
            num.className = 'saved-seed-num';
            num.textContent = String(item.seed);
            load.append(num);
        }

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'saved-seed-delete';
        del.setAttribute('aria-label', `Remove ${item.name || item.seed}`);
        del.textContent = '×';
        del.addEventListener('click', () => {
            writeSavedSeeds(readSavedSeeds().filter(entry => entry.seed !== item.seed));
            syncSavedSeedsUI();
        });

        row.append(load, del);
        list.append(row);
    }
}

function syncSavedSeedsUI() {
    const items = readSavedSeeds();
    const current = items.find(item => item.seed === seed);
    const nameInput = document.getElementById('saved-seed-name');
    if (nameInput && document.activeElement !== nameInput) {
        nameInput.value = current ? current.name : '';
    }
    const saveBtn = document.querySelector('#saved-seeds-form button[type="submit"]');
    if (saveBtn) saveBtn.textContent = current ? 'Update' : 'Save';
    renderSavedSeedsList(items);
}

function positionSavedSeedsPopover() {
    const button = document.getElementById('saved-seeds-btn');
    const popover = document.getElementById('saved-seeds-popover');
    if (!button || !popover) return;
    const rect = button.getBoundingClientRect();
    const gap = 8;
    const width = Math.min(272, window.innerWidth - 16);
    let left = rect.right + gap;
    let top = rect.top;
    if (left + width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - width - 8);
        top = rect.bottom + gap;
    }
    const maxTop = window.innerHeight - 16;
    popover.style.width = `${width}px`;
    popover.style.left = `${left}px`;
    popover.style.top = `${Math.min(top, maxTop)}px`;
    popover.style.transformOrigin = `${Math.max(0, rect.left - left)}px ${Math.max(0, rect.top - top)}px`;
}

function setupSavedSeeds() {
    const form = document.getElementById('saved-seeds-form');
    const popover = document.getElementById('saved-seeds-popover');
    if (form) {
        form.addEventListener('submit', event => {
            event.preventDefault();
            const nameInput = document.getElementById('saved-seed-name');
            const name = nameInput ? nameInput.value.trim().slice(0, SAVED_SEED_NAME_MAX) : '';
            const rest = readSavedSeeds().filter(item => item.seed !== seed);
            writeSavedSeeds([{seed, name}, ...rest]);
            syncSavedSeedsUI();
        });
    }
    if (popover) {
        popover.addEventListener('toggle', event => {
            const open = event.newState === 'open';
            document.getElementById('saved-seeds-btn')?.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (!open) return;
            syncSavedSeedsUI();
            positionSavedSeedsPopover();
            const nameInput = document.getElementById('saved-seed-name');
            if (nameInput) nameInput.focus();
        });
        window.addEventListener('resize', () => {
            if (popover.matches(':popover-open')) positionSavedSeedsPopover();
        });
    }
    syncSavedSeedsUI();
}

const persistence = 2/3;
const amplitudes = Array.from({length: 5}, (_, octave) => Math.pow(persistence, octave));

function fbm_noise(nx, ny, nz) {
    let sum = 0, sumOfAmplitudes = 0;
    for (let octave = 0; octave < amplitudes.length; octave++) {
        let frequency = 1 << octave;
        sum += amplitudes[octave] * _randomNoise.noise3D(nx * frequency, ny * frequency, nz * frequency);
        sumOfAmplitudes += amplitudes[octave];
    }
    return sum / sumOfAmplitudes;
}

function generateTriangleCenters(mesh, {r_xyz}) {
    let {numTriangles} = mesh;
    let t_xyz = new Float32Array(3 * numTriangles);
    for (let t = 0; t < numTriangles; t++) {
        let a = mesh.s_begin_r(3*t),
            b = mesh.s_begin_r(3*t+1),
            c = mesh.s_begin_r(3*t+2);
        // Calculate centroid
        let ax = r_xyz[3*a], ay = r_xyz[3*a+1], az = r_xyz[3*a+2],
            bx = r_xyz[3*b], by = r_xyz[3*b+1], bz = r_xyz[3*b+2],
            cx = r_xyz[3*c], cy = r_xyz[3*c+1], cz = r_xyz[3*c+2];
        t_xyz[3*t  ] = (ax+bx+cx)/3;
        t_xyz[3*t+1] = (ay+by+cy)/3;
        t_xyz[3*t+2] = (az+bz+cz)/3;
    }
    return t_xyz;
}

function generateVoronoiGeometry(mesh, {r_xyz, t_xyz}, r_color_fn) {
    const {numSides} = mesh;
    let xyz = new Float32Array(3 * 3 * numSides),
        tm = new Float32Array(3 * 3 * numSides);

    for (let s = 0; s < numSides; s++) {
        let inner_t = mesh.s_inner_t(s),
            outer_t = mesh.s_outer_t(s),
            begin_r = mesh.s_begin_r(s);
        let rgb = r_color_fn(begin_r);
        for (let i = 0; i < 3; i++) {
            xyz[9 * s + 0 + i] = t_xyz[3 * inner_t + i];
        }
        for (let i = 0; i < 3; i++) {
            xyz[9 * s + 3 + i] = t_xyz[3 * outer_t + i];
        }
        for (let i = 0; i < 3; i++) {
            xyz[9 * s + 6 + i] = r_xyz[3 * begin_r + i];
        }
        for (let j = 0; j < 3; j++) {
            for (let i = 0; i < 3; i++) {
                tm[9 * s + 3 * j + i] = rgb[i];
            }
        }
    }
    return {xyz, tm};
}

class QuadGeometry {
    constructor () {
        /* xyz = position in 3-space;
           tm = elevation, moisture, temperature
           I = indices for indexed drawing mode */
    }

    setMesh({numSides, numRegions, numTriangles}) {
        this.I = new Int32Array(3 * numSides);
        this.xyz = new Float32Array(3 * (numRegions + numTriangles));
        this.tm = new Float32Array(3 * (numRegions + numTriangles));
    }

    setMap(mesh, {r_xyz, t_xyz, r_elevation, t_elevation, r_moisture, t_moisture, r_temperature, t_temperature}) {
        const V = 0.95;
        const {numSides, numRegions, numTriangles} = mesh;
        const {xyz, tm, I} = this;

        xyz.set(r_xyz);
        xyz.set(t_xyz, r_xyz.length);
        // TODO: multiply all the r, t points by the elevation, taking V into account

        let p = 0;
        for (let r = 0; r < numRegions; r++) {
            tm[p++] = r_elevation[r];
            tm[p++] = r_moisture[r];
            tm[p++] = r_temperature[r];
        }
        for (let t = 0; t < numTriangles; t++) {
            tm[p++] = t_elevation[t];
            tm[p++] = t_moisture[t];
            tm[p++] = t_temperature[t];
        }

        let i = 0, count_valley = 0, count_ridge = 0;
        for (let s = 0; s < numSides; s++) {
            let opposite_s = mesh.s_opposite_s(s),
                r1 = mesh.s_begin_r(s),
                r2 = mesh.s_begin_r(opposite_s),
                t1 = mesh.s_inner_t(s),
                t2 = mesh.s_inner_t(opposite_s);
            
            // Each quadrilateral is turned into two triangles, so each
            // half-edge gets turned into one. There are two ways to fold
            // a quadrilateral. This is usually a nuisance but in this
            // case it's a feature. See the explanation here
            // https://www.redblobgames.com/x/1725-procedural-elevation/#rendering
            let coast = r_elevation[r1] < 0.0 || r_elevation[r2] < 0.0;
            if (coast) {
                I[i++] = r1; I[i++] = numRegions+t2; I[i++] = numRegions+t1;
                count_valley++;
            } else {
                I[i++] = r1; I[i++] = r2; I[i++] = numRegions+t1;
                count_ridge++;
            }
        }

        console.log('ridge=', count_ridge, ', valley=', count_valley);
    }
}

/**********************************************************************
 * Plates
 */

/* Plates, their Euler poles and their motion all live in ./tectonics.js so
 * they can be run and measured outside the browser. */
function generatePlates(mesh, r_xyz) {
    return Tectonics.generatePlates(mesh, P, seed);
}


/* The 1843 collision test wants one vector per plate. Rigid rotation has no
 * such thing, so hand it the velocity at each plate's centroid; that is the
 * closest a single vector gets to describing the plate's motion. */
function plateVectorsFromPoles(mesh, r_xyz, plates, r_plate) {
    const centroid = plateCentroids(mesh, r_xyz, plates, r_plate);
    const plate_vec = [];
    for (let p = 0; p < plates.length; p++) {
        plate_vec[p] = Tectonics.plateVelocity([], plates[p].pole, plates[p].omega, centroid[p]);
        const speed = vec3.length(plate_vec[p]);
        if (speed > 1e-12) vec3.scale(plate_vec[p], plate_vec[p], 1 / speed);
    }
    return plate_vec;
}


/* Adjacent ocean plates become one plate so the 1843 path doesn't get fake
 * ocean-ocean ridges and trenches. Land plates stay as they are. Only that
 * path uses this; the simulation has no need of it. */
function mergeOceanPlates(mesh, r_plate, plate_is_ocean) {
    const parent = new Map();
    const find = (p) => { while (parent.has(p) && parent.get(p) !== p) p = parent.get(p); return p; };
    for (const p of plate_is_ocean) parent.set(p, p);

    const out_r = [];
    for (let r = 0; r < mesh.numRegions; r++) {
        const p = r_plate[r];
        if (!plate_is_ocean.has(p)) continue;
        mesh.r_circulate_r(out_r, r);
        for (const n of out_r) {
            const q = r_plate[n];
            if (q === p || !plate_is_ocean.has(q)) continue;
            const a = find(p), b = find(q);
            if (a !== b) parent.set(b, a);
        }
    }
    for (let r = 0; r < mesh.numRegions; r++) {
        if (plate_is_ocean.has(r_plate[r])) r_plate[r] = find(r_plate[r]);
    }
    const nextOcean = new Set();
    for (const p of plate_is_ocean) nextOcean.add(find(p));
    return {plate_is_ocean: nextOcean};
}


function plateCentroids(mesh, r_xyz, plates, r_plate) {
    const centroid = plates.map(() => [0, 0, 0]);
    for (let r = 0; r < mesh.numRegions; r++) {
        const c = centroid[r_plate[r]];
        c[0] += r_xyz[3 * r]; c[1] += r_xyz[3 * r + 1]; c[2] += r_xyz[3 * r + 2];
    }
    for (const c of centroid) vec3.normalize(c, c);
    return centroid;
}


/* Distance from any point in seeds_r to all other points, but 
 * don't go past any point in stop_r */
function assignDistanceField(mesh, seeds_r, stop_r) {
    const randInt = makeRandInt(seed);
    let {numRegions} = mesh;
    let r_distance = new Float32Array(numRegions);
    r_distance.fill(Infinity);
    
    let queue = [];
    for (let r of seeds_r) {
        queue.push(r);
        r_distance[r] = 0;
    }

    /* Random search adapted from breadth first search */
    let out_r = [];
    for (let queue_out = 0; queue_out < queue.length; queue_out++) {
        let pos = queue_out + randInt(queue.length - queue_out);
        let current_r = queue[pos];
        queue[pos] = queue[queue_out];
        mesh.r_circulate_r(out_r, current_r);
        for (let neighbor_r of out_r) {
            if (r_distance[neighbor_r] === Infinity && !stop_r.has(neighbor_r)) {
                r_distance[neighbor_r] = r_distance[current_r] + 1;
                queue.push(neighbor_r);
            }
        }
    }
    return r_distance;
    // TODO: possible enhancement: keep track of which seed is closest
    // to this point, so that we can assign variable mountain/ocean
    // elevation to each seed instead of them always being +1/-1
}


/* Calculate the collision measure, which is the amount
 * that any neighbor's plate vector is pushing against 
 * the current plate vector. */
const COLLISION_THRESHOLD = 0.75;
function findCollisions(mesh, r_xyz, plate_is_ocean, r_plate, plate_vec) {
    const deltaTime = 1e-2; // simulate movement
    let {numRegions} = mesh;
    let mountain_r = new Set(),
        coastline_r = new Set(),
        ocean_r = new Set();
    let r_out = [];
    /* For each region, I want to know how much it's being compressed
       into an adjacent region. The "compression" is the change in
       distance as the two regions move. I'm looking for the adjacent
       region from a different plate that pushes most into this one*/
    for (let current_r = 0; current_r < numRegions; current_r++) {
        let bestCompression = Infinity, best_r = -1;
        mesh.r_circulate_r(r_out, current_r);
        for (let neighbor_r of r_out) {
            if (r_plate[current_r] !== r_plate[neighbor_r]) {
                /* sometimes I regret storing xyz in a compact array... */
                let current_pos = r_xyz.slice(3 * current_r, 3 * current_r + 3),
                    neighbor_pos = r_xyz.slice(3 * neighbor_r, 3 * neighbor_r + 3);
                /* simulate movement for deltaTime seconds */
                let distanceBefore = vec3.distance(current_pos, neighbor_pos),
                    distanceAfter = vec3.distance(vec3.add([], current_pos, vec3.scale([], plate_vec[r_plate[current_r]], deltaTime)),
                                                  vec3.add([], neighbor_pos, vec3.scale([], plate_vec[r_plate[neighbor_r]], deltaTime)));
                /* how much closer did these regions get to each other? */
                let compression = distanceBefore - distanceAfter;
                /* keep track of the adjacent region that gets closest */
                // TODO: shouldn't this be > ? need to re-tune all the parameters for the page after changing this
                if (compression < bestCompression) {
                    best_r = neighbor_r;
                    bestCompression = compression;
                }
            }
        }
        if (best_r !== -1) {
            /* at this point, bestCompression tells us how much closer
               we are getting to the region that's pushing into us the most */
            let collided = bestCompression > COLLISION_THRESHOLD * deltaTime;
            let current_plate = r_plate[current_r],
                best_plate = r_plate[best_r];
            if (plate_is_ocean.has(current_plate) && plate_is_ocean.has(best_plate)) {
                (collided? coastline_r : ocean_r).add(current_r);
            } else if (!plate_is_ocean.has(current_plate) && !plate_is_ocean.has(best_plate)) {
                if (collided) mountain_r.add(current_plate);
            } else {
                (collided? mountain_r : coastline_r).add(current_r);
            }
        }
    }
    return {mountain_r, coastline_r, ocean_r};
}


function assignRegionElevation(mesh, {r_xyz, plate_is_ocean, r_plate, plate_vec, extra_ocean_seeds, /* out */ r_elevation}) {
    const epsilon = 1e-3;
    let {numRegions} = mesh;

    let {mountain_r, coastline_r, ocean_r} = findCollisions(
        mesh, r_xyz, plate_is_ocean, r_plate, plate_vec);

    for (let r = 0; r < numRegions; r++) {
        if (r_plate[r] === r) {
            (plate_is_ocean.has(r)? ocean_r : coastline_r).add(r);
        }
    }
    if (extra_ocean_seeds) {
        for (let r of extra_ocean_seeds) ocean_r.add(r);
    }

    let stop_r = new Set();
    for (let r of mountain_r) { stop_r.add(r); }
    for (let r of coastline_r) { stop_r.add(r); }
    for (let r of ocean_r) { stop_r.add(r); }

    console.log('seeds mountain/coastline/ocean:', mountain_r.size, coastline_r.size, ocean_r.size, 'plate_is_ocean', plate_is_ocean.size,'/', P);
    let r_distance_a = assignDistanceField(mesh, mountain_r, ocean_r);
    let r_distance_b = assignDistanceField(mesh, ocean_r, coastline_r);
    let r_distance_c = assignDistanceField(mesh, coastline_r, stop_r);

    for (let r = 0; r < numRegions; r++) {
        let a = r_distance_a[r] + epsilon,
            b = r_distance_b[r] + epsilon,
            c = r_distance_c[r] + epsilon;
        if (a === Infinity && b === Infinity) {
            r_elevation[r] = 0.1;
        } else {
            r_elevation[r] = (1/a - 1/b) / (1/a + 1/b + 1/c);
        }
        r_elevation[r] += 0.1 * fbm_noise(r_xyz[3*r], r_xyz[3*r+1], r_xyz[3*r+2]);
    }
}


const STRAIT = -0.05;
const LAKE_FILL = 0.08;

function labelOceanComponents(mesh, r_elevation) {
    const {numRegions} = mesh;
    const comp = new Int32Array(numRegions);
    comp.fill(-1);
    const r_out = [];
    const sizes = [];
    let ncomp = 0;
    for (let s = 0; s < numRegions; s++) {
        if (r_elevation[s] >= 0 || comp[s] !== -1) continue;
        const q = [s];
        comp[s] = ncomp;
        let sz = 1;
        for (let i = 0; i < q.length; i++) {
            mesh.r_circulate_r(r_out, q[i]);
            for (let n of r_out) {
                if (r_elevation[n] < 0 && comp[n] === -1) {
                    comp[n] = ncomp;
                    q.push(n);
                    sz++;
                }
            }
        }
        sizes.push(sz);
        ncomp++;
    }
    let main = 0;
    for (let i = 1; i < ncomp; i++) {
        if (sizes[i] > sizes[main]) main = i;
    }
    return {comp, ncomp, sizes, main};
}

function heapPush(h, node) {
    h.push(node);
    let i = h.length - 1;
    while (i > 0) {
        const p = (i - 1) >> 1;
        if (h[p].key <= h[i].key) break;
        const t = h[p];
        h[p] = h[i];
        h[i] = t;
        i = p;
    }
}

function heapPop(h) {
    const out = h[0];
    const last = h.pop();
    if (!h.length) return out;
    h[0] = last;
    let i = 0;
    for (;;) {
        const l = i * 2 + 1, rgt = l + 1;
        let s = i;
        if (l < h.length && h[l].key < h[s].key) s = l;
        if (rgt < h.length && h[rgt].key < h[s].key) s = rgt;
        if (s === i) break;
        const t = h[s];
        h[s] = h[i];
        h[i] = t;
        i = s;
    }
    return out;
}

/* Make every below-sea-level cell part of one world ocean: fill tiny
 * inland seas, punch a shallow strait through the lowest saddle between
 * large basins. */
function connectWorldOcean(mesh, r_elevation) {
    const {numRegions} = mesh;
    let labeled = labelOceanComponents(mesh, r_elevation);
    if (labeled.ncomp <= 1) return;

    const fillMax = Math.max(36, (labeled.sizes[labeled.main] * 0.08) | 0);
    for (let r = 0; r < numRegions; r++) {
        const c = labeled.comp[r];
        if (c >= 0 && c !== labeled.main && labeled.sizes[c] <= fillMax) {
            r_elevation[r] = LAKE_FILL;
        }
    }

    const r_out = [];
    for (let guard = 0; guard < 24; guard++) {
        labeled = labelOceanComponents(mesh, r_elevation);
        if (labeled.ncomp <= 1) return;
        const {comp, main} = labeled;

        const d = new Float32Array(numRegions);
        d.fill(Infinity);
        const parent = new Int32Array(numRegions);
        parent.fill(-1);
        const heap = [];
        for (let r = 0; r < numRegions; r++) {
            if (comp[r] === main) {
                d[r] = -1;
                heapPush(heap, {r, key: -1});
            }
        }

        let hit = -1;
        while (heap.length) {
            const {r, key} = heapPop(heap);
            if (key > d[r]) continue;
            if (comp[r] >= 0 && comp[r] !== main) {
                hit = r;
                break;
            }
            mesh.r_circulate_r(r_out, r);
            for (let n of r_out) {
                const step = r_elevation[n] < 0 ? d[r] : Math.max(d[r], r_elevation[n]);
                if (step < d[n]) {
                    d[n] = step;
                    parent[n] = r;
                    heapPush(heap, {r: n, key: step});
                }
            }
        }
        if (hit < 0) return;

        let p = hit;
        let carved = false;
        while (p !== -1) {
            if (r_elevation[p] >= 0) {
                r_elevation[p] = STRAIT;
                carved = true;
            }
            if (comp[p] === main) break;
            p = parent[p];
        }
        if (!carved) return;
    }
}


/* Shared with the models, which need it outside the browser. */
const {clamp01} = Tectonics;

/* Winds, moisture advection and temperature all live in ./climate.js so they
 * can be run and measured outside the browser. */
function assignClimate(mesh, map) {
    Climate.assignClimate(mesh, map, seed);
}


function assignTriangleValues(mesh, {r_elevation, r_moisture, r_temperature, /* out */ t_elevation, t_moisture, t_temperature}) {
    const {numTriangles} = mesh;
    for (let t = 0; t < numTriangles; t++) {
        let s0 = 3*t;
        let r1 = mesh.s_begin_r(s0),
            r2 = mesh.s_begin_r(s0+1),
            r3 = mesh.s_begin_r(s0+2);
        t_elevation[t] = 1/3 * (r_elevation[r1] + r_elevation[r2] + r_elevation[r3]);
        t_moisture[t] = 1/3 * (r_moisture[r1] + r_moisture[r2] + r_moisture[r3]);
        t_temperature[t] = 1/3 * (r_temperature[r1] + r_temperature[r2] + r_temperature[r3]);
    }
}




/**********************************************************************
 * Main
 */

// ugh globals, sorry
var mesh, map = {};
var quadGeometry = new QuadGeometry();

function generateMesh() {
    let result = SphereMesh.makeSphere(N, jitter, makeRandFloat(seed));
    mesh = result.mesh;
    quadGeometry.setMesh(mesh);
    
    map.r_elevation = new Float32Array(mesh.numRegions);
    map.t_elevation = new Float32Array(mesh.numTriangles);
    map.r_moisture = new Float32Array(mesh.numRegions);
    map.t_moisture = new Float32Array(mesh.numTriangles);
    map.r_temperature = new Float32Array(mesh.numRegions);
    map.t_temperature = new Float32Array(mesh.numTriangles);

    map.r_xyz = result.r_xyz;
    map.t_xyz = generateTriangleCenters(mesh, map);
    generateMap();
}

function generateMap() {
    Object.assign(map, generatePlates(mesh, map.r_xyz));

    if (simulate_tectonics) {
        Tectonics.simulateTectonics(mesh, map, seed, {steps: sim_steps});
        map.plate_is_ocean = oceanicPlates(mesh, map);
    } else {
        /* The 1843 path wants a static partition and a coin flip for which
         * plates are oceanic. */
        map.boundaryWarp = Tectonics.makeBoundaryWarp(mesh, map.r_xyz, seed, Tectonics.DEFAULTS);
        map.tectonicFieldsFor = `${mesh.numRegions}:${seed}`;
        map.r_plate = Tectonics.plateOwnership(mesh, map, Tectonics.DEFAULTS);
        map.plate_is_ocean = new Set();
        for (let p = 0; p < map.plates.length; p++) {
            if (makeRandInt(map.plates[p].id + 1)(10) < 5) map.plate_is_ocean.add(p);
        }
        if (merge_ocean_plates) {
            map.plate_is_ocean = mergeOceanPlates(mesh, map.r_plate, map.plate_is_ocean).plate_is_ocean;
        }
        map.extra_ocean_seeds = [];
        map.plate_vec = plateVectorsFromPoles(mesh, map.r_xyz, map.plates, map.r_plate);
        assignRegionElevation(mesh, map);
        map.r_boundary = null;
        map.r_crust_age = null;
    }
    map.plate_centroid = plateCentroids(mesh, map.r_xyz, map.plates, map.r_plate);
    if (connect_oceans) connectWorldOcean(mesh, map.r_elevation);
    assignClimate(mesh, map);
    assignTriangleValues(mesh, map);

    quadGeometry.setMap(mesh, map);
    overlayColorCache.clear();
    mapId++;
    equirectCache = null;
    draw();
}

/* A plate counts as oceanic when most of the crust it carries is oceanic.
 * After the simulation this is a property of the crust, not a coin flip on
 * the plate, so a plate can be mostly ocean and still carry a continent. */
function oceanicPlates(mesh, {r_plate, r_crust_type, plates}) {
    const total = new Int32Array(plates.length);
    const continental = new Int32Array(plates.length);
    for (let r = 0; r < mesh.numRegions; r++) {
        total[r_plate[r]]++;
        if (r_crust_type[r] === Tectonics.CRUST_CONTINENTAL) continental[r_plate[r]]++;
    }
    const ocean = new Set();
    for (let p = 0; p < plates.length; p++) {
        if (continental[p] / Math.max(1, total[p]) < 0.5) ocean.add(p);
    }
    return ocean;
}



function hsvRgb(h, s, v) {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: return [v, t, p];
        case 1: return [q, v, p];
        case 2: return [p, v, t];
        case 3: return [p, q, v];
        case 4: return [t, p, v];
        default: return [v, p, q];
    }
}

function colorForPlate(index, ocean) {
    const h = (index * 0.618033988749895) % 1;
    return hsvRgb(h, ocean ? 0.5 : 0.58, ocean ? 0.48 : 0.94);
}

function plateColorForRegion(r) {
    /* colour by the plate's permanent id, so a plate keeps its colour as
       others come and go around it */
    return colorForPlate(map.plates[map.r_plate[r]].id, map.r_elevation[r] < 0);
}

function overlayColorForRegion(r) {
    const mode = overlayMode();
    if (mode === 'crust') return crustColorForRegion(r, map);
    if (mode === 'climate') return climateColorForRegion(r, map);
    return plateColorForRegion(r);
}

/* Sea floor by age, land by how recently it was built up: the fields the
 * simulation actually works in, so they can be judged directly rather than
 * inferred from the finished relief. */
function crustColorForRegion(r, map) {
    const {r_crust_type, r_crust_age, r_orogeny, r_arc, r_boundary} = map;
    if (r_boundary && r_boundary[r] === BOUNDARY_DIVERGENT) return [1.0, 0.35, 0.2];
    if (r_boundary && r_boundary[r] === BOUNDARY_CONVERGENT) return [0.25, 0.9, 1.0];
    if (r_boundary && r_boundary[r] === BOUNDARY_TRANSFORM) return [1.0, 0.95, 0.35];
    if (r_crust_type && r_crust_type[r] === Tectonics.CRUST_CONTINENTAL) {
        const relief = clamp01(r_orogeny[r] * 0.7 + r_arc[r] * 0.3);
        return [0.35 + 0.6 * relief, 0.5 - 0.18 * relief, 0.3 - 0.1 * relief];
    }
    /* young sea floor pale, old sea floor dark: the ridge-to-abyss gradient */
    const young = 1 - clamp01((r_crust_age ? r_crust_age[r] : 0) / 200);
    return [0.05 + 0.15 * young, 0.15 + 0.45 * young, 0.3 + 0.6 * young];
}


/* The moisture field on its own, with none of the biome table's
 * interpretation in the way. Rendering the finished colours and reasoning
 * backwards about what moisture must have been is how you end up tuning the
 * wrong thing. */
function climateColorForRegion(r, map) {
    if (map.r_elevation[r] <= 0) return [0.13, 0.15, 0.2];
    const m = clamp01(map.r_moisture[r]);
    /* dry sand -> steppe -> forest -> saturated */
    const stops = [
        [0.00, [0.85, 0.72, 0.42]],
        [0.35, [0.76, 0.70, 0.34]],
        [0.55, [0.55, 0.68, 0.30]],
        [0.75, [0.24, 0.56, 0.28]],
        [1.00, [0.05, 0.32, 0.45]],
    ];
    for (let i = 1; i < stops.length; i++) {
        if (m <= stops[i][0] || i === stops.length - 1) {
            const [a, ca] = stops[i - 1], [b, cb] = stops[i];
            const t = clamp01((m - a) / (b - a));
            return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
        }
    }
    return stops[stops.length - 1][1];
}


function buildOverlayColorTm(mesh, map, mode) {
    const {r_plate, r_elevation} = map;
    const {numRegions, numTriangles} = mesh;
    const rgb = new Float32Array(3 * (numRegions + numTriangles));
    const regionColor = [];
    for (let r = 0; r < numRegions; r++) {
        const c = mode === 'crust' ? crustColorForRegion(r, map)
            : mode === 'climate' ? climateColorForRegion(r, map)
            : colorForPlate(map.plates[r_plate[r]].id, r_elevation[r] < 0);
        regionColor[r] = c;
        rgb[3 * r] = c[0];
        rgb[3 * r + 1] = c[1];
        rgb[3 * r + 2] = c[2];
    }
    for (let t = 0; t < numTriangles; t++) {
        const r1 = mesh.s_begin_r(3 * t),
            r2 = mesh.s_begin_r(3 * t + 1),
            r3 = mesh.s_begin_r(3 * t + 2);
        const a = regionColor[r1], b = regionColor[r2], c = regionColor[r3];
        const p = 3 * (numRegions + t);
        rgb[p] = (a[0] + b[0] + c[0]) / 3;
        rgb[p + 1] = (a[1] + b[1] + c[1]) / 3;
        rgb[p + 2] = (a[2] + b[2] + c[2]) / 3;
    }
    return rgb;
}


const overlayColorCache = new Map();

function overlayColorTm() {
    const mode = overlayMode() || 'plates';
    if (!overlayColorCache.has(mode)) {
        overlayColorCache.set(mode, buildOverlayColorTm(mesh, map, mode));
    }
    return overlayColorCache.get(mode);
}


/* Velocity is a rotation, so it varies across a plate: the arrows have to
 * be evaluated per region, not shared from one vector per plate. */
/* Arrow length is proportional to speed, scaled so a plate rotating at the
 * typical rate draws an arrow about one cell long. */
const PLATE_ARROW_REFERENCE_OMEGA = 0.006;

function drawPlateVectors(u_projection, mesh, {r_xyz, r_plate, plates}) {
    let line_xyz = [], line_rgba = [];
    const scale = (2 / Math.sqrt(N)) / PLATE_ARROW_REFERENCE_OMEGA;
    const v = [0, 0, 0];

    for (let r = 0; r < mesh.numRegions; r++) {
        const pos = r_xyz.slice(3 * r, 3 * r + 3);
        const p = r_plate[r];
        Tectonics.plateVelocity(v, plates[p].pole, plates[p].omega, pos);
        line_xyz.push(pos);
        line_rgba.push([1, 1, 1, 1]);
        line_xyz.push(vec3.scaleAndAdd([], pos, v, scale));
        line_rgba.push([1, 0, 0, 0]);
    }

    renderLines({
        u_projection,
        u_multiply_rgba: [1, 1, 1, 1],
        u_add_rgba: [0, 0, 0, 0],
        a_xyz: line_xyz,
        a_rgba: line_rgba,
        count: line_xyz.length,
    });
}

function drawPlateBoundaries(u_projection, mesh, {t_xyz, r_plate}) {
    let line_xyz = [], line_rgba = [];
    const ink = usePlateOverlay() ? [0.06, 0.06, 0.08, 1] : [1, 1, 1, 1];
    for (let s = 0; s < mesh.numSides; s++) {
        let begin_r = mesh.s_begin_r(s),
            end_r = mesh.s_end_r(s);
        if (r_plate[begin_r] !== r_plate[end_r]) {
            let inner_t = mesh.s_inner_t(s),
                outer_t = mesh.s_outer_t(s);
            line_xyz.push(t_xyz.slice(3 * inner_t, 3 * inner_t + 3),
                          t_xyz.slice(3 * outer_t, 3 * outer_t + 3));
            line_rgba.push(ink, ink);
        }
    }
    renderLines({
        u_projection,
        u_multiply_rgba: [1, 1, 1, 1],
        u_add_rgba: [0, 0, 0, 0],
        a_xyz: line_xyz,
        a_rgba: line_rgba,
        count: line_xyz.length,
    });
}

function applyGlobeOrientation(out) {
    mat4.rotate(out, out, -Math.PI / 2, [1, 0, 0]);
    mat4.rotate(out, out, -rotation + previewYaw, [0, 0, 1]);
}

function globeViewMatrix(out) {
    mat4.identity(out);
    mat4.multiply(out, out, dragRotation);
    applyGlobeOrientation(out);
    return out;
}

function northHeading() {
    const view = globeViewMatrix(mat4.create());
    const inv = mat4.invert(mat4.create(), view);
    if (!inv) return northHeadingAngle;

    const facing = vec3.transformMat4([], [0, 0, -1], inv);
    vec3.normalize(facing, facing);
    const poleDot = facing[2];
    const tangent = [
        -facing[0] * poleDot,
        -facing[1] * poleDot,
        1 - poleDot * poleDot,
    ];
    const tangentLength = vec3.length(tangent);
    if (tangentLength < 1e-4) {
        const pole = vec3.transformMat4([], [0, 0, 1], view);
        if (Math.hypot(pole[0], pole[1]) < 1e-4) return northHeadingAngle;
        northHeadingAngle = Math.atan2(pole[0], pole[1]);
        return northHeadingAngle;
    }
    vec3.scale(tangent, tangent, 1 / tangentLength);
    const viewNorth = vec3.transformMat4([], tangent, view);
    northHeadingAngle = Math.atan2(viewNorth[0], viewNorth[1]);
    return northHeadingAngle;
}

function drawNorthPole(u_projection) {
    const line_xyz = [], line_rgba = [];
    const red = [0.89, 0.18, 0.14, 1];
    const redFade = [0.89, 0.18, 0.14, 0.2];

    line_xyz.push([0, 0, 0.78], [0, 0, 1.18]);
    line_rgba.push(redFade, red);

    const tip = 1.18, base = 1.04, s = 0.05;
    line_xyz.push([0, 0, tip], [s, 0, base], [0, 0, tip], [-s, 0, base],
                  [0, 0, tip], [0, s, base], [0, 0, tip], [0, -s, base]);
    for (let i = 0; i < 8; i++) line_rgba.push(red);

    const lat = 78 * Math.PI / 180;
    const ringZ = Math.sin(lat);
    const ringR = Math.cos(lat);
    const steps = 48;
    for (let i = 0; i < steps; i++) {
        const a0 = (i / steps) * Math.PI * 2;
        const a1 = ((i + 1) / steps) * Math.PI * 2;
        line_xyz.push(
            [ringR * Math.cos(a0), ringR * Math.sin(a0), ringZ],
            [ringR * Math.cos(a1), ringR * Math.sin(a1), ringZ]
        );
        line_rgba.push(red, red);
    }

    renderLines({
        u_projection,
        u_multiply_rgba: [1, 1, 1, 1],
        u_add_rgba: [0, 0, 0, 0],
        a_xyz: line_xyz,
        a_rgba: line_rgba,
        count: line_xyz.length,
    });
}

function animateView(apply) {
    const animId = ++viewAnimId;
    const startedAt = performance.now();
    const duration = 420;

    function step(now) {
        if (animId !== viewAnimId) return;
        const t = Math.min(1, (now - startedAt) / duration);
        apply(1 - (1 - t) ** 3);
        draw();
        if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

function reorientNorth() {
    const heading = northHeading();
    if (!isFinite(heading) || Math.abs(heading) < 1e-3) return;

    const startDrag = mat4.clone(dragRotation);
    animateView((eased) => {
        const delta = mat4.create();
        mat4.rotateZ(delta, delta, heading * eased);
        mat4.multiply(dragRotation, delta, startDrag);
    });
}

function resetView() {
    if (viewMode === 'equirect') {
        const startPanX = equirectPanX;
        const startPanY = equirectPanY;
        const startZoom = equirectZoom;
        const alreadyHome =
            Math.abs(startZoom - 1) < 1e-3 &&
            Math.abs(startPanX) < 1e-3 &&
            Math.abs(startPanY) < 1e-3;
        if (alreadyHome) return;
        animateView((eased) => {
            equirectPanX = wrapPanX(startPanX * (1 - eased));
            equirectPanY = startPanY * (1 - eased);
            equirectZoom = startZoom + (1 - startZoom) * eased;
        });
        return;
    }

    const startDrag = mat4.clone(dragRotation);
    const startQuat = mat4.getRotation(quat.create(), startDrag);
    const endQuat = quat.create();
    const startZoom = zoom;
    const alreadyHome =
        Math.abs(startZoom - 1) < 1e-3 &&
        Math.hypot(startQuat[0], startQuat[1], startQuat[2]) < 1e-3 &&
        Math.abs(Math.abs(startQuat[3]) - 1) < 1e-3;
    if (alreadyHome) return;

    animateView((eased) => {
        mat4.fromQuat(dragRotation, quat.slerp(quat.create(), startQuat, endQuat, eased));
        zoom = startZoom + (1 - startZoom) * eased;
    });
}

window.reorientNorth = reorientNorth;
window.resetView = resetView;

const PI = Math.PI;
const TWO_PI = 2 * PI;
const EQUIRECT_W = 2048;
const EQUIRECT_H = 1024;
const GLOBE_SIZE = 1024;
const POLE_LAT = PI / 2 - 1e-6;
const POLE_SNAP = 3 * PI / 180;

let equirectCache = null;
let seqI = null;

function wrapPanX(x) {
    return ((x + 1) % 2 + 2) % 2 - 1;
}

function syncViewModeDom() {
    const canvas = document.getElementById('output');
    if (viewMode === 'equirect') {
        canvas.width = EQUIRECT_W;
        canvas.height = EQUIRECT_H;
        document.body.classList.add('view-equirect');
        const toggle = document.querySelector('.view-mode-toggle');
        if (toggle) {
            toggle.title = 'Globe view';
            toggle.setAttribute('aria-label', 'Globe view');
        }
    } else {
        canvas.width = GLOBE_SIZE;
        canvas.height = GLOBE_SIZE;
        document.body.classList.remove('view-equirect');
        const toggle = document.querySelector('.view-mode-toggle');
        if (toggle) {
            toggle.title = 'Equirectangular map';
            toggle.setAttribute('aria-label', 'Equirectangular map');
        }
    }
}

function applyViewMode(mode) {
    if (mode !== 'globe' && mode !== 'equirect') return;
    if (mode === viewMode) {
        draw();
        return;
    }
    viewAnimId += 1;
    viewMode = mode;
    syncViewModeDom();
    draw();
}

function isPoleLat(lat) {
    return Math.abs(lat) > POLE_LAT;
}

function appendEquirectVertex(outXYZ, outTM, lon, lat, tm) {
    let y = (2 * lat) / PI;
    if (y >= 1) y = 1.02;
    if (y <= -1) y = -1.02;
    outXYZ.push(lon / PI, y, -0.5);
    outTM.push(tm[0], tm[1], tm[2]);
}

function emitEquirectTriangle(outXYZ, outTM, verts) {
    const v = [
        {lon: verts[0].lon, lat: verts[0].lat, tm: verts[0].tm},
        {lon: verts[1].lon, lat: verts[1].lat, tm: verts[1].tm},
        {lon: verts[2].lon, lat: verts[2].lat, tm: verts[2].tm},
    ];
    for (let i = 1; i < 3; i++) {
        while (v[i].lon - v[0].lon > PI) v[i].lon -= TWO_PI;
        while (v[0].lon - v[i].lon > PI) v[i].lon += TWO_PI;
    }
    function emit(shift) {
        for (let i = 0; i < 3; i++) {
            appendEquirectVertex(outXYZ, outTM, v[i].lon + shift, v[i].lat, v[i].tm);
        }
    }
    emit(0);
    const minL = Math.min(v[0].lon, v[1].lon, v[2].lon);
    const maxL = Math.max(v[0].lon, v[1].lon, v[2].lon);
    if (minL < -PI) emit(TWO_PI);
    if (maxL > PI) emit(-TWO_PI);
}

function appendEquirectTriangle(outXYZ, outTM, verts) {
    const poles = [];
    for (let i = 0; i < 3; i++) {
        if (isPoleLat(verts[i].lat)) poles.push(i);
    }
    if (poles.length === 1) {
        const p = poles[0];
        const a = verts[(p + 1) % 3];
        const b = verts[(p + 2) % 3];
        let lonA = a.lon, lonB = b.lon;
        while (lonB - lonA > PI) lonB -= TWO_PI;
        while (lonA - lonB > PI) lonB += TWO_PI;
        const poleLat = Math.sign(verts[p].lat) * (PI / 2);
        const poleA = {lon: lonA, lat: poleLat, tm: verts[p].tm};
        const poleB = {lon: lonB, lat: poleLat, tm: verts[p].tm};
        const aFix = {lon: lonA, lat: a.lat, tm: a.tm};
        const bFix = {lon: lonB, lat: b.lat, tm: b.tm};
        emitEquirectTriangle(outXYZ, outTM, [aFix, bFix, poleB]);
        emitEquirectTriangle(outXYZ, outTM, [aFix, poleB, poleA]);
        return;
    }
    emitEquirectTriangle(outXYZ, outTM, verts);
}

function vertexLonLat(xyz, tm, idx) {
    const x = xyz[idx * 3], y = xyz[idx * 3 + 1], z = xyz[idx * 3 + 2];
    let lat = Math.asin(Math.max(-1, Math.min(1, z)));
    if (PI / 2 - Math.abs(lat) < POLE_SNAP) {
        lat = Math.sign(lat || z) * (PI / 2);
    }
    return {
        lon: Math.atan2(y, x),
        lat,
        tm: [tm[idx * 3], tm[idx * 3 + 1], tm[idx * 3 + 2]],
    };
}

function buildEquirectTriangles(xyz, tm, indices) {
    const outXYZ = [], outTM = [];
    const n = indices ? indices.length : (xyz.length / 3);
    for (let i = 0; i < n; i += 3) {
        const i0 = indices ? indices[i] : i;
        const i1 = indices ? indices[i + 1] : i + 1;
        const i2 = indices ? indices[i + 2] : i + 2;
        appendEquirectTriangle(outXYZ, outTM, [
            vertexLonLat(xyz, tm, i0),
            vertexLonLat(xyz, tm, i1),
            vertexLonLat(xyz, tm, i2),
        ]);
    }
    return {
        xyz: new Float32Array(outXYZ),
        tm: new Float32Array(outTM),
        count: outXYZ.length / 3,
    };
}

function sequentialElements(count) {
    if (!seqI || seqI.length < count) {
        seqI = new Int32Array(count);
        for (let i = 0; i < count; i++) seqI[i] = i;
    }
    return seqI.subarray(0, count);
}

function rColorFn(r) {
    return [map.r_elevation[r], map.r_moisture[r], map.r_temperature[r]];
}

function getEquirectSurfaceGeometry() {
    const overlay = usePlateOverlay();
    const meshMode = drawMode === 'centroid' ? 'centroid' : 'quads';
    const key = `${meshMode}:${mapId}:${overlayMode() || 'surf'}`;
    if (equirectCache && equirectCache.key === key) return equirectCache.geo;
    let geo;
    if (overlay) {
        if (drawMode === 'centroid') {
            const raw = generateVoronoiGeometry(mesh, map, overlayColorForRegion);
            geo = buildEquirectTriangles(raw.xyz, raw.tm, null);
        } else {
            geo = buildEquirectTriangles(quadGeometry.xyz, overlayColorTm(), quadGeometry.I);
        }
    } else if (drawMode === 'centroid') {
        const raw = generateVoronoiGeometry(mesh, map, rColorFn);
        geo = buildEquirectTriangles(raw.xyz, raw.tm, null);
    } else {
        geo = buildEquirectTriangles(quadGeometry.xyz, quadGeometry.tm, quadGeometry.I);
    }
    equirectCache = {key, geo};
    return geo;
}

function equirectProjection(xshift) {
    const p = mat4.create();
    mat4.scale(p, p, [equirectZoom, equirectZoom, 1]);
    mat4.translate(p, p, [equirectPanX + xshift, equirectPanY, 0]);
    return p;
}

function appendEquirectSegment(line_xyz, line_rgba, ax, ay, az, bx, by, bz, rgbaA, rgbaB) {
    const a = {lon: Math.atan2(ay, ax), lat: Math.asin(Math.max(-1, Math.min(1, az)))};
    const b = {lon: Math.atan2(by, bx), lat: Math.asin(Math.max(-1, Math.min(1, bz)))};
    while (b.lon - a.lon > PI) b.lon -= TWO_PI;
    while (a.lon - b.lon > PI) b.lon += TWO_PI;
    const shifts = [0];
    const minL = Math.min(a.lon, b.lon);
    const maxL = Math.max(a.lon, b.lon);
    if (minL < -PI) shifts.push(TWO_PI);
    if (maxL > PI) shifts.push(-TWO_PI);
    for (const shift of shifts) {
        line_xyz.push(
            [(a.lon + shift) / PI, (2 * a.lat) / PI, -0.5],
            [(b.lon + shift) / PI, (2 * b.lat) / PI, -0.5]
        );
        line_rgba.push(rgbaA, rgbaB);
    }
}

function drawEquirectPlateVectors(u_projection, mesh, {r_xyz, r_plate, plates}) {
    let line_xyz = [], line_rgba = [];
    const scale = (2 / Math.sqrt(N)) / PLATE_ARROW_REFERENCE_OMEGA;
    const v = [0, 0, 0];
    for (let r = 0; r < mesh.numRegions; r++) {
        const ax = r_xyz[3 * r], ay = r_xyz[3 * r + 1], az = r_xyz[3 * r + 2];
        const p = r_plate[r];
        Tectonics.plateVelocity(v, plates[p].pole, plates[p].omega, [ax, ay, az]);
        appendEquirectSegment(
            line_xyz, line_rgba,
            ax, ay, az,
            ax + v[0] * scale, ay + v[1] * scale, az + v[2] * scale,
            [1, 1, 1, 1], [1, 0, 0, 0]
        );
    }
    renderLines({
        u_projection,
        u_multiply_rgba: [1, 1, 1, 1],
        u_add_rgba: [0, 0, 0, 0],
        a_xyz: line_xyz,
        a_rgba: line_rgba,
        count: line_xyz.length,
    });
}

function drawEquirectPlateBoundaries(u_projection, mesh, {t_xyz, r_plate}) {
    let line_xyz = [], line_rgba = [];
    const ink = usePlateOverlay() ? [0.06, 0.06, 0.08, 1] : [1, 1, 1, 1];
    for (let s = 0; s < mesh.numSides; s++) {
        const begin_r = mesh.s_begin_r(s),
            end_r = mesh.s_end_r(s);
        if (r_plate[begin_r] !== r_plate[end_r]) {
            const inner_t = mesh.s_inner_t(s),
                outer_t = mesh.s_outer_t(s);
            appendEquirectSegment(
                line_xyz, line_rgba,
                t_xyz[3 * inner_t], t_xyz[3 * inner_t + 1], t_xyz[3 * inner_t + 2],
                t_xyz[3 * outer_t], t_xyz[3 * outer_t + 1], t_xyz[3 * outer_t + 2],
                ink, ink
            );
        }
    }
    renderLines({
        u_projection,
        u_multiply_rgba: [1, 1, 1, 1],
        u_add_rgba: [0, 0, 0, 0],
        a_xyz: line_xyz,
        a_rgba: line_rgba,
        count: line_xyz.length,
    });
}

function drawEquirect() {
    const geo = getEquirectSurfaceGeometry();
    const overlay = usePlateOverlay();
    for (const xshift of [-2, 0, 2]) {
        const u_projection = equirectProjection(xshift);
        drawSurface(u_projection, geo.xyz, geo.tm, geo.count);
        if (!overlay && draw_plateVectors) {
            drawEquirectPlateVectors(u_projection, mesh, map);
        }
        if (overlay || draw_plateBoundaries) {
            drawEquirectPlateBoundaries(u_projection, mesh, map);
        }
    }
}

const VIEW_STORE_KEY = 'planetgen.view';
const VIEW_STORE_VERSION = 2;
let viewPersistSuspended = false;

function persistViewState() {
    if (viewPersistSuspended) return;
    try {
        sessionStorage.setItem(VIEW_STORE_KEY, JSON.stringify({
            v: VIEW_STORE_VERSION,
            zoom,
            rotation,
            drag: Array.from(dragRotation),
            viewMode,
            equirectPanX,
            equirectPanY,
            equirectZoom,
        }));
    } catch {
        /* ignore quota / private-mode failures */
    }
}

function restoreViewState() {
    let stored;
    try {
        stored = JSON.parse(sessionStorage.getItem(VIEW_STORE_KEY));
    } catch {
        return;
    }
    if (!stored || stored.v !== VIEW_STORE_VERSION) return;

    if (Number.isFinite(stored.zoom)) zoom = stored.zoom;
    if (Number.isFinite(stored.rotation)) rotation = stored.rotation;
    if (Array.isArray(stored.drag) && stored.drag.length === 16 && stored.drag.every(Number.isFinite)) {
        mat4.copy(dragRotation, stored.drag);
    }
    if (Number.isFinite(stored.equirectPanX)) equirectPanX = stored.equirectPanX;
    if (Number.isFinite(stored.equirectPanY)) equirectPanY = stored.equirectPanY;
    if (Number.isFinite(stored.equirectZoom)) equirectZoom = stored.equirectZoom;

    const slider = document.getElementById('sphere-rotation');
    if (slider && Number.isFinite(stored.rotation)) slider.value = String(stored.rotation);

    if (stored.viewMode === 'equirect' || stored.viewMode === 'globe') {
        viewMode = stored.viewMode;
        syncViewModeDom();
    }
}

function finishDraw() {
    _draw_pending = false;
    if (!viewPersistSuspended) paintLivePlateOverlay();
    persistViewState();
    if (!window.__PLANET_READY__) {
        window.__PLANET_READY__ = true;
    }
}

let _draw_pending = false;
function globeProjectionMatrix() {
    let u_projection = mat4.create();
    mat4.scale(u_projection, u_projection, [zoom, zoom, 0.5]);
    mat4.multiply(u_projection, u_projection, dragRotation);
    applyGlobeOrientation(u_projection);
    return u_projection;
}

function drawSurface(u_projection, xyz, tm, count) {
    const overlay = usePlateOverlay();
    if (drawMode === 'centroid') {
        const cmd = overlay ? renderFlatTriangles : renderTriangles;
        cmd({u_projection, a_xyz: xyz, a_tm: tm, count});
        return;
    }
    const elements = count == null ? quadGeometry.I : sequentialElements(count);
    const cmd = overlay ? renderFlatIndexed : renderIndexedTriangles;
    cmd({u_projection, a_xyz: xyz, a_tm: tm, elements});
}

function _draw() {
    regl.poll();
    regl.clear({ color: [0, 0, 0, 0], depth: 1 });
    let u_projection = globeProjectionMatrix();

    if (viewMode === 'equirect') {
        drawEquirect();
        finishDraw();
        return;
    }

    const overlay = usePlateOverlay();
    if (drawMode === 'centroid') {
        const colorFn = overlay ? overlayColorForRegion : rColorFn;
        let triangleGeometry = generateVoronoiGeometry(mesh, map, colorFn);
        drawSurface(u_projection, triangleGeometry.xyz, triangleGeometry.tm, triangleGeometry.xyz.length / 3);
    } else {
        const tm = overlay ? overlayColorTm() : quadGeometry.tm;
        drawSurface(u_projection, quadGeometry.xyz, tm);
    }

    if (!overlay) drawNorthPole(u_projection);

    if (!overlay && draw_plateVectors) {
        drawPlateVectors(u_projection, mesh, map);
    }
    if (overlay || draw_plateBoundaries) {
        drawPlateBoundaries(u_projection, mesh, map);
    }

    const rose = document.querySelector('.north-compass-rose');
    if (rose) {
        rose.style.transform = `rotate(${northHeading() * 180 / Math.PI}deg)`;
    }
    
    finishDraw();
}

/**********************************************************************
 * Terrain Diffusion handoff
 *
 * Samples the sphere onto an equirectangular grid and converts
 * planetgen units into the five GeoTIFF channels that
 * `python -m terrain_diffusion … tiff-export` expects.
 * Sketches, not a finished DEM: the coarse model is supposed to
 * rewrite local shape. Regional mid-latitude crops are the actual
 * inputs; a full-planet tiff-export at 23 km/px is hundreds of
 * gigapixels after the 256× upsample.
 */

/* The elevation scale itself is defined in ./tectonics.js, which has to map
 * metres back onto it. */
const TD_LAND_PEAK_M = Tectonics.LAND_PEAK_M;
const TD_LAND_POWER = Tectonics.LAND_POWER;
const TD_OCEAN_DEPTH_M = Tectonics.OCEAN_DEPTH_M;
const TD_OCEAN_POWER = Tectonics.OCEAN_POWER;
const TD_TEMP_SCALE = 40;
const TD_TEMP_OFFSET = -15;
const TD_PRECIP_MIN = 60;
const TD_PRECIP_RANGE = 3400;
const TD_PRECIP_POWER = 1.55;
const TD_EARTH_KM = 40075.017;

const {elevationToMeters} = Tectonics;

function temperatureToC(t) {
    return Math.max(-40, Math.min(40, TD_TEMP_SCALE * t + TD_TEMP_OFFSET));
}

function moistureToPrecipMm(m) {
    return TD_PRECIP_MIN + TD_PRECIP_RANGE * Math.pow(clamp01(m), TD_PRECIP_POWER);
}

function temperatureStdC(moisture, elevationM, latRad) {
    const mid = Math.sin(2 * Math.abs(latRad));
    const inland = elevationM >= 0 ? (1 - clamp01(moisture)) : 0.12;
    return 2.4 + 14 * mid * mid * (0.35 + 0.65 * inland);
}

function precipitationCvPct(moisture, latRad) {
    const dry = 1 - clamp01(moisture);
    const seasonal = 0.45 + 0.55 * Math.abs(Math.sin(2 * latRad));
    return 16 + 58 * dry * seasonal;
}

function f32ToB64(arr) {
    const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const chunk = 0x8000;
    let s = '';
    for (let i = 0; i < u8.length; i += chunk) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
}

function lonLatOfRegion(r, lon0) {
    const x = map.r_xyz[3 * r], y = map.r_xyz[3 * r + 1], z = map.r_xyz[3 * r + 2];
    let lon = Math.atan2(y, x) - lon0;
    while (lon < -PI) lon += TWO_PI;
    while (lon > PI) lon -= TWO_PI;
    const lat = Math.asin(Math.max(-1, Math.min(1, z)));
    return {lon, lat, e: map.r_elevation[r], m: map.r_moisture[r], t: map.r_temperature[r]};
}

function unwrapTriangleLons(a, b, c) {
    const pts = [
        {lon: a.lon, lat: a.lat, e: a.e, m: a.m, t: a.t},
        {lon: b.lon, lat: b.lat, e: b.e, m: b.m, t: b.t},
        {lon: c.lon, lat: c.lat, e: c.e, m: c.m, t: c.t},
    ];
    for (let i = 1; i < 3; i++) {
        while (pts[i].lon - pts[0].lon > PI) pts[i].lon -= TWO_PI;
        while (pts[0].lon - pts[i].lon > PI) pts[i].lon += TWO_PI;
    }
    return pts;
}

function rasterizeTriangle(elev, moist, temp, filled, width, height, toPixel, a, b, c) {
    const pa = toPixel(a), pb = toPixel(b), pc = toPixel(c);
    const minX = Math.max(0, Math.floor(Math.min(pa.x, pb.x, pc.x)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(pa.x, pb.x, pc.x)));
    const minY = Math.max(0, Math.floor(Math.min(pa.y, pb.y, pc.y)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(pa.y, pb.y, pc.y)));
    if (maxX < minX || maxY < minY) return;

    const v0x = pb.x - pa.x, v0y = pb.y - pa.y;
    const v1x = pc.x - pa.x, v1y = pc.y - pa.y;
    const den = v0x * v1y - v1x * v0y;
    if (Math.abs(den) < 1e-12) return;

    for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5;
            const v2x = px - pa.x, v2y = py - pa.y;
            const v = (v2x * v1y - v1x * v2y) / den;
            const w = (v0x * v2y - v2x * v0y) / den;
            const u = 1 - v - w;
            if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;
            const i = y * width + x;
            elev[i] = u * a.e + v * b.e + w * c.e;
            moist[i] = u * a.m + v * b.m + w * c.m;
            temp[i] = u * a.t + v * b.t + w * c.t;
            filled[i] = 1;
        }
    }
}

function fillRasterHoles(elev, moist, temp, filled, width, height) {
    const q = [];
    for (let i = 0; i < filled.length; i++) {
        if (filled[i]) q.push(i);
    }
    if (!q.length) return;
    const dirs = [-1, 1, -width, width];
    for (let qi = 0; qi < q.length; qi++) {
        const i = q[qi];
        const x = i % width;
        for (const d of dirs) {
            if (d === -1 && x === 0) continue;
            if (d === 1 && x === width - 1) continue;
            const n = i + d;
            if (n < 0 || n >= filled.length || filled[n]) continue;
            elev[n] = elev[i];
            moist[n] = moist[i];
            temp[n] = temp[i];
            filled[n] = 1;
            q.push(n);
        }
    }
}

function rasterizeSphereGrid(width, height, toPixel, lon0, wrapShifts) {
    const elev = new Float32Array(width * height);
    const moist = new Float32Array(width * height);
    const temp = new Float32Array(width * height);
    const filled = new Uint8Array(width * height);
    const {numTriangles} = mesh;
    for (let t = 0; t < numTriangles; t++) {
        const r1 = mesh.s_begin_r(3 * t);
        const r2 = mesh.s_begin_r(3 * t + 1);
        const r3 = mesh.s_begin_r(3 * t + 2);
        const tri = unwrapTriangleLons(
            lonLatOfRegion(r1, lon0),
            lonLatOfRegion(r2, lon0),
            lonLatOfRegion(r3, lon0),
        );
        const minL = Math.min(tri[0].lon, tri[1].lon, tri[2].lon);
        const maxL = Math.max(tri[0].lon, tri[1].lon, tri[2].lon);
        const shifts = wrapShifts(minL, maxL);
        for (const shift of shifts) {
            const a = {lon: tri[0].lon + shift, lat: tri[0].lat, e: tri[0].e, m: tri[0].m, t: tri[0].t};
            const b = {lon: tri[1].lon + shift, lat: tri[1].lat, e: tri[1].e, m: tri[1].m, t: tri[1].t};
            const c = {lon: tri[2].lon + shift, lat: tri[2].lat, e: tri[2].e, m: tri[2].m, t: tri[2].t};
            rasterizeTriangle(elev, moist, temp, filled, width, height, toPixel, a, b, c);
        }
    }
    fillRasterHoles(elev, moist, temp, filled, width, height);
    return {elev, moist, temp, width, height};
}

function rasterizeEquirect(width, height, lon0) {
    return rasterizeSphereGrid(width, height, (p) => ({
        x: (p.lon + PI) / TWO_PI * width,
        y: (PI / 2 - p.lat) / PI * height,
    }), lon0, (minL, maxL) => {
        const shifts = [0];
        if (minL < -PI) shifts.push(TWO_PI);
        if (maxL > PI) shifts.push(-TWO_PI);
        return shifts;
    });
}

function rasterizeLonLatBox(westDeg, southDeg, eastDeg, northDeg, width, height, lon0) {
    const west = westDeg * PI / 180;
    const east = eastDeg * PI / 180;
    const south = southDeg * PI / 180;
    const north = northDeg * PI / 180;
    const lonSpan = east - west;
    const latSpan = north - south;
    return rasterizeSphereGrid(width, height, (p) => ({
        x: (p.lon - west) / lonSpan * width,
        y: (north - p.lat) / latSpan * height,
    }), lon0, (minL, maxL) => {
        const shifts = [0];
        if (minL < west) shifts.push(TWO_PI);
        if (maxL > east) shifts.push(-TWO_PI);
        return shifts;
    });
}

function latOfRow(y, height) {
    return (PI / 2) - (y + 0.5) / height * PI;
}

function fieldsToTdLayers(fields, width, height, latAtRow) {
    const n = width * height;
    const heightmap = new Float32Array(n);
    const temperature = new Float32Array(n);
    const temperatureStd = new Float32Array(n);
    const precipitation = new Float32Array(n);
    const precipitationCv = new Float32Array(n);
    const rowLat = latAtRow || ((y) => latOfRow(y, height));
    for (let y = 0; y < height; y++) {
        const lat = rowLat(y);
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const eM = elevationToMeters(fields.elev[i]);
            const tC = temperatureToC(fields.temp[i]);
            const m = fields.moist[i];
            heightmap[i] = eM;
            temperature[i] = tC;
            temperatureStd[i] = temperatureStdC(m, eM, lat);
            precipitation[i] = moistureToPrecipMm(m);
            precipitationCv[i] = precipitationCvPct(m, lat);
        }
    }
    return {
        heightmap,
        temperature,
        temperature_std: temperatureStd,
        precipitation,
        precipitation_cv: precipitationCv,
        width,
        height,
    };
}

function encodeTdLayers(layers) {
    return {
        width: layers.width,
        height: layers.height,
        heightmap: f32ToB64(layers.heightmap),
        temperature: f32ToB64(layers.temperature),
        temperature_std: f32ToB64(layers.temperature_std),
        precipitation: f32ToB64(layers.precipitation),
        precipitation_cv: f32ToB64(layers.precipitation_cv),
    };
}

function windowStats(layers, x0, y0, winW, winH) {
    const {width, height, heightmap, temperature, precipitation} = layers;
    let land = 0, coast = 0, n = 0;
    let eSum = 0, eSum2 = 0, eMin = Infinity, eMax = -Infinity;
    let tMin = Infinity, tMax = -Infinity, pMin = Infinity, pMax = -Infinity;
    for (let y = y0; y < y0 + winH; y++) {
        for (let x = x0; x < x0 + winW; x++) {
            const i = y * width + x;
            const e = heightmap[i];
            n++;
            if (e >= 0) {
                land++;
                eSum += e;
                eSum2 += e * e;
                if (e < eMin) eMin = e;
                if (e > eMax) eMax = e;
            }
            const t = temperature[i];
            if (t < tMin) tMin = t;
            if (t > tMax) tMax = t;
            const p = precipitation[i];
            if (p < pMin) pMin = p;
            if (p > pMax) pMax = p;
            const left = x > 0 && heightmap[i - 1] >= 0;
            const right = x + 1 < width && heightmap[i + 1] >= 0;
            const up = y > 0 && heightmap[i - width] >= 0;
            const down = y + 1 < height && heightmap[i + width] >= 0;
            const here = e >= 0;
            if (here !== left || here !== right || here !== up || here !== down) coast++;
        }
    }
    const landFrac = land / n;
    const mean = land ? eSum / land : 0;
    const elevStd = land > 1 ? Math.sqrt(Math.max(0, eSum2 / land - mean * mean)) : 0;
    return {
        x: x0,
        y: y0,
        landFrac,
        coastFrac: coast / n,
        elevStd,
        elevRange: land ? eMax - eMin : 0,
        tempRange: tMax - tMin,
        precipRange: pMax - pMin,
    };
}

function pickTdCrops(layers, opts) {
    const {width, height} = layers;
    const winW = Math.max(8, Math.min(width, opts.winW));
    const winH = Math.max(6, Math.min(height, opts.winH));
    const stepX = Math.max(1, Math.floor(winW / 3));
    const stepY = Math.max(1, Math.floor(winH / 3));
    const yMargin = Math.floor(height * (40 / 180));
    const scored = [];
    for (let y = yMargin; y + winH <= height - yMargin; y += stepY) {
        for (let x = stepX; x + winW <= width - stepX; x += stepX) {
            const s = windowStats(layers, x, y, winW, winH);
            if (s.landFrac < 0.22 || s.landFrac > 0.92) continue;
            scored.push(s);
        }
    }
    if (!scored.length) return [];

    const picks = [];
    function takeBest(name, scoreFn) {
        let best = null, bestScore = -Infinity;
        for (const s of scored) {
            if (picks.some((p) => Math.abs(p.x - s.x) < winW * 0.85 && Math.abs(p.y - s.y) < winH * 0.85)) {
                continue;
            }
            const score = scoreFn(s);
            if (score > bestScore) {
                bestScore = score;
                best = s;
            }
        }
        if (best) picks.push({name, ...best, winW, winH});
    }

    takeBest('coast', (s) => (
        s.coastFrac * 2
        + Math.min(s.landFrac, 1 - s.landFrac) * 1.4
        + s.elevStd / 700
        + s.elevRange / 2800
    ));
    takeBest('mountains', (s) => s.elevStd / 800 + s.elevRange / 4000 + s.landFrac);
    takeBest('climate', (s) => s.tempRange / 20 + s.precipRange / 2500 + s.coastFrac + s.elevRange / 5000);
    return picks.slice(0, opts.count);
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function lerpRgb(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function elevRgb(m) {
    if (m < 0) {
        const t = Math.min(1, -m / TD_OCEAN_DEPTH_M);
        return lerpRgb([72, 130, 176], [12, 28, 58], t);
    }
    const t = Math.min(1, m / TD_LAND_PEAK_M);
    if (t < 0.35) return lerpRgb([92, 148, 78], [196, 196, 118], t / 0.35);
    if (t < 0.7) return lerpRgb([196, 196, 118], [142, 104, 64], (t - 0.35) / 0.35);
    return lerpRgb([142, 104, 64], [244, 244, 248], (t - 0.7) / 0.3);
}

function tempRgb(c) {
    const t = Math.max(0, Math.min(1, (c + 20) / 50));
    if (t < 0.5) return lerpRgb([40, 70, 170], [240, 240, 240], t / 0.5);
    return lerpRgb([240, 240, 240], [190, 40, 30], (t - 0.5) / 0.5);
}

function precipRgb(mm) {
    const t = Math.max(0, Math.min(1, Math.sqrt(mm / 3200)));
    if (t < 0.5) return lerpRgb([214, 196, 150], [120, 168, 92], t / 0.5);
    return lerpRgb([120, 168, 92], [28, 92, 150], (t - 0.5) / 0.5);
}

function hillshade(elev, width, height) {
    const out = new Float32Array(width * height);
    const zenith = 45 * Math.PI / 180;
    const azimuth = 315 * Math.PI / 180;
    const zcos = Math.cos(zenith), zsin = Math.sin(zenith);
    const cell = 220;
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
            let shade = zcos * Math.cos(slope) + zsin * Math.sin(slope) * Math.cos(azimuth - aspect);
            out[y * width + x] = Math.max(0.15, Math.min(1, shade));
        }
    }
    return out;
}

function putLayerRgb(ctx, x, y, width, height, rgbAt, shade) {
    const img = ctx.createImageData(width, height);
    for (let i = 0, p = 0; i < width * height; i++, p += 4) {
        const c = rgbAt(i);
        const s = shade ? 0.42 + 0.58 * shade[i] : 1;
        img.data[p] = Math.round(c[0] * s);
        img.data[p + 1] = Math.round(c[1] * s);
        img.data[p + 2] = Math.round(c[2] * s);
        img.data[p + 3] = 255;
    }
    ctx.putImageData(img, x, y);
}

function drawLabeled(ctx, x, y, title) {
    ctx.fillStyle = '#111';
    ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText(title, x, y - 6);
}

function upsampleBilinear(src, srcW, srcH, dstW, dstH) {
    const dst = new Float32Array(dstW * dstH);
    for (let y = 0; y < dstH; y++) {
        const fy = (y + 0.5) * srcH / dstH - 0.5;
        const y0 = Math.max(0, Math.floor(fy));
        const y1 = Math.min(srcH - 1, y0 + 1);
        const ty = Math.max(0, Math.min(1, fy - y0));
        for (let x = 0; x < dstW; x++) {
            const fx = (x + 0.5) * srcW / dstW - 0.5;
            const x0 = Math.max(0, Math.floor(fx));
            const x1 = Math.min(srcW - 1, x0 + 1);
            const tx = Math.max(0, Math.min(1, fx - x0));
            const a = src[y0 * srcW + x0];
            const b = src[y0 * srcW + x1];
            const c = src[y1 * srcW + x0];
            const d = src[y1 * srcW + x1];
            dst[y * dstW + x] = lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
        }
    }
    return dst;
}

function canvasPng(canvas) {
    return canvas.toDataURL('image/png');
}

function drawWorldSheet(world, crops, cropLayers) {
    const w = world.width, h = world.height;
    const gap = 16;
    const label = 28;
    const cropScale = 6;
    const cropW = crops.length ? cropLayers[0].width * cropScale : 0;
    const cropH = crops.length ? cropLayers[0].height * cropScale : 0;
    const canvas = document.createElement('canvas');
    canvas.width = w * 2 + gap;
    canvas.height = label + h + gap + label + h + gap + label + cropH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const shade = hillshade(world.heightmap, w, h);
    drawLabeled(ctx, 0, label, 'Coarse elevation (hypsometric + hillshade)');
    putLayerRgb(ctx, 0, label, w, h, (i) => elevRgb(world.heightmap[i]), shade);
    drawLabeled(ctx, w + gap, label, 'Temperature (°C)');
    putLayerRgb(ctx, w + gap, label, w, h, (i) => tempRgb(world.temperature[i]), null);

    const row2 = label + h + gap + label;
    drawLabeled(ctx, 0, row2, 'Precipitation (mm / yr)');
    putLayerRgb(ctx, 0, row2, w, h, (i) => precipRgb(world.precipitation[i]), null);
    drawLabeled(ctx, w + gap, row2, 'Crop windows on elevation');
    putLayerRgb(ctx, w + gap, row2, w, h, (i) => elevRgb(world.heightmap[i]), shade);

    ctx.lineWidth = 2;
    const colors = ['#f5d90a', '#ff5a36', '#5ad2ff'];
    crops.forEach((crop, i) => {
        ctx.strokeStyle = colors[i % colors.length];
        ctx.lineWidth = 2;
        ctx.strokeRect(w + gap + crop.x + 0.5, row2 + crop.y + 0.5, crop.winW, crop.winH);
        const lx = w + gap + crop.x + 3;
        const ly = row2 + Math.max(2, crop.y - 16);
        ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
        const tw = ctx.measureText(crop.name).width;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(lx - 2, ly - 1, tw + 6, 16);
        ctx.fillStyle = colors[i % colors.length];
        ctx.textBaseline = 'top';
        ctx.fillText(crop.name, lx, ly);
    });

    const row3 = row2 + h + gap + label;
    crops.forEach((crop, i) => {
        const layers = cropLayers[i];
        const upE = upsampleBilinear(layers.heightmap, layers.width, layers.height, cropW, cropH);
        const upShade = hillshade(upE, cropW, cropH);
        const x = i * (cropW + gap);
        drawLabeled(ctx, x, row3, `Crop “${crop.name}”  ${layers.width}×${layers.height} coarse cells`);
        putLayerRgb(ctx, x, row3, cropW, cropH, (j) => elevRgb(upE[j]), upShade);
        ctx.strokeStyle = colors[i % colors.length];
        ctx.strokeRect(x + 0.5, row3 + 0.5, cropW - 1, cropH - 1);
    });
    return canvasPng(canvas);
}

function drawCropPreview(layers, name) {
    const scale = 8;
    const w = layers.width * scale;
    const h = layers.height * scale;
    const gap = 12;
    const label = 26;
    const canvas = document.createElement('canvas');
    canvas.width = w * 3 + gap * 2;
    canvas.height = label + h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const upE = upsampleBilinear(layers.heightmap, layers.width, layers.height, w, h);
    const upT = upsampleBilinear(layers.temperature, layers.width, layers.height, w, h);
    const upP = upsampleBilinear(layers.precipitation, layers.width, layers.height, w, h);
    const shade = hillshade(upE, w, h);
    drawLabeled(ctx, 0, label, `${name} elevation`);
    putLayerRgb(ctx, 0, label, w, h, (i) => elevRgb(upE[i]), shade);
    drawLabeled(ctx, w + gap, label, 'temperature');
    putLayerRgb(ctx, w + gap, label, w, h, (i) => tempRgb(upT[i]), null);
    drawLabeled(ctx, (w + gap) * 2, label, 'precipitation');
    putLayerRgb(ctx, (w + gap) * 2, label, w, h, (i) => precipRgb(upP[i]), null);
    return canvasPng(canvas);
}

function pixelBounds(x, y, winW, winH, width, height) {
    const west = -180 + x / width * 360;
    const east = -180 + (x + winW) / width * 360;
    const north = 90 - y / height * 180;
    const south = 90 - (y + winH) / height * 180;
    return {west, south, east, north};
}

function exportTerrainDiffusion(opts = {}) {
    const width = Math.max(64, opts.width | 0 || 720);
    const height = Math.max(32, opts.height | 0 || 360);
    const lon0Deg = Number.isFinite(opts.lon0) ? opts.lon0 : 0;
    const lon0 = lon0Deg * PI / 180;
    const scaleKm = Number.isFinite(opts.scaleKm) ? opts.scaleKm : 23;
    const cropW = Math.max(8, opts.cropWidth | 0 || 48);
    const cropH = Math.max(6, opts.cropHeight | 0 || 32);
    const cropCount = Math.max(0, opts.crops | 0 || 3);

    const rawWorld = rasterizeEquirect(width, height, lon0);
    const world = fieldsToTdLayers(rawWorld, width, height);
    const overviewKm = TD_EARTH_KM / width;
    const winW = Math.max(8, Math.round(cropW * scaleKm * width / TD_EARTH_KM));
    const winH = Math.max(6, Math.round(cropH * scaleKm * 2 * height / TD_EARTH_KM));
    const picks = pickTdCrops(world, {winW, winH, count: cropCount});

    const crops = picks.map((pick) => {
        const bounds = pixelBounds(pick.x, pick.y, pick.winW, pick.winH, width, height);
        const southRad = bounds.south * PI / 180;
        const northRad = bounds.north * PI / 180;
        const raw = rasterizeLonLatBox(bounds.west, bounds.south, bounds.east, bounds.north, cropW, cropH, lon0);
        const layers = fieldsToTdLayers(raw, cropW, cropH, (row) => (
            northRad - (row + 0.5) / cropH * (northRad - southRad)
        ));
        return {
            name: pick.name,
            x: pick.x,
            y: pick.y,
            winW: pick.winW,
            winH: pick.winH,
            landFrac: pick.landFrac,
            ...bounds,
            layers,
            previewPng: drawCropPreview(layers, pick.name),
        };
    });

    return {
        seed,
        n: N,
        plates: P,
        width,
        height,
        lon0: lon0Deg,
        scaleKm,
        overviewKm,
        world: encodeTdLayers(world),
        worldPreviewPng: drawWorldSheet(world, picks, crops.map((c) => c.layers)),
        crops: crops.map((crop) => ({
            name: crop.name,
            west: crop.west + lon0Deg,
            south: crop.south,
            east: crop.east + lon0Deg,
            north: crop.north,
            landFrac: crop.landFrac,
            width: cropW,
            height: cropH,
            scaleKm,
            layers: encodeTdLayers(crop.layers),
            previewPng: crop.previewPng,
        })),
    };
}

window.exportPlanetPreview = function exportPlanetPreview() {
    return exportPreview('globe');
};

window.exportEquirectPreview = function exportEquirectPreview(lon0) {
    return exportPreview('equirect', {lon0});
};

window.exportPreview = exportPreview;
window.exportTerrainDiffusion = exportTerrainDiffusion;

function exportPreview(view, opts = {}) {
    viewPersistSuspended = true;
    const savedBoundaries = draw_plateBoundaries;
    const savedVectors = draw_plateVectors;
    const savedOverlay = previewOverlay;
    const overlay = opts.overlay || (opts.plates ? 'plates' : null);
    previewOverlay = overlay;
    if (overlay) {
        draw_plateBoundaries = true;
        draw_plateVectors = false;
    }
    try {
        if (view === 'globe') return captureGlobePreview(overlay);
        if (view === 'equirect') return captureEquirectPreview(opts.lon0, overlay);
        throw new Error(`unknown preview view: ${view}`);
    } finally {
        draw_plateBoundaries = savedBoundaries;
        draw_plateVectors = savedVectors;
        previewOverlay = savedOverlay;
        viewPersistSuspended = false;
    }
}

const PLATE_ARROW_SCALE = 0.38;
const OVERLAY_LEGEND = {
    plates: 'color = plate   dark = underwater   arrow = motion   age = time since the plate formed',
    crust: 'sea floor: pale = young, dark = old   land: red = orogeny   ' +
           'orange = ridge   cyan = trench   yellow = transform',
    climate: 'moisture only: sand = arid   olive = steppe   green = forest   teal = saturated',
};

function projectGlobePoint(xyz, projection) {
    const p = vec4.transformMat4([], [xyz[0], xyz[1], xyz[2], 1], projection);
    const w = p[3] || 1;
    return {x: p[0] / w, y: p[1] / w, z: p[2] / w, front: p[2] / w <= 0.02};
}

function clipToCanvas(clip, width, height) {
    return {
        x: (clip.x * 0.5 + 0.5) * width,
        y: (-clip.y * 0.5 + 0.5) * height,
        front: clip.front,
    };
}

function projectEquirectPoint(xyz, xshift) {
    const lon = Math.atan2(xyz[1], xyz[0]) + xshift * Math.PI;
    const lat = Math.asin(Math.max(-1, Math.min(1, xyz[2])));
    const x = ((lon / Math.PI) + equirectPanX) * equirectZoom;
    const y = ((2 * lat / Math.PI) + equirectPanY) * equirectZoom;
    return {x, y, z: -0.5, front: true};
}

function strokeArrow(ctx, x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 10) return;
    const ux = dx / len, uy = dy / len;
    const head = Math.min(16, len * 0.32);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - ux * head + uy * head * 0.55, y1 - uy * head - ux * head * 0.55);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - ux * head - uy * head * 0.55, y1 - uy * head + ux * head * 0.55);
    ctx.stroke();
}

function drawHaloLabel(ctx, text, x, y) {
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
}

function paintPlateAnnotations(ctx, width, height, mode, projection, xshift = 0) {
    if (!map.plates || !map.plate_centroid) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 15px ui-sans-serif, system-ui, sans-serif';
    ctx.strokeStyle = '#111111';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 4;

    const toCanvas = (xyz) => {
        const clip = mode === 'globe'
            ? projectGlobePoint(xyz, projection)
            : projectEquirectPoint(xyz, xshift);
        return clipToCanvas(clip, width, height);
    };

    /* Only label plates big enough for the name to belong to something. */
    const area = new Int32Array(map.plates.length);
    for (let r = 0; r < mesh.numRegions; r++) area[map.r_plate[r]]++;

    for (let p = 0; p < map.plates.length; p++) {
        const plate = map.plates[p];
        const c = map.plate_centroid[p];
        if (!c || area[p] / mesh.numRegions < 0.012) continue;
        /* velocity at the plate's own centroid, so the arrow shows where
           that plate is actually going and how fast */
        const v = Tectonics.plateVelocity([], plate.pole, plate.omega, c);
        vec3.scale(v, v, 1 / PLATE_ARROW_REFERENCE_OMEGA);
        const start = toCanvas(c);
        if (!Number.isFinite(start.x) || !Number.isFinite(start.y)) continue;
        if (mode === 'globe' && !start.front) continue;
        if (start.x < -40 || start.x > width + 40 || start.y < -40 || start.y > height + 40) continue;
        start.x = Math.min(width - 16, Math.max(16, start.x));
        start.y = Math.min(height - 16, Math.max(16, start.y));

        const tip = [
            c[0] + v[0] * PLATE_ARROW_SCALE,
            c[1] + v[1] * PLATE_ARROW_SCALE,
            c[2] + v[2] * PLATE_ARROW_SCALE,
        ];
        let end = toCanvas(tip);
        if (mode === 'equirect' && Math.abs(end.x - start.x) > width * 0.5) {
            const shift = end.x > start.x ? -width : width;
            ctx.lineWidth = 6;
            ctx.strokeStyle = '#111111';
            strokeArrow(ctx, start.x, start.y, end.x + shift, start.y + (end.y - start.y));
            strokeArrow(ctx, start.x - shift, start.y, end.x, end.y);
            ctx.lineWidth = 2.4;
            ctx.strokeStyle = '#ffe14a';
            strokeArrow(ctx, start.x, start.y, end.x + shift, start.y + (end.y - start.y));
            strokeArrow(ctx, start.x - shift, start.y, end.x, end.y);
        } else {
            let dx = end.x - start.x, dy = end.y - start.y;
            let len = Math.hypot(dx, dy);
            if (len < 22 && len > 0.5) {
                const s = 22 / len;
                end = {x: start.x + dx * s, y: start.y + dy * s, front: end.front};
            }
            ctx.lineWidth = 6;
            ctx.strokeStyle = '#111111';
            strokeArrow(ctx, start.x, start.y, end.x, end.y);
            ctx.lineWidth = 2.4;
            ctx.strokeStyle = '#ffe14a';
            strokeArrow(ctx, start.x, start.y, end.x, end.y);
        }

        ctx.lineWidth = 4;
        ctx.strokeStyle = '#111111';
        ctx.fillStyle = '#ffffff';
        drawHaloLabel(ctx, plate.name, start.x, start.y - 13);
        /* how long this plate has existed, which is not the age of its crust */
        if (plate.bornMyr > 0) {
            ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
            drawHaloLabel(ctx, `${(map.elapsedMyr - plate.bornMyr).toFixed(0)} Myr`, start.x, start.y + 13);
            ctx.font = '700 15px ui-sans-serif, system-ui, sans-serif';
        }
    }
    ctx.restore();
}

function plateAnnotCanvas() {
    let el = document.getElementById('plate-overlay');
    if (el) return el;
    const src = document.getElementById('output');
    if (!src || !src.parentElement) return null;
    el = document.createElement('canvas');
    el.id = 'plate-overlay';
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.pointerEvents = 'none';
    const parent = src.parentElement;
    if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
    }
    src.insertAdjacentElement('afterend', el);
    return el;
}

function paintLivePlateOverlay() {
    const overlay = plateAnnotCanvas();
    const src = document.getElementById('output');
    if (!overlay || !src) return;
    if (!usePlateOverlay()) {
        if (overlay.width !== 1 || overlay.height !== 1) {
            overlay.width = 1;
            overlay.height = 1;
        }
        overlay.style.display = 'none';
        return;
    }
    overlay.style.display = 'block';
    if (overlay.width !== src.width) overlay.width = src.width;
    if (overlay.height !== src.height) overlay.height = src.height;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (viewMode === 'equirect') {
        for (const shift of [-2, 0, 2]) {
            paintPlateAnnotations(ctx, overlay.width, overlay.height, 'equirect', null, shift);
        }
    } else {
        paintPlateAnnotations(ctx, overlay.width, overlay.height, 'globe', globeProjectionMatrix());
    }
}

function captureGlobePreview(overlay) {
    const src = document.getElementById('output');
    const savedMode = viewMode;
    applyViewMode('globe');
    const cell = 512;
    const labelH = 28;
    const legendH = overlay ? 30 : 0;
    const yaws = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
    const labels = ['0', '90', '180', '270'];
    const sheet = document.createElement('canvas');
    sheet.width = cell * 2;
    sheet.height = (cell + labelH) * 2 + legendH;
    const ctx = sheet.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    ctx.fillStyle = '#111111';
    ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    const savedYaw = previewYaw;
    const savedZoom = zoom;
    const savedDrag = mat4.clone(dragRotation);
    mat4.identity(dragRotation);
    zoom = 1;

    const annotated = document.createElement('canvas');
    annotated.width = src.width;
    annotated.height = src.height;
    const actx = annotated.getContext('2d');

    for (let i = 0; i < yaws.length; i++) {
        previewYaw = yaws[i];
        _draw();
        regl._gl.finish();
        const x = (i % 2) * cell;
        const y = Math.floor(i / 2) * (cell + labelH);
        ctx.fillStyle = '#111111';
        ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(`${labels[i]} deg`, x + 10, y + labelH / 2);
        if (overlay) {
            actx.clearRect(0, 0, annotated.width, annotated.height);
            actx.drawImage(src, 0, 0);
            if (overlay === 'plates') paintPlateAnnotations(actx, src.width, src.height, 'globe', globeProjectionMatrix());
            ctx.drawImage(annotated, x, y + labelH, cell, cell);
        } else {
            ctx.drawImage(src, x, y + labelH, cell, cell);
        }
    }

    if (overlay) {
        ctx.fillStyle = '#111111';
        ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(OVERLAY_LEGEND[overlay], 10, sheet.height - legendH / 2);
    }

    previewYaw = savedYaw;
    zoom = savedZoom;
    mat4.copy(dragRotation, savedDrag);
    applyViewMode(savedMode);
    draw();
    return sheet.toDataURL('image/png');
}

function captureEquirectPreview(lon0, overlay) {
    const src = document.getElementById('output');
    const savedMode = viewMode;
    const savedPanX = equirectPanX;
    const savedPanY = equirectPanY;
    const savedZoom = equirectZoom;
    applyViewMode('equirect');
    const deg = Number(lon0);
    equirectPanX = wrapPanX(Number.isFinite(deg) ? -(deg / 180) : 0);
    equirectPanY = 0;
    equirectZoom = 1;
    _draw();
    regl._gl.finish();

    let dataUrl;
    if (!overlay) {
        dataUrl = src.toDataURL('image/png');
    } else {
        const legendH = 32;
        const annotated = document.createElement('canvas');
        annotated.width = src.width;
        annotated.height = src.height;
        const octx = annotated.getContext('2d');
        octx.drawImage(src, 0, 0);
        if (overlay === 'plates') paintPlateAnnotations(octx, src.width, src.height, 'equirect');

        const out = document.createElement('canvas');
        out.width = src.width;
        out.height = src.height + legendH;
        const ctx = out.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.fillStyle = '#111111';
        ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(OVERLAY_LEGEND[overlay], 10, legendH / 2);
        ctx.drawImage(annotated, 0, legendH);
        dataUrl = out.toDataURL('image/png');
    }

    equirectPanX = savedPanX;
    equirectPanY = savedPanY;
    equirectZoom = savedZoom;
    applyViewMode(savedMode);
    return dataUrl;
}

function draw() {
    if (!_draw_pending) {
        _draw_pending = true;
        requestAnimationFrame(_draw);
    }
}

function setupDragRotation() {
    const canvas = document.getElementById('output');
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
    canvas.style.userSelect = 'none';

    const ZOOM_MIN = 0.4;
    const ZOOM_MAX = 8;
    const pointers = new Map();
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let pinchStartDist = 0;
    let pinchStartZoom = 1;

    function clampZoom(value) {
        return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    }

    function clampEquirectPanY() {
        const maxPan = Math.max(0, 1 - 1 / equirectZoom);
        equirectPanY = Math.min(maxPan, Math.max(-maxPan, equirectPanY));
    }

    function currentZoom() {
        return viewMode === 'equirect' ? equirectZoom : zoom;
    }

    function setCurrentZoom(value) {
        if (viewMode === 'equirect') {
            equirectZoom = clampZoom(value);
            clampEquirectPanY();
        } else {
            zoom = clampZoom(value);
        }
    }

    function pointerDistance() {
        const pts = Array.from(pointers.values());
        return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }

    canvas.addEventListener('pointerdown', (event) => {
        viewAnimId += 1;
        pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
        if (pointers.size === 2) {
            dragging = false;
            canvas.style.cursor = 'grab';
            pinchStartDist = pointerDistance();
            pinchStartZoom = currentZoom();
            return;
        }
        if (event.button !== 0) return;
        dragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
        canvas.setPointerCapture(event.pointerId);
        canvas.style.cursor = 'grabbing';
        event.preventDefault();
    });

    canvas.addEventListener('pointermove', (event) => {
        if (pointers.has(event.pointerId)) {
            pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
        }
        if (pointers.size === 2 && pinchStartDist > 0) {
            setCurrentZoom(pinchStartZoom * (pointerDistance() / pinchStartDist));
            draw();
            return;
        }
        if (!dragging) return;
        const rect = canvas.getBoundingClientRect();
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;

        if (viewMode === 'equirect') {
            equirectPanX = wrapPanX(equirectPanX + (dx / rect.width) * 2 / equirectZoom);
            equirectPanY += (-dy / rect.height) * 2 / equirectZoom;
            clampEquirectPanY();
            draw();
            return;
        }

        const size = Math.max(rect.width, rect.height);
        const rx = dx / size * Math.PI * 2;
        const ry = dy / size * Math.PI * 2;
        const delta = mat4.create();
        mat4.rotateX(delta, delta, -ry);
        mat4.rotateY(delta, delta, -rx);
        mat4.multiply(dragRotation, delta, dragRotation);
        draw();
    });

    function endDrag(event) {
        pointers.delete(event.pointerId);
        if (pointers.size === 1) {
            const remaining = pointers.values().next().value;
            lastX = remaining.x;
            lastY = remaining.y;
            dragging = true;
            canvas.style.cursor = 'grabbing';
            return;
        }
        dragging = false;
        pinchStartDist = 0;
        canvas.style.cursor = 'grab';
    }

    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        setCurrentZoom(currentZoom() * Math.exp(-event.deltaY * 0.002));
        draw();
    }, {passive: false});
}

setupDragRotation();
document.querySelector('.north-compass')?.addEventListener('click', reorientNorth);
document.querySelector('.view-reset')?.addEventListener('click', resetView);
document.querySelector('.view-mode-toggle')?.addEventListener('click', () => {
    applyViewMode(viewMode === 'globe' ? 'equirect' : 'globe');
});
restoreViewState();
setupSavedSeeds();
applySeed(seed);
syncSeedHistoryButtons();
generateMesh();
document.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    const key = event.key.toLowerCase();
    if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) window.redoSeed();
        else window.undoSeed();
    } else if (key === 'y' && !event.shiftKey) {
        event.preventDefault();
        window.redoSeed();
    }
});
