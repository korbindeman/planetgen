/*
 * From https://www.redblobgames.com/x/1843-planet-generation/
 * Copyright 2018 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Adapting mapgen4 code for a sphere. Quick & dirty, for procjam2018
 */

const SEED = 123;
const LAND_ICE = 0.28;
const SEA_ICE = 0.18;
const LAPSE = 0.55;
const INLAND_SCALE = 16;

const SimplexNoise = require('simplex-noise');
const colormap = require('./colormap');
const {vec3, mat4, quat} = require('gl-matrix');
const {makeRandInt, makeRandFloat} = require('@redblobgames/prng');
const SphereMesh = require('./sphere-mesh');

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
  float alpine = smoothstep(0.32, 0.78, elev);
  biome = mix(biome, rock, alpine * t * 0.5);
  biome = mix(biome, snow, alpine * (1.0 - t) * 0.85);
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
let previewYaw = 0;
let mapId = 0;
let equirectPanX = 0;
let equirectPanY = 0;
let equirectZoom = 1;

window.__PLANET_READY__ = false;

window.setN = newN => { N = newN; generateMesh(); };
window.setP = newP => { P = newP; generateMap(); };
window.setJitter = newJitter => { jitter = newJitter; generateMesh(); };
window.setRotation = newRotation => { rotation = newRotation; draw(); };
window.setDrawMode = newMode => { drawMode = newMode; draw(); };
window.setViewMode = newMode => { applyViewMode(newMode); };
window.setDrawPlateVectors = flag => { draw_plateVectors = flag; draw(); };
window.setDrawPlateBoundaries = flag => { draw_plateBoundaries = flag; draw(); };

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

/**********************************************************************
 * Geometry
 */

let _randomNoise = new SimplexNoise(makeRandFloat(SEED));
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

function pickRandomRegions(mesh, N, randInt) {
    let {numRegions} = mesh;
    let chosen_r = new Set();
    while (chosen_r.size < N && chosen_r.size < numRegions) {
        chosen_r.add(randInt(numRegions));
    }
    return chosen_r;
}


function generatePlates(mesh, r_xyz) {
    let r_plate = new Int32Array(mesh.numRegions);
    r_plate.fill(-1);
    let plate_r = pickRandomRegions(mesh, Math.min(P, N), makeRandInt(SEED));
    let queue = Array.from(plate_r);
    for (let r of queue) { r_plate[r] = r; }
    let out_r = [];
    const randInt = makeRandInt(SEED);

    /* In Breadth First Search (BFS) the queue will be all elements in
       queue[queue_out ... queue.length-1]. Pushing onto the queue
       adds an element to the end, increasing queue.length. Popping
       from the queue removes an element from the beginning by
       increasing queue_out.

       To add variety, use a random search instead of a breadth first
       search. The frontier of elements to be expanded is still
       queue[queue_out ... queue.length-1], but pick a random element
       to pop instead of the earliest one. Do this by swapping
       queue[pos] and queue[queue_out].
    */
    
    for (let queue_out = 0; queue_out < queue.length; queue_out++) {
        let pos = queue_out + randInt(queue.length - queue_out);
        let current_r = queue[pos];
        queue[pos] = queue[queue_out];
        mesh.r_circulate_r(out_r, current_r);
        for (let neighbor_r of out_r) {
            if (r_plate[neighbor_r] === -1) {
                r_plate[neighbor_r] = r_plate[current_r];
                queue.push(neighbor_r);
            }
        }
    }

    // Assign a random movement vector for each plate
    let plate_vec = [];
    for (let center_r of plate_r) {
        let neighbor_r = mesh.r_circulate_r([], center_r)[0];
        let p0 = r_xyz.slice(3 * center_r, 3 * center_r + 3),
            p1 = r_xyz.slice(3 * neighbor_r, 3 * neighbor_r + 3);
        plate_vec[center_r] = vec3.normalize([], vec3.subtract([], p1, p0));
    }

    return {plate_r, r_plate, plate_vec};
}


/* Distance from any point in seeds_r to all other points, but 
 * don't go past any point in stop_r */
function assignDistanceField(mesh, seeds_r, stop_r) {
    const randInt = makeRandInt(SEED);
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
                ocean_r.add(current_r);
            } else if (!plate_is_ocean.has(current_plate) && !plate_is_ocean.has(best_plate)) {
                if (collided) mountain_r.add(current_plate);
            } else {
                (collided? mountain_r : coastline_r).add(current_r);
            }
        }
    }
    return {mountain_r, coastline_r, ocean_r};
}


function assignRegionElevation(mesh, {r_xyz, plate_is_ocean, r_plate, plate_vec, /* out */ r_elevation}) {
    const epsilon = 1e-3;
    let {numRegions} = mesh;

    let {mountain_r, coastline_r, ocean_r} = findCollisions(
        mesh, r_xyz, plate_is_ocean, r_plate, plate_vec);

    for (let r = 0; r < numRegions; r++) {
        if (r_plate[r] === r) {
            (plate_is_ocean.has(r)? ocean_r : coastline_r).add(r);
        }
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

    flattenOceanBathymetry(mesh, {r_xyz, r_plate, plate_is_ocean, r_elevation, mountain_r});
}


const ABYSS = -0.4;
const SHELF_WIDTH = 8;

function flattenOceanBathymetry(mesh, {r_xyz, r_plate, plate_is_ocean, r_elevation, mountain_r}) {
    const {numRegions} = mesh;
    const land_r = new Set();
    for (let r = 0; r < numRegions; r++) {
        const oceanPlate = plate_is_ocean.has(r_plate[r]);
        if (r_elevation[r] >= 0 && (!oceanPlate || mountain_r.has(r))) {
            land_r.add(r);
        }
    }
    if (land_r.size === 0) return;

    const r_dist = assignDistanceField(mesh, land_r, new Set());
    for (let r = 0; r < numRegions; r++) {
        if (land_r.has(r)) continue;
        const d = r_dist[r];
        let t = (d === Infinity) ? 1 : Math.min(1, d / SHELF_WIDTH);
        t = t * t * (3 - 2 * t);
        const n = 0.02 * _randomNoise.noise3D(r_xyz[3*r], r_xyz[3*r+1], r_xyz[3*r+2]);
        r_elevation[r] = ABYSS * t + n;
        if (r_elevation[r] >= 0) r_elevation[r] = -0.02;
    }
}


function smoothField(mesh, values, land, iterations) {
    const {numRegions} = mesh;
    const next = new Float32Array(numRegions);
    const neighbors = [];
    for (let iter = 0; iter < iterations; iter++) {
        for (let r = 0; r < numRegions; r++) {
            mesh.r_circulate_r(neighbors, r);
            let sum = values[r];
            let count = 1;
            for (let n of neighbors) {
                if (!land || land[n] === land[r]) {
                    sum += values[n];
                    count++;
                }
            }
            next[r] = sum / count;
        }
        values.set(next);
    }
}


function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}

function latitudeMoisture(lat) {
    const deg = Math.abs(lat) * 180 / Math.PI;
    const tropics = Math.exp(-((deg / 10) ** 2));
    const mid = 0.7 * Math.exp(-(((deg - 52) / 14) ** 2));
    return Math.min(1, 0.08 + 0.95 * tropics + mid);
}

function upwindFrom(px, py, pz) {
    const deg = Math.abs(Math.asin(Math.max(-1, Math.min(1, pz)))) * 180 / Math.PI;
    let ex = -py, ey = px;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) return [0, 0, 0];
    ex /= len;
    ey /= len;
    if (deg >= 30 && deg < 60) return [-ex, -ey, 0];
    return [ex, ey, 0];
}

function assignClimate(mesh, {r_xyz, r_elevation, /* out */ r_moisture, r_temperature}) {
    const {numRegions} = mesh;
    const ocean_r = new Set();
    for (let r = 0; r < numRegions; r++) {
        if (r_elevation[r] < 0) ocean_r.add(r);
    }
    const r_dist_ocean = assignDistanceField(mesh, ocean_r, new Set());
    const neighbors = [];

    for (let r = 0; r < numRegions; r++) {
        const px = r_xyz[3 * r], py = r_xyz[3 * r + 1], pz = r_xyz[3 * r + 2];
        const lat = Math.asin(Math.max(-1, Math.min(1, pz)));
        const e = r_elevation[r];
        r_temperature[r] = Math.cos(lat) - LAPSE * Math.max(0, e)
            + 0.1 * fbm_noise(px, py, pz);

        if (e < 0) {
            r_moisture[r] = 1;
            continue;
        }

        let m = latitudeMoisture(lat);
        const inland = Math.min(1, r_dist_ocean[r] / INLAND_SCALE);
        m *= 0.38 + 0.62 * (1 - inland * inland);

        const wind = upwindFrom(px, py, pz);
        mesh.r_circulate_r(neighbors, r);
        let best = r, bestDot = -Infinity;
        for (const n of neighbors) {
            const dx = r_xyz[3 * n] - px;
            const dy = r_xyz[3 * n + 1] - py;
            const dz = r_xyz[3 * n + 2] - pz;
            const dot = dx * wind[0] + dy * wind[1] + dz * wind[2];
            if (dot > bestDot) {
                bestDot = dot;
                best = n;
            }
        }
        if (best !== r) {
            m += 0.32 * Math.max(-1, Math.min(1, (e - r_elevation[best]) * 2.2));
        }

        m += 0.06 * fbm_noise(px, py, pz);
        r_moisture[r] = clamp01(m);
    }

    smoothField(mesh, r_moisture, null, 2);
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
    let result = SphereMesh.makeSphere(N, jitter, makeRandFloat(SEED));
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
    let result = generatePlates(mesh, map.r_xyz);
    map.plate_r = result.plate_r;
    map.r_plate = result.r_plate;
    map.plate_vec = result.plate_vec;
    map.plate_is_ocean = new Set();
    for (let r of map.plate_r) {
        if (makeRandInt(r)(10) < 5) {
            map.plate_is_ocean.add(r);
        }
    }
    assignRegionElevation(mesh, map);
    assignClimate(mesh, map);
    assignTriangleValues(mesh, map);

    quadGeometry.setMap(mesh, map);
    mapId++;
    equirectCache = null;
    draw();
}


function drawPlateVectors(u_projection, mesh, {r_xyz, r_plate, plate_vec}) {
    let line_xyz = [], line_rgba = [];
    
    for (let r = 0; r < mesh.numRegions; r++) {
        line_xyz.push(r_xyz.slice(3 * r, 3 * r + 3));
        line_rgba.push([1, 1, 1, 1]);
        line_xyz.push(vec3.add([], r_xyz.slice(3 * r, 3 * r + 3),
                               vec3.scale([], plate_vec[r_plate[r]], 2 / Math.sqrt(N))));
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
    for (let s = 0; s < mesh.numSides; s++) {
        let begin_r = mesh.s_begin_r(s),
            end_r = mesh.s_end_r(s);
        if (r_plate[begin_r] !== r_plate[end_r]) {
            let inner_t = mesh.s_inner_t(s),
                outer_t = mesh.s_outer_t(s);
            line_xyz.push(t_xyz.slice(3 * inner_t, 3 * inner_t + 3),
                          t_xyz.slice(3 * outer_t, 3 * outer_t + 3));
            line_rgba.push([1, 1, 1, 1], [1, 1, 1, 1]);
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
    const key = `${drawMode}:${mapId}`;
    if (equirectCache && equirectCache.key === key) return equirectCache.geo;
    let geo;
    if (drawMode === 'centroid') {
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

function drawEquirectPlateVectors(u_projection, mesh, {r_xyz, r_plate, plate_vec}) {
    let line_xyz = [], line_rgba = [];
    const scale = 2 / Math.sqrt(N);
    for (let r = 0; r < mesh.numRegions; r++) {
        const ax = r_xyz[3 * r], ay = r_xyz[3 * r + 1], az = r_xyz[3 * r + 2];
        const v = plate_vec[r_plate[r]];
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
    const white = [1, 1, 1, 1];
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
                white, white
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
    for (const xshift of [-2, 0, 2]) {
        const u_projection = equirectProjection(xshift);
        if (drawMode === 'centroid') {
            renderTriangles({
                u_projection,
                a_xyz: geo.xyz,
                a_tm: geo.tm,
                count: geo.count,
            });
        } else {
            renderIndexedTriangles({
                u_projection,
                a_xyz: geo.xyz,
                a_tm: geo.tm,
                elements: sequentialElements(geo.count),
            });
        }
        if (draw_plateVectors) {
            drawEquirectPlateVectors(u_projection, mesh, map);
        }
        if (draw_plateBoundaries) {
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
    persistViewState();
    if (!window.__PLANET_READY__) {
        window.__PLANET_READY__ = true;
    }
}

let _draw_pending = false;
function _draw() {
    regl.poll();
    regl.clear({ color: [0, 0, 0, 0], depth: 1 });
    let u_pointsize = 0.1 + 100 / Math.sqrt(N);
    let u_projection = mat4.create();
    mat4.scale(u_projection, u_projection, [zoom, zoom, 0.5, 1]); // avoid clipping
    mat4.multiply(u_projection, u_projection, dragRotation);
    applyGlobeOrientation(u_projection);

    if (viewMode === 'equirect') {
        drawEquirect();
        finishDraw();
        return;
    }

    function r_color_fn(r) {
        return [map.r_elevation[r], map.r_moisture[r], map.r_temperature[r]];
    }

    if (drawMode === 'centroid') {
        let triangleGeometry = generateVoronoiGeometry(mesh, map, r_color_fn);
        renderTriangles({
            u_projection,
            a_xyz: triangleGeometry.xyz,
            a_tm: triangleGeometry.tm,
            count: triangleGeometry.xyz.length / 3,
        });
    } else if (drawMode === 'quads') {
        renderIndexedTriangles({
            u_projection,
            a_xyz: quadGeometry.xyz,
            a_tm: quadGeometry.tm,
            elements: quadGeometry.I,
        });
    }

    drawNorthPole(u_projection);
    
    if (draw_plateVectors) {
        drawPlateVectors(u_projection, mesh, map);
    }
    if (draw_plateBoundaries) {
        drawPlateBoundaries(u_projection, mesh, map);
    }

    const rose = document.querySelector('.north-compass-rose');
    if (rose) {
        rose.style.transform = `rotate(${northHeading() * 180 / Math.PI}deg)`;
    }
    
    // renderPoints({
    //     u_projection,
    //     u_pointsize,
    //     a_xyz: map.r_xyz,
    //     count: mesh.numRegions,
    // });
    finishDraw();
}

window.exportPlanetPreview = function exportPlanetPreview() {
    return exportPreview('globe');
};

window.exportEquirectPreview = function exportEquirectPreview(lon0) {
    return exportPreview('equirect', {lon0});
};

window.exportPreview = exportPreview;

function exportPreview(view, opts = {}) {
    viewPersistSuspended = true;
    try {
        if (view === 'globe') return captureGlobePreview();
        if (view === 'equirect') return captureEquirectPreview(opts.lon0);
        throw new Error(`unknown preview view: ${view}`);
    } finally {
        viewPersistSuspended = false;
    }
}

function captureGlobePreview() {
    const src = document.getElementById('output');
    const savedMode = viewMode;
    applyViewMode('globe');
    const cell = 512;
    const labelH = 28;
    const yaws = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
    const labels = ['0', '90', '180', '270'];
    const sheet = document.createElement('canvas');
    sheet.width = cell * 2;
    sheet.height = (cell + labelH) * 2;
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

    for (let i = 0; i < yaws.length; i++) {
        previewYaw = yaws[i];
        _draw();
        regl._gl.finish();
        const x = (i % 2) * cell;
        const y = Math.floor(i / 2) * (cell + labelH);
        ctx.fillText(`${labels[i]} deg`, x + 10, y + labelH / 2);
        ctx.drawImage(src, x, y + labelH, cell, cell);
    }

    previewYaw = savedYaw;
    zoom = savedZoom;
    mat4.copy(dragRotation, savedDrag);
    applyViewMode(savedMode);
    draw();
    return sheet.toDataURL('image/png');
}

function captureEquirectPreview(lon0) {
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
    const dataUrl = src.toDataURL('image/png');
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
generateMesh();
