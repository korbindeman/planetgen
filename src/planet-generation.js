/*
 * From https://www.redblobgames.com/x/1843-planet-generation/
 * Copyright 2018 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Adapting mapgen4 code for a sphere. Quick & dirty, for procjam2018
 */

const colormap = require('./colormap');
const {vec3, vec4, mat4, quat} = require('gl-matrix');
const Tectonics = require('./tectonics');
const Detail = require('./detail');
const {BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM} = Tectonics;
const Planet = require('./planet');
const Pipeline = require('./pipeline');
const ShapeArtifact = require('./shape-artifact');
const LayoutArtifact = require('./layout-artifact');
const Look = require('./look');
const TdOverlay = require('./td-overlay');
const TdTile = require('./td-tile');
const Cubesphere = require('./cubesphere');
const Measure = require('./measure');
const Studio = require('./studio');
const {clamp01} = Tectonics;

const startup = Studio.resolveStartup();
const studio = Studio.createSession(startup);

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

const SURFACE_GLSL = Look.SURFACE_GLSL;
const RELIEF_GLSL = Look.RELIEF_GLSL;
const DRAW_MODES = ['quads', 'centroid', 'plates', 'crust', 'climate', 'relief'];
const FLAT_OVERLAYS = ['plates', 'crust', 'climate'];


/* UI parameters */
let N = 10000;
let jitter = 0.75;
let shapeSpacingKm = 23;
let rotation = -1;
let dragRotation = mat4.create();
let zoom = 1;
let northHeadingAngle = 0;
let viewAnimId = 0;
let drawMode = 'quads';
let viewMode = 'equirect';
let draw_plateVectors = false;
let draw_plateBoundaries = false;
let merge_ocean_plates = false;
let connect_oceans = false;
let simulate_tectonics = true;
let detail_pass = false;
let shape_seed = 0;
let pending_shape = null;
let pending_layout = null;
let previewOverlay = null;   // null | 'plates' | 'crust' | 'climate' | 'relief'
let previewYaw = 0;

function askedLook() {
    if (viewPersistSuspended || previewOverlay) return previewOverlay;
    return drawMode;
}

/* Flat per-region overlays. Relief is a surface look (hypsometric + hillshade),
 * not one of these — it keeps lighting and does not paint plate colours. */
function overlayMode() {
    const asked = askedLook();
    return FLAT_OVERLAYS.indexOf(asked) !== -1 ? asked : null;
}

function usePlateOverlay() {
    return overlayMode() !== null;
}

function useReliefLook() {
    return askedLook() === 'relief';
}

function useCentroid() {
    return drawMode === 'centroid' && !useReliefLook();
}

let mapId = 0;
let equirectPanX = 0;
let equirectPanY = 0;
let equirectZoom = 1;

window.__PLANET_READY__ = false;

function setTdCrops(flag) {
    TdOverlay.setEnabled(flag);
    const toggle = document.getElementById('td-crops-toggle');
    if (toggle) toggle.checked = !!flag;
    draw();
}

function enableTdCrops() {
    if (!TdOverlay.isEnabled()) setTdCrops(true);
}

function setProcess(key, value) {
    if (key === 'simulateTectonics') simulate_tectonics = !!value;
    else if (key === 'detailPass') detail_pass = !!value;
    else if (key === 'mergeOceanPlates') merge_ocean_plates = !!value;
    else if (key === 'connectOceans') connect_oceans = !!value;
    else return;
    pending_layout = null;
    planetCache.layout = null;
    generateMap();
}

const renderPoints = regl({
    frag: `
precision mediump float;
void main() {
   gl_FragColor = vec4(0, 0, 0, 1);
}
`,

    vert: `
precision highp float;
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
precision highp float;
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
varying vec3 v_tm;
${SURFACE_GLSL}
void main() {
   gl_FragColor = vec4(surfaceAlbedo(u_colormap, v_tm), 1);
}
`,

    vert: `
precision highp float;
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
uniform float u_inverse_texture_size, u_slope, u_flat, u_c, u_d, u_outline_strength, u_relief;

varying vec3 v_tm;
${SURFACE_GLSL}
${RELIEF_GLSL}
void main() {
   float dedx = dFdx(v_tm.x);
   float dedy = dFdy(v_tm.x);
   vec3 slope_vector = normalize(vec3(dedy, dedx, u_d * 2.0 * u_inverse_texture_size));
   vec3 light_vector = normalize(vec3(u_light_angle, mix(u_slope, u_flat, slope_vector.z)));
   float light = u_c + max(0.0, dot(light_vector, slope_vector));
   float outline = 1.0 + u_outline_strength * max(dedx,dedy);
   vec3 albedo = mix(surfaceAlbedo(u_colormap, v_tm), reliefAlbedo(u_colormap, v_tm), u_relief);
   gl_FragColor = vec4(albedo * light / outline, 1);
}
`,

    vert: `
precision highp float;
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
        ...Look.globeLightUniforms,
        u_outline_strength: 0,
        u_relief: regl.prop('u_relief'),
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
precision highp float;
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
precision highp float;
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

/*
 * A baked crop, drawn as a mesh of the same ECEF directions the globe
 * uses. Depth against the coarse surface is what stops a tile floating
 * in front of the planet or vanishing behind its neighbour; the 2D
 * overlay could do neither, because it was a billboard.
 */
const renderBakedTile = regl({
    frag: `
precision mediump float;
uniform sampler2D u_image;
varying vec2 v_uv;
void main() {
  gl_FragColor = texture2D(u_image, v_uv);
}
`,
    vert: `
precision highp float;
uniform mat4 u_projection;
attribute vec3 a_xyz;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_projection * vec4(a_xyz, 1);
}
`,
    uniforms: {
        u_projection: regl.prop('u_projection'),
        u_image: regl.prop('u_image'),
    },
    attributes: {
        a_xyz: regl.prop('a_xyz'),
        a_uv: regl.prop('a_uv'),
    },
    elements: regl.prop('elements'),
    depth: {
        enable: true,
        mask: true,
        func: 'lequal',
    },
    polygonOffset: {
        enable: true,
        offset: (context, props) => ({factor: -1.5, units: props.offsetUnits}),
    },
});

const bakedGpu = new Map();
const EQUIRECT_TILE_Z = -0.55;

const withEquirectScissor = regl({
    scissor: {
        enable: true,
        box: (context, props) => props.box,
    },
});

/**********************************************************************
 * Geometry
 */

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

/**********************************************************************
 * Main
 */

// ugh globals, sorry
var mesh, map = {};
var simMesh, simMap;
var quadGeometry = {xyz: null, tm: null, I: null};
var planetCache = {};
let last_detail_n = 0;

function generateMesh() {
    planetCache.sim = null;
    planetCache.detail = null;
    planetCache.layout = null;
    generateMap();
    studio.setPlanetReady(true);
}

function generateMap() {
    const tectonics = studio.lastResolved.options.tectonics;
    /* A cached sketch stays the visible map until showLayout drops it.
     * Re-apply it on every generate. A one-shot flag let a later layout
     * generate (boot generateMesh, N, a process toggle) put the 10k sim
     * on the globe while the Shape tab was still selected. */
    const reuseSketch = !detail_pass && pending_shape;
    if (pending_layout) planetCache.layoutFields = pending_layout;
    else delete planetCache.layoutFields;
    const result = Planet.generatePlanet({
        seed: studio.seed,
        shapeSeed: shape_seed || studio.shapeSeed || studio.seed,
        n: N,
        p: tectonics.plates,
        jitter,
        simulateTectonics: simulate_tectonics,
        simSteps: tectonics.steps,
        polarStraits: tectonics.polarStraits !== false,
        mergeOceanPlates: merge_ocean_plates,
        connectOceans: connect_oceans,
        detailPass: detail_pass,
        detail: {shapeSpacingKm},
        project: studio.project,
        values: studio.generateValues ? studio.generateValues() : studio.pins,
    }, planetCache);
    last_detail_n = result.config.options.detail.n;
    if (pending_layout && result.sim && result.sim.map
        && result.sim.map.r_elevation !== pending_layout.r_elevation) {
        pending_layout = null;
        delete planetCache.layoutFields;
    }
    if (reuseSketch) {
        const fields = ShapeArtifact.toFields(pending_shape);
        const ok = Pipeline.stages.applyShapeFields(result, fields, planetCache);
        if (ok) Pipeline.toLegacy(result);
        else pending_shape = null;
    }
    simMesh = result.simMesh;
    simMap = result.simMap;
    mesh = result.mesh;
    map = result.map;
    quadGeometry = result.geometry;
    overlayColorCache.clear();
    mapId++;
    equirectCache = null;
    /* World first, then the mesh id. Colouring is keyed to mapId, so a
     * regenerate cannot keep the last planet's paint on these tiles. */
    TdOverlay.setContext(studio.project, studio.seed, studio.variant && studio.variant.id);
    TdOverlay.setPlanet(mapId);
    syncTdGridLevel();
    refreshTdCropList();
    studio.refreshPipeline();
    if (studio.syncModeButtons) studio.syncModeButtons();
    draw();
}

function overlayColorForRegion(r) {
    return Planet.overlayColorForRegion(r, map, overlayMode() || 'plates');
}

const overlayColorCache = new Map();

function overlayColorTm() {
    const mode = overlayMode() || 'plates';
    if (!overlayColorCache.has(mode)) {
        overlayColorCache.set(mode, Planet.buildOverlayColorTm(mesh, map, mode));
    }
    return overlayColorCache.get(mode);
}


/* Velocity is a rotation, so it varies across a plate: the arrows have to
 * be evaluated per region, not shared from one vector per plate. */
/* Arrow length is proportional to speed, scaled so a plate rotating at the
 * typical rate draws an arrow about one cell long. */
const PLATE_ARROW_REFERENCE_OMEGA = Look.PLATE_ARROW.referenceOmega;

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
    const ink = usePlateOverlay() ? Look.BOUNDARY_INK : [1, 1, 1, 1];
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
    /* ECEF is Z-up, X at lon 0, Y at 90°E. Rx(-90) stands the globe
     * north-up and looks at 90°E, but a rotation-only view puts east on
     * the left. Negate X so east is right, matching the equirect. */
    mat4.scale(out, out, [-1, 1, 1]);
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
    for (const line of Look.northPoleLines()) {
        line_xyz.push(line.a, line.b);
        line_rgba.push(line.ca, line.cb);
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

const PI = Math.PI;
const TWO_PI = 2 * PI;
const EQUIRECT_W = 2048;
const EQUIRECT_H = 1024;
const EQUIRECT_ASPECT = EQUIRECT_W / EQUIRECT_H;
const GLOBE_SIZE = 1024;
const POLE_LAT = PI / 2 - 1e-6;
const POLE_SNAP = 3 * PI / 180;

let equirectCache = null;
let seqI = null;

function wrapPanX(x) {
    return ((x + 1) % 2 + 2) % 2 - 1;
}

/*
 * Scale that fits the 2:1 map into a viewport of `width`×`height`
 * without stretching. Home is zoom 1, pan 0: the full equirect sits
 * in the largest 2:1 rectangle that the window can hold.
 */
function equirectFitScale(width, height) {
    const aspect = width / Math.max(1, height);
    if (aspect >= EQUIRECT_ASPECT) return {x: EQUIRECT_ASPECT / aspect, y: 1};
    return {x: 1, y: aspect / EQUIRECT_ASPECT};
}

function canvasEquirectFit(canvas) {
    return equirectFitScale(canvas.width, canvas.height);
}

function clampEquirectPanY() {
    const canvas = document.getElementById('output');
    if (!canvas) return;
    const fit = canvasEquirectFit(canvas);
    const maxPan = Math.max(0, 1 - 1 / (fit.y * equirectZoom));
    equirectPanY = Math.min(maxPan, Math.max(-maxPan, equirectPanY));
}

function syncEquirectCanvasSize() {
    const canvas = document.getElementById('output');
    if (!canvas || viewMode !== 'equirect' || viewPersistSuspended) return false;
    const host = canvas.closest('.globe');
    if (!host) {
        if (canvas.width !== EQUIRECT_W) canvas.width = EQUIRECT_W;
        if (canvas.height !== EQUIRECT_H) canvas.height = EQUIRECT_H;
        return false;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(host.clientWidth * dpr));
    const h = Math.max(1, Math.round(host.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    clampEquirectPanY();
    return true;
}

function syncViewModeDom() {
    const canvas = document.getElementById('output');
    if (viewMode === 'equirect') {
        document.body.classList.add('view-equirect');
        syncEquirectCanvasSize();
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
            toggle.title = 'Map view';
            toggle.setAttribute('aria-label', 'Map view');
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
    const meshMode = useCentroid() ? 'centroid' : 'quads';
    const key = `${meshMode}:${mapId}:${overlayMode() || 'surf'}`;
    if (equirectCache && equirectCache.key === key) return equirectCache.geo;
    let geo;
    if (overlay) {
        if (useCentroid()) {
            const raw = generateVoronoiGeometry(mesh, map, overlayColorForRegion);
            geo = buildEquirectTriangles(raw.xyz, raw.tm, null);
        } else {
            geo = buildEquirectTriangles(quadGeometry.xyz, overlayColorTm(), quadGeometry.I);
        }
    } else if (useCentroid()) {
        const raw = generateVoronoiGeometry(mesh, map, rColorFn);
        geo = buildEquirectTriangles(raw.xyz, raw.tm, null);
    } else {
        geo = buildEquirectTriangles(quadGeometry.xyz, quadGeometry.tm, quadGeometry.I);
    }
    equirectCache = {key, geo};
    return geo;
}

function equirectProjection(xshift) {
    const canvas = document.getElementById('output');
    const fit = canvasEquirectFit(canvas);
    const p = mat4.create();
    mat4.scale(p, p, [fit.x * equirectZoom, fit.y * equirectZoom, 1]);
    mat4.translate(p, p, [equirectPanX + xshift, equirectPanY, 0]);
    return p;
}

/*
 * One wrapped copy of the map is the lon/lat rectangle [-1, 1]² after
 * pan and zoom. Wrapping triangles and the polar pad stick out past
 * that rectangle — a torn vertical edge, or a shard at the pole —
 * whenever zoom leaves the rectangle inside the viewport. Clip each
 * copy to its rectangle so the seam is a straight line.
 */
function equirectCopyRect(width, height, xshift, panX, panY, zoom) {
    const fit = equirectFitScale(width, height);
    const zx = zoom * fit.x;
    const zy = zoom * fit.y;
    const left = (-1 + panX + xshift) * zx;
    const right = (1 + panX + xshift) * zx;
    const bottom = (-1 + panY) * zy;
    const top = (1 + panY) * zy;
    return {
        x: (left * 0.5 + 0.5) * width,
        y: (-top * 0.5 + 0.5) * height,
        w: (right - left) * 0.5 * width,
        h: (top - bottom) * 0.5 * height,
        glY: (bottom * 0.5 + 0.5) * height,
    };
}

function equirectScissorBox(width, height, xshift) {
    const r = equirectCopyRect(width, height, xshift, equirectPanX, equirectPanY, equirectZoom);
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.glY));
    const w = Math.min(width, Math.ceil(r.x + r.w)) - x;
    const h = Math.min(height, Math.ceil(r.glY + r.h)) - y;
    if (w <= 0 || h <= 0) return null;
    return {x, y, width: w, height: h};
}

function clipCanvasToEquirectCopy(ctx, width, height, xshift) {
    const r = equirectCopyRect(width, height, xshift, equirectPanX, equirectPanY, equirectZoom);
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
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
    const ink = usePlateOverlay() ? Look.BOUNDARY_INK : [1, 1, 1, 1];
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

function cropEquirectMesh(mesh) {
    const {xyz, uv, indices} = mesh;
    const outXYZ = [];
    const outUV = [];
    for (let i = 0; i < indices.length; i += 3) {
        const verts = [indices[i], indices[i + 1], indices[i + 2]].map((idx) => ({
            lon: Math.atan2(xyz[idx * 3 + 1], xyz[idx * 3]),
            lat: Math.asin(Math.max(-1, Math.min(1, xyz[idx * 3 + 2]))),
            u: uv[idx * 2],
            v: uv[idx * 2 + 1],
        }));
        for (let k = 1; k < 3; k++) {
            while (verts[k].lon - verts[0].lon > PI) verts[k].lon -= TWO_PI;
            while (verts[0].lon - verts[k].lon > PI) verts[k].lon += TWO_PI;
        }
        function emit(shift) {
            for (const p of verts) {
                outXYZ.push((p.lon + shift) / PI, (2 * p.lat) / PI, EQUIRECT_TILE_Z);
                outUV.push(p.u, p.v);
            }
        }
        emit(0);
        const minL = Math.min(verts[0].lon, verts[1].lon, verts[2].lon);
        const maxL = Math.max(verts[0].lon, verts[1].lon, verts[2].lon);
        if (minL < -PI) emit(TWO_PI);
        if (maxL > PI) emit(-TWO_PI);
    }
    const outI = new Uint32Array(outXYZ.length / 3);
    for (let i = 0; i < outI.length; i++) outI[i] = i;
    return {
        xyz: new Float32Array(outXYZ),
        uv: new Float32Array(outUV),
        indices: outI,
    };
}

function gpuForCrop(crop) {
    const img = TdOverlay.surfaceFor(crop);
    if (!img) return null;
    let gpu = bakedGpu.get(crop.name);
    if (!gpu) {
        gpu = {tex: null, imageEl: null, mesh: null, meshKey: '', equirect: null};
        bakedGpu.set(crop.name, gpu);
    }
    if (gpu.imageEl !== img) {
        if (gpu.tex) gpu.tex.destroy();
        try {
            gpu.tex = regl.texture({
                data: img,
                min: 'linear',
                mag: 'linear',
                wrapS: 'clamp',
                wrapT: 'clamp',
            });
            gpu.imageEl = img;
        } catch {
            gpu.tex = null;
            gpu.imageEl = null;
            return null;
        }
    }
    const meshKey = crop.tile
        ? `t:${crop.tile.face}:${crop.tile.level}:${crop.tile.i}:${crop.tile.j}`
        : `b:${crop.west}:${crop.south}:${crop.east}:${crop.north}`;
    if (gpu.meshKey !== meshKey) {
        const mesh = TdOverlay.cropMesh(crop);
        gpu.mesh = mesh;
        gpu.equirect = mesh ? cropEquirectMesh(mesh) : null;
        gpu.meshKey = meshKey;
    }
    return gpu.mesh && gpu.tex ? gpu : null;
}

function pruneBakedGpu(keep) {
    for (const name of [...bakedGpu.keys()]) {
        if (keep.has(name)) continue;
        const gpu = bakedGpu.get(name);
        if (gpu.tex) gpu.tex.destroy();
        bakedGpu.delete(name);
    }
}

function drawBakedTiles(u_projection, mode) {
    if (!TdOverlay.isEnabled()) {
        pruneBakedGpu(new Set());
        return;
    }
    /* The bake conditions on the sketch. Do not drape tiles on Layout. */
    if (!isShaped()) return;
    const crops = TdOverlay.visibleCrops().slice().sort((a, b) => (
        TdOverlay.cropRank(a) - TdOverlay.cropRank(b)
    ));
    pruneBakedGpu(new Set(crops.map((c) => c.name)));
    crops.forEach((crop, i) => {
        const gpu = gpuForCrop(crop);
        if (!gpu) return;
        const mesh = mode === 'equirect' ? gpu.equirect : gpu.mesh;
        if (!mesh) return;
        renderBakedTile({
            u_projection,
            a_xyz: mesh.xyz,
            a_uv: mesh.uv,
            elements: mesh.indices,
            u_image: gpu.tex,
            offsetUnits: -2 * (i + 1),
        });
    });
}

function drawEquirect() {
    const geo = getEquirectSurfaceGeometry();
    const overlay = usePlateOverlay();
    const gl = regl._gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    for (const xshift of [-2, 0, 2]) {
        const box = equirectScissorBox(width, height, xshift);
        if (!box) continue;
        const u_projection = equirectProjection(xshift);
        withEquirectScissor({box}, () => {
            drawSurface(u_projection, geo.xyz, geo.tm, geo.count);
            drawBakedTiles(u_projection, 'equirect');
            if (!overlay && draw_plateVectors) {
                drawEquirectPlateVectors(u_projection, simMesh, simMap);
            }
            if (overlay || draw_plateBoundaries) {
                drawEquirectPlateBoundaries(u_projection, mesh, map);
            }
        });
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

function overlayView() {
    const src = document.getElementById('output');
    const fit = canvasEquirectFit(src);
    return {
        viewMode,
        globeProjection: globeProjectionMatrix(),
        equirectPanX,
        equirectPanY,
        equirectZoom,
        equirectFitX: fit.x,
        equirectFitY: fit.y,
        seed: studio.seed,
        project: studio.project,
        zoom: viewMode === 'equirect' ? equirectZoom : zoom,
        shaped: isShaped(),
        radiusKm: (studio.lastResolved && studio.lastResolved.options.world.radiusKm) || 6371,
    };
}

function paintMeasureOverlay() {
    Measure.paint(overlayView());
}

function finishDraw() {
    _draw_pending = false;
    if (!viewPersistSuspended) {
        paintLivePlateOverlay();
        const view = overlayView();
        TdOverlay.paint(view);
        Measure.paint(view);
    }
    persistViewState();
    if (!window.__PLANET_READY__) {
        window.__PLANET_READY__ = true;
    }
}

let _draw_pending = false;
let _draw_token = 0;
function globeProjectionMatrix() {
    let u_projection = mat4.create();
    mat4.scale(u_projection, u_projection, [zoom, zoom, 0.5]);
    mat4.multiply(u_projection, u_projection, dragRotation);
    applyGlobeOrientation(u_projection);
    return u_projection;
}

function drawSurface(u_projection, xyz, tm, count) {
    const overlay = usePlateOverlay();
    const relief = useReliefLook() ? 1 : 0;
    if (useCentroid()) {
        const cmd = overlay ? renderFlatTriangles : renderTriangles;
        cmd({u_projection, a_xyz: xyz, a_tm: tm, count});
        return;
    }
    const elements = count == null ? quadGeometry.I : sequentialElements(count);
    const cmd = overlay ? renderFlatIndexed : renderIndexedTriangles;
    cmd({u_projection, a_xyz: xyz, a_tm: tm, elements, u_relief: relief});
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
    if (useCentroid()) {
        const colorFn = overlay ? overlayColorForRegion : rColorFn;
        let triangleGeometry = generateVoronoiGeometry(mesh, map, colorFn);
        drawSurface(u_projection, triangleGeometry.xyz, triangleGeometry.tm, triangleGeometry.xyz.length / 3);
    } else {
        const tm = overlay ? overlayColorTm() : quadGeometry.tm;
        drawSurface(u_projection, quadGeometry.xyz, tm);
    }

    drawBakedTiles(u_projection, 'globe');

    if (!overlay) drawNorthPole(u_projection);

    if (!overlay && draw_plateVectors) {
        drawPlateVectors(u_projection, simMesh, simMap);
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

function rasterizeEquirect(width, height, lon0) {
    return Planet.rasterizeEquirect(mesh, map, width, height, lon0);
}

function rasterizeLonLatBox(westDeg, southDeg, eastDeg, northDeg, width, height, lon0) {
    return Planet.rasterizeLonLatBox(mesh, map, westDeg, southDeg, eastDeg, northDeg, width, height, lon0);
}

function rasterizeCubeTile(tile, width, height, lon0, padCells) {
    return Planet.rasterizeCubeTile(mesh, map, tile, width, height, lon0, padCells);
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

const {elevRgb, tempRgb, precipRgb, hillshadeField, CROP_COLORS_HEX} = Look;

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

    const shade = hillshadeField(world.heightmap, w, h);
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
    const colors = CROP_COLORS_HEX;
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
        const upShade = hillshadeField(upE, cropW, cropH);
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
    const shade = hillshadeField(upE, w, h);
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
        seed: studio.seed,
        n: N,
        plates: studio.lastResolved.options.tectonics.plates,
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
    if (overlay && overlay !== 'relief') {
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
        syncViewModeDom();
        if (mesh) _draw();
    }
}

const PLATE_ARROW_SCALE = Look.PLATE_ARROW.scale;
const OVERLAY_LEGEND = Look.OVERLAY_LEGEND;

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
    const canvas = document.getElementById('output');
    const fit = canvasEquirectFit(canvas);
    const lon = Math.atan2(xyz[1], xyz[0]) + xshift * Math.PI;
    const lat = Math.asin(Math.max(-1, Math.min(1, xyz[2])));
    const x = ((lon / Math.PI) + equirectPanX) * equirectZoom * fit.x;
    const y = ((2 * lat / Math.PI) + equirectPanY) * equirectZoom * fit.y;
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
    ctx.strokeStyle = Look.PLATE_ARROW.haloHex;
    ctx.fillStyle = Look.PLATE_ARROW.labelHex;
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
            ctx.strokeStyle = Look.PLATE_ARROW.haloHex;
            strokeArrow(ctx, start.x, start.y, end.x + shift, start.y + (end.y - start.y));
            strokeArrow(ctx, start.x - shift, start.y, end.x, end.y);
            ctx.lineWidth = 2.4;
            ctx.strokeStyle = Look.PLATE_ARROW.hex;
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
            ctx.strokeStyle = Look.PLATE_ARROW.haloHex;
            strokeArrow(ctx, start.x, start.y, end.x, end.y);
            ctx.lineWidth = 2.4;
            ctx.strokeStyle = Look.PLATE_ARROW.hex;
            strokeArrow(ctx, start.x, start.y, end.x, end.y);
        }

        ctx.lineWidth = 4;
        ctx.strokeStyle = Look.PLATE_ARROW.haloHex;
        ctx.fillStyle = Look.PLATE_ARROW.labelHex;
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
    const space = TdOverlay.fitScreenCanvas(overlay);
    if (!space) return;
    const {ctx, width, height} = space;
    if (viewMode === 'equirect') {
        for (const shift of [-2, 0, 2]) {
            ctx.save();
            clipCanvasToEquirectCopy(ctx, width, height, shift);
            paintPlateAnnotations(ctx, width, height, 'equirect', null, shift);
            ctx.restore();
        }
    } else {
        paintPlateAnnotations(ctx, width, height, 'globe', globeProjectionMatrix());
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
    src.width = EQUIRECT_W;
    src.height = EQUIRECT_H;
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
        const token = ++_draw_token;
        requestAnimationFrame(() => {
            if (token !== _draw_token) return;
            _draw();
        });
    }
}


/* Same-turn draw so a thumbnail can read the canvas before the
 * compositor clears the WebGL buffer. */
function drawNow() {
    if (!mesh || !quadGeometry || !quadGeometry.xyz) return false;
    _draw_token += 1;
    _draw_pending = true;
    _draw();
    return true;
}

/*
 * One tile's conditioning. The raster is sampled in the tile's own face
 * space, so the cells sit where the bake will put them; the lon/lat box that
 * rides along is nominal, for the GeoTIFF's geotransform and for framing the
 * view. The tile identity is what actually places the result.
 *
 * The raster is the tile plus CONTEXT_PAD cells of real neighbour ground.
 * tiff-export would fill that window by repeating the rim, which is why
 * adjacent bakes met at a hard seam: each U-Net saw a wall, not the coast
 * continuing. Origin is the face-grid cell of that padded top-left, so two
 * tiles that share an edge share WorldPipeline coordinates and noise.
 */
function exportTdTile(tile) {
    const cells = tdTileCells();
    const pad = TdTile.CONTEXT_PAD;
    const raw = rasterizeCubeTile(tile, cells, cells, 0, pad);
    const e = Cubesphere.paddedExtent(tile, pad, pad, cells, cells);
    const layers = fieldsToTdLayers(raw, raw.width, raw.height, (row) => {
        const b = e.b1 - (row + 0.5) / raw.height * (e.b1 - e.b0);
        const mid = Cubesphere.xyzToLonLat(Cubesphere.faceDirection(tile.face, (e.a0 + e.a1) / 2, b));
        return mid.lat * PI / 180;
    });
    const box = Cubesphere.tileBBox(tile);
    const origin = TdTile.contextOrigin(tile, cells, pad);
    return {
        name: Cubesphere.tileName(tile),
        tile,
        west: box.west,
        south: box.south,
        east: box.east,
        north: box.north,
        cropW: cells,
        cropH: cells,
        padCells: pad,
        originI: origin.originI,
        originJ: origin.originJ,
        scaleKm: TdTile.SCALE_KM,
        seed: studio.seed,
        project: studio.project,
        variant: studio.variant && studio.variant.id || undefined,
        layers: encodeTdLayers(layers),
    };
}

/*
 * One preview size: the bakeable cube level nearest 310 km. A tile is a
 * fixed slice of the sphere, so that level moves with radius — 4 on Thalos,
 * 5 on Earth. Hard-coding 4 made Earth tiles 27 cells, past what the bake
 * takes. Called whenever the planet or the project changes.
 */
function syncTdGridLevel() {
    TdOverlay.setGridLevel(Cubesphere.bestLevel(
        TdTile.TARGET_TILE_KM, tdRadiusKm(), TdTile.SCALE_KM,
        TdTile.MIN_CELLS, TdTile.MAX_CELLS,
    ));
}

/* Conditioning cells across a tile, from the planet's own radius — a tile is
 * a fixed slice of the sphere, so a smaller planet means a smaller tile. */
function tdTileCells() {
    return Cubesphere.tileCells(TdOverlay.getGridLevel(), tdRadiusKm(), TdTile.SCALE_KM);
}

function tdRadiusKm() {
    return studio.lastResolved.options.world.radiusKm;
}

/*
 * Bake every picked tile, one job each. The server runs them in order, so a
 * long selection queues rather than piles up, and a tile that fails takes
 * only itself down.
 */
async function bakeTdDraft() {
    const tiles = TdOverlay.getPicked();
    if (!tiles.length || !isShaped()) return;
    if (studio.ensureVariant) await studio.ensureVariant();
    const asked = TdOverlay.snapshot();
    const bakeBtn = document.querySelector('#td-crop-list .stage-forward');
    if (bakeBtn) bakeBtn.disabled = true;
    const failed = [];
    for (const tile of tiles) {
        if (!TdOverlay.stillSameWorld(asked)) return;
        try {
            const res = await fetch(`${TdOverlay.TD_API}/jobs`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(exportTdTile(tile)),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || res.statusText);
        } catch (err) {
            failed.push(`${Cubesphere.tileName(tile)}: ${err.message || err}`);
        }
    }
    if (!TdOverlay.stillSameWorld(asked)) return;
    if (failed.length) window.alert(`Bake failed for ${failed.length} tile(s):\n${failed.join('\n')}`);
    else TdOverlay.clearPicked();
    TdOverlay.reload();
    startTdJobPoll();
    studio.refreshPipeline();
    draw();
}

let tdPollTimer = 0;
function jobBusy(job) {
    return job.status !== 'done' && job.status !== 'error';
}

function startTdJobPoll() {
    if (tdPollTimer) return;
    let inFlight = false;
    let seenBusy = TdOverlay.getJobs().some(jobBusy);
    let idleTicks = 0;
    const tick = () => {
        if (inFlight) return;
        inFlight = true;
        const before = TdOverlay.getJobs();
        TdOverlay.pollJobs()
            .then((after) => {
                const list = Array.isArray(after) ? after : [];
                const busy = list.some(jobBusy);
                if (busy) {
                    seenBusy = true;
                    idleTicks = 0;
                } else {
                    idleTicks += 1;
                }
                const finished = list.some((job) => {
                    const prev = before.find((j) => (j.id || j.name) === (job.id || job.name));
                    return prev && jobBusy(prev) && !jobBusy(job);
                });
                if (finished) {
                    TdOverlay.reload();
                    studio.refreshPipeline();
                }
                /* Stop only after a jobs fetch says the queue is idle. Checking
                 * the list before that fetch returned used to kill the poll
                 * while the first reload was still in flight, so the bar
                 * never moved again. */
                if ((seenBusy && idleTicks >= 2) || idleTicks >= 15) {
                    clearInterval(tdPollTimer);
                    tdPollTimer = 0;
                    TdOverlay.reload();
                    studio.refreshPipeline();
                }
            })
            .catch(() => {
                idleTicks += 1;
            })
            .finally(() => {
                inFlight = false;
            });
    };
    tick();
    tdPollTimer = setInterval(tick, 400);
}

function canvasToClip(x, y, width, height) {
    return {
        x: (x / width) * 2 - 1,
        y: -((y / height) * 2 - 1),
    };
}

function canvasToLonLat(x, y, width, height) {
    if (viewMode === 'equirect') {
        const clip = canvasToClip(x, y, width, height);
        const fit = equirectFitScale(width, height);
        const lonDeg = ((clip.x / (fit.x * equirectZoom)) - equirectPanX) * 180;
        const latDeg = ((clip.y / (fit.y * equirectZoom)) - equirectPanY) * 90;
        return {
            lon: TdTile.wrapLon(lonDeg),
            lat: Math.max(-89.9, Math.min(89.9, latDeg)),
        };
    }
    const {x: ndcX, y: ndcY} = canvasToClip(x, y, width, height);
    const inv = mat4.invert(mat4.create(), globeProjectionMatrix());
    if (!inv) return null;
    const a = vec4.transformMat4([], [ndcX, ndcY, -1, 1], inv);
    const b = vec4.transformMat4([], [ndcX, ndcY, 1, 1], inv);
    const aw = a[3] || 1, bw = b[3] || 1;
    const ax = a[0] / aw, ay = a[1] / aw, az = a[2] / aw;
    const dx = b[0] / bw - ax, dy = b[1] / bw - ay, dz = b[2] / bw - az;
    const o2 = ax * ax + ay * ay + az * az;
    const od = ax * dx + ay * dy + az * dz;
    const d2 = dx * dx + dy * dy + dz * dz;
    const disc = od * od - d2 * (o2 - 1);
    if (disc < 0 || d2 < 1e-12) return null;
    const t = (-od - Math.sqrt(disc)) / d2;
    const px = ax + t * dx, py = ay + t * dy, pz = az + t * dz;
    return {
        lon: Math.atan2(py, px) * 180 / Math.PI,
        lat: Math.asin(Math.max(-1, Math.min(1, pz))) * 180 / Math.PI,
    };
}

/*
 * Zoom is a uniform scale about the view centre. After the scale, this
 * turns the globe so `lonLat` still sits on the same clip ray — otherwise
 * the wheel always dives into the middle of the frame.
 */
function rotateGlobePointToClip(lonLat, clipX, clipY) {
    const P = Cubesphere.lonLatToXyz(lonLat.lon, lonLat.lat);
    const V = vec3.transformMat4([], P, globeViewMatrix(mat4.create()));
    let vx = clipX / zoom;
    let vy = clipY / zoom;
    const r2 = V[0] * V[0] + V[1] * V[1] + V[2] * V[2];
    const xy2 = vx * vx + vy * vy;
    const maxXy2 = r2 * 0.999999;
    if (xy2 > maxXy2) {
        const s = Math.sqrt(maxXy2 / xy2);
        vx *= s;
        vy *= s;
    }
    const vz = (V[2] <= 0 ? -1 : 1) * Math.sqrt(Math.max(0, r2 - vx * vx - vy * vy));
    const from = vec3.normalize([], V);
    const to = vec3.normalize([], [vx, vy, vz]);
    const R = mat4.fromQuat(mat4.create(), quat.rotationTo(quat.create(), from, to));
    mat4.multiply(dragRotation, R, dragRotation);
}

function eventCanvasPoint(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) / rect.width * canvas.width,
        y: (event.clientY - rect.top) / rect.height * canvas.height,
    };
}

/* The tile under a canvas point, at the picker's current level. */
function tileAtCanvas(x, y, canvas) {
    const at = canvasToLonLat(x, y, canvas.width, canvas.height);
    if (!at) return null;
    return Cubesphere.tileAt(at.lon, at.lat, TdOverlay.getGridLevel());
}

let measureHint = 0;

function sampleElevM(lon, lat) {
    if (!mesh || !map || !map.r_xyz) return undefined;
    if (measureHint >= mesh.numRegions) measureHint = 0;
    const xyz = Cubesphere.lonLatToXyz(lon, lat);
    measureHint = Tectonics.nearestRegion(mesh, map.r_xyz, xyz, measureHint, []);
    if (map.r_meters && Number.isFinite(map.r_meters[measureHint])) {
        return map.r_meters[measureHint];
    }
    if (map.r_elevation && Number.isFinite(map.r_elevation[measureHint])) {
        return Tectonics.elevationToMeters(map.r_elevation[measureHint]);
    }
    return undefined;
}

function pickAtCanvas(x, y, canvas) {
    const at = canvasToLonLat(x, y, canvas.width, canvas.height);
    if (!at) return null;
    at.elevM = sampleElevM(at.lon, at.lat);
    return at;
}

function restCursor(canvas) {
    if (!canvas) return;
    canvas.style.cursor = Measure.isActive() ? 'crosshair' : 'grab';
}

function syncMeasureUi() {
    const on = Measure.isActive();
    document.body.classList.toggle('measuring', on);
    const btn = document.querySelector('.measure-toggle');
    if (btn) btn.setAttribute('aria-pressed', String(on));
    const canvas = document.getElementById('output');
    if (canvas && canvas.style.cursor !== 'grabbing') restCursor(canvas);
}

function typingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function setupDragRotation() {
    const canvas = document.getElementById('output');
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
    canvas.style.userSelect = 'none';

    const ZOOM_MIN = TdTile.ZOOM_MIN;
    const ZOOM_MAX = TdTile.ZOOM_MAX;
    const pointers = new Map();
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let pinchStartDist = 0;
    let pinchStartZoom = 1;

    /*
     * Tile picking. `anchor` is the tile the drag started on and never moves,
     * so the selection is always exactly the rectangle between it and the
     * tile under the cursor — nothing is interpolated, quantised or
     * re-centred on the way, which is what used to make the box trail behind.
     * The selection is left alone until the pointer actually leaves the
     * anchor tile, so a press that turns out to be a click can still toggle.
     */
    let picking = false;
    let anchor = null;
    let moved = false;
    let shiftHeld = false;
    let overCanvas = false;
    let measuringPress = null;

    /* Where the pointer last was, so pressing shift without moving the mouse
     * still lights up the tile under it. */
    let hoverX = 0;
    let hoverY = 0;

    /* The grid belongs to the pointer, not the keyboard: it appears when
     * shift is held *over the canvas*, so a shift-something shortcut typed
     * elsewhere does not flash it. Preview tiles live on Shape. */
    function refreshGrid() {
        const show = isShaped() && (picking || (shiftHeld && overCanvas));
        let changed = TdOverlay.setGridShown(show);
        const tile = show && !picking ? tileAtCanvas(hoverX, hoverY, canvas) : null;
        if (TdOverlay.setHoverTile(show ? tile : null)) changed = true;
        return changed;
    }

    function clampZoom(value) {
        return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    }

    function currentZoom() {
        return viewMode === 'equirect' ? equirectZoom : zoom;
    }

    function setCurrentZoom(value, focus) {
        const next = clampZoom(value);
        if (viewMode === 'equirect') {
            const prev = equirectZoom;
            if (focus && next !== prev) {
                const clip = canvasToClip(focus.x, focus.y, canvas.width, canvas.height);
                const fit = canvasEquirectFit(canvas);
                equirectPanX = wrapPanX(equirectPanX + (clip.x / fit.x) * (1 / next - 1 / prev));
                equirectPanY += (clip.y / fit.y) * (1 / next - 1 / prev);
            }
            equirectZoom = next;
            clampEquirectPanY();
            return;
        }
        const prev = zoom;
        const at = focus && next !== prev
            ? canvasToLonLat(focus.x, focus.y, canvas.width, canvas.height)
            : null;
        zoom = next;
        if (at) {
            const clip = canvasToClip(focus.x, focus.y, canvas.width, canvas.height);
            rotateGlobePointToClip(at, clip.x, clip.y);
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
            measuringPress = null;
            restCursor(canvas);
            pinchStartDist = pointerDistance();
            pinchStartZoom = currentZoom();
            return;
        }
        if (event.button !== 0) return;
        if (event.shiftKey && isShaped()) {
            const pt = eventCanvasPoint(event, canvas);
            const tile = tileAtCanvas(pt.x, pt.y, canvas);
            if (tile) {
                enableTdCrops();
                picking = true;
                anchor = tile;
                moved = false;
                /* Show the anchor immediately, so a press reads as a hit
                 * even before the pointer moves. */
                TdOverlay.setHoverTile(tile);
                refreshGrid();
                canvas.setPointerCapture(event.pointerId);
                canvas.style.cursor = 'crosshair';
                event.preventDefault();
                draw();
                return;
            }
        }
        if (Measure.isActive()) {
            measuringPress = {id: event.pointerId, x: event.clientX, y: event.clientY};
            canvas.setPointerCapture(event.pointerId);
            canvas.style.cursor = 'crosshair';
            event.preventDefault();
            return;
        }
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
        const here = eventCanvasPoint(event, canvas);
        hoverX = here.x;
        hoverY = here.y;
        if (pointers.size === 2 && pinchStartDist > 0) {
            const pts = Array.from(pointers.values());
            const rect = canvas.getBoundingClientRect();
            setCurrentZoom(pinchStartZoom * (pointerDistance() / pinchStartDist), {
                x: ((pts[0].x + pts[1].x) / 2 - rect.left) / rect.width * canvas.width,
                y: ((pts[0].y + pts[1].y) / 2 - rect.top) / rect.height * canvas.height,
            });
            draw();
            return;
        }
        if (measuringPress && measuringPress.id === event.pointerId) {
            const dist = Math.hypot(event.clientX - measuringPress.x, event.clientY - measuringPress.y);
            if (dist > 6) {
                dragging = true;
                lastX = event.clientX;
                lastY = event.clientY;
                measuringPress = null;
                canvas.style.cursor = 'grabbing';
            } else {
                return;
            }
        }
        if (picking) {
            const tile = tileAtCanvas(hoverX, hoverY, canvas);
            if (!tile) return;
            /* Until the pointer leaves the anchor tile this is still a click,
             * and the selection it might toggle has to stay untouched. */
            if (!moved && !Cubesphere.sameTile(tile, anchor)) {
                moved = true;
                TdOverlay.setHoverTile(null);
            }
            if (moved) {
                TdOverlay.setPicked(Cubesphere.tileRange(anchor, tile));
                draw();
            }
            return;
        }
        if (!dragging && Measure.isActive()) {
            if (Measure.setHover(pickAtCanvas(hoverX, hoverY, canvas))) paintMeasureOverlay();
        }
        if (!dragging && shiftHeld && isShaped()) {
            if (TdOverlay.setHoverTile(tileAtCanvas(hoverX, hoverY, canvas))) draw();
            return;
        }
        if (!dragging) return;
        const rect = canvas.getBoundingClientRect();
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;

        if (viewMode === 'equirect') {
            const fit = canvasEquirectFit(canvas);
            equirectPanX = wrapPanX(equirectPanX + (dx / rect.width) * 2 / (fit.x * equirectZoom));
            equirectPanY += (-dy / rect.height) * 2 / (fit.y * equirectZoom);
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
        if (measuringPress && measuringPress.id === event.pointerId) {
            const pt = eventCanvasPoint(event, canvas);
            const at = pickAtCanvas(pt.x, pt.y, canvas);
            if (at) Measure.addPoint(at);
            measuringPress = null;
            restCursor(canvas);
            paintMeasureOverlay();
        }
        if (picking) {
            const pt = eventCanvasPoint(event, canvas);
            const tile = tileAtCanvas(pt.x, pt.y, canvas) || anchor;
            /* A press that never left its tile is a click: it adds that tile
             * to the selection, or takes it back out. A drag replaces the
             * selection with the rectangle it covered. */
            if (moved) TdOverlay.setPicked(Cubesphere.tileRange(anchor, tile));
            else TdOverlay.togglePicked(anchor);
            picking = false;
            anchor = null;
            moved = false;
            refreshGrid();
            restCursor(canvas);
            draw();
        }
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
        restCursor(canvas);
    }

    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('pointerenter', (event) => {
        overCanvas = true;
        const here = eventCanvasPoint(event, canvas);
        hoverX = here.x;
        hoverY = here.y;
        const gridChanged = refreshGrid();
        const hoverChanged = Measure.isActive()
            && Measure.setHover(pickAtCanvas(hoverX, hoverY, canvas));
        if (gridChanged) draw();
        else if (hoverChanged) paintMeasureOverlay();
    });
    canvas.addEventListener('pointerleave', () => {
        overCanvas = false;
        const gridChanged = refreshGrid();
        const hoverCleared = Measure.setHover(null);
        if (gridChanged) draw();
        else if (hoverCleared) paintMeasureOverlay();
    });

    /*
     * Shift is a held state, not an event, so it is tracked on the window:
     * pressing it with the pointer already still over the canvas has to show
     * the grid, and losing the window while it is down has to hide it again
     * rather than leave the grid stuck on.
     */
    window.addEventListener('keydown', (event) => {
        if (event.key !== 'Shift' || shiftHeld) return;
        shiftHeld = true;
        if (refreshGrid()) draw();
    });
    window.addEventListener('keyup', (event) => {
        if (event.key !== 'Shift') return;
        shiftHeld = false;
        if (refreshGrid()) draw();
    });
    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (Measure.getPoints().length) {
                Measure.clear();
                paintMeasureOverlay();
                return;
            }
            if (TdOverlay.getPicked().length) {
                TdOverlay.clearPicked();
                draw();
                return;
            }
            if (Measure.isActive()) {
                Measure.setActive(false);
                Measure.clear();
                syncMeasureUi();
                paintMeasureOverlay();
            }
            return;
        }
        if ((event.key === 'Backspace' || event.key === 'Delete') && Measure.isActive()) {
            if (typingTarget(event.target)) return;
            if (Measure.popPoint()) paintMeasureOverlay();
            return;
        }
        if ((event.key === 'm' || event.key === 'M') && !event.metaKey && !event.ctrlKey && !event.altKey) {
            if (typingTarget(event.target)) return;
            event.preventDefault();
            Measure.setActive(!Measure.isActive());
            syncMeasureUi();
            paintMeasureOverlay();
        }
    });
    window.addEventListener('blur', () => {
        if (!shiftHeld) return;
        shiftHeld = false;
        if (refreshGrid()) draw();
    });

    canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        setCurrentZoom(
            currentZoom() * Math.exp(-event.deltaY * 0.002),
            eventCanvasPoint(event, canvas),
        );
        draw();
    }, {passive: false});
}

function frameTdCrop(crop) {
    const next = TdOverlay.frameView(crop);
    if (viewMode !== 'equirect') {
        viewMode = 'equirect';
        syncViewModeDom();
        studio.syncModeButtons();
    }
    const startX = equirectPanX;
    const startY = equirectPanY;
    const startZ = equirectZoom;
    const targetX = wrapPanX(next.equirectPanX);
    const targetY = next.equirectPanY;
    const targetZ = next.equirectZoom;
    let dx = targetX - startX;
    if (dx > 1) dx -= 2;
    if (dx < -1) dx += 2;
    animateView((eased) => {
        equirectPanX = wrapPanX(startX + dx * eased);
        equirectPanY = startY + (targetY - startY) * eased;
        equirectZoom = startZ + (targetZ - startZ) * eased;
    });
}

function refreshTdCropList() {
    TdOverlay.renderCropList(document.getElementById('td-crop-list'), {
        seed: studio.seed,
        radiusKm: tdRadiusKm(),
        scaleKm: TdTile.SCALE_KM,
        onToggle: (name, on) => {
            TdOverlay.setCropOn(name, on);
            if (mesh) draw();
        },
        onFrame: frameTdCrop,
        onBake: bakeTdDraft,
        onClearDraft: () => {
            TdOverlay.clearPicked();
            draw();
        },
    });
}

/*
 * Colour a baked tile with the globe's current look — surface albedo or
 * hillshade relief, matching the mesh it sits on.
 *
 * The bake gives back elevation in metres and nothing else. Albedo needs
 * moisture and temperature too, and those come from this planet's climate
 * under the tile — rasterized at the coarse grain and sampled up — so the
 * tile is lit and coloured by exactly the same rules as the mesh it sits on,
 * and follows any look change instead of being a picture from bake time.
 */
const TD_CLIMATE_CELLS = 32;

function paintTdSurface(crop) {
    const w = crop.elevWidth;
    const h = crop.elevHeight;
    if (!(w > 0 && h > 0) || !crop.elevM) return null;

    const climate = tdClimateUnder(crop);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(w, h);
    const px = out.data;

    /* Metres to the elevation units Look speaks, once per sample. */
    const e = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) e[i] = Tectonics.metersToElevation(crop.elevM[i]);

    for (let y = 0; y < h; y++) {
        const y0 = y === 0 ? y : y - 1;
        const y1 = y === h - 1 ? y : y + 1;
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const fx = (x + 0.5) / w;
            const fy = (y + 0.5) / h;
            const [r, g, b] = useReliefLook()
                ? Look.reliefAlbedo(e[i])
                : Look.surfaceAlbedo(e[i], moist, temp);
            const x0 = x === 0 ? x : x - 1;
            const x1 = x === w - 1 ? x : x + 1;
            const shade = Look.hillshade(
                (e[y * w + x1] - e[y * w + x0]) / (x1 - x0),
                (e[y1 * w + x] - e[y0 * w + x]) / (y1 - y0),
            );
            px[i * 4] = Math.round(r * shade * 255);
            px[i * 4 + 1] = Math.round(g * shade * 255);
            px[i * 4 + 2] = Math.round(b * shade * 255);
            px[i * 4 + 3] = 255;
        }
    }
    ctx.putImageData(out, 0, 0);
    return canvas;
}

/* This planet's moisture and temperature under a crop, coarse. */
function tdClimateUnder(crop) {
    const n = TD_CLIMATE_CELLS;
    const raw = crop.tile
        ? rasterizeCubeTile(crop.tile, n, n, 0)
        : rasterizeLonLatBox(crop.west, crop.south, crop.east, crop.north, n, n, 0);
    return {n, moist: raw.moist, temp: raw.temp};
}

function sampleTdField(field, n, fx, fy) {
    const u = Math.max(0, Math.min(n - 1.001, fx * n - 0.5));
    const v = Math.max(0, Math.min(n - 1.001, fy * n - 0.5));
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const x1 = Math.min(n - 1, x0 + 1);
    const y1 = Math.min(n - 1, y0 + 1);
    const tx = u - x0;
    const ty = v - y0;
    return field[y0 * n + x0] * (1 - tx) * (1 - ty)
        + field[y0 * n + x1] * tx * (1 - ty)
        + field[y1 * n + x0] * (1 - tx) * ty
        + field[y1 * n + x1] * tx * ty;
}

function setupTdOverlay() {
    TdOverlay.setSurfacePainter(paintTdSurface);
    syncTdGridLevel();
    TdOverlay.onChange((detail) => {
        if (detail && detail.jobs) {
            TdOverlay.syncJobRows(document.getElementById('td-crop-list'));
            return;
        }
        refreshTdCropList();
        if (mesh) draw();
    });
    TdOverlay.setContext(studio.project, studio.seed, studio.variant && studio.variant.id);
    TdOverlay.load();
    studio.refreshPipeline();
}

const SEARCH_TILE_W = 320;
const SEARCH_TILE_H = 160;
const SEARCH_N = 4000;

function paintSearchEquirect(planet, width, height) {
    const layers = Planet.rasterizeEquirect(planet.mesh, planet.map, width, height, 0);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    const {elev} = layers;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const eR = elev[y * width + Math.min(width - 1, x + 1)];
            const eL = elev[y * width + Math.max(0, x - 1)];
            const eD = elev[Math.min(height - 1, y + 1) * width + x];
            const eU = elev[Math.max(0, y - 1) * width + x];
            const light = Look.hillshade((eR - eL) * 0.5, -(eD - eU) * 0.5);
            const rgb = Look.elevRgb(Tectonics.elevationToMeters(elev[i]));
            const p = i * 4;
            img.data[p] = Math.round(clamp01(rgb[0] / 255 * light) * 255);
            img.data[p + 1] = Math.round(clamp01(rgb[1] / 255 * light) * 255);
            img.data[p + 2] = Math.round(clamp01(rgb[2] / 255 * light) * 255);
            img.data[p + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
}

const VARIANT_THUMB_W = 1024;
const VARIANT_THUMB_H = 512;

function paintSurfaceEquirect(planet, width, height) {
    const layers = Planet.rasterizeEquirect(planet.mesh, planet.map, width, height, 0);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    const {elev, moist, temp} = layers;
    for (let i = 0; i < width * height; i++) {
        const rgb = Look.surfaceAlbedo(elev[i], moist[i], temp[i]);
        const p = i * 4;
        img.data[p] = Math.round(clamp01(rgb[0]) * 255);
        img.data[p + 1] = Math.round(clamp01(rgb[1]) * 255);
        img.data[p + 2] = Math.round(clamp01(rgb[2]) * 255);
        img.data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
}

function variantThumbPlanetOpts(variant) {
    const tectonics = studio.lastResolved.options.tectonics;
    const values = Object.assign({}, variant.body, variant.values);
    return {
        seed: variant.seed,
        shapeSeed: variant.shapeSeed,
        n: N,
        p: values.plates != null ? values.plates : tectonics.plates,
        jitter,
        simulateTectonics: simulate_tectonics,
        simSteps: values.steps != null ? values.steps : tectonics.steps,
        polarStraits: values.polarStraits !== false,
        mergeOceanPlates: merge_ocean_plates,
        connectOceans: connect_oceans,
        baseOnly: true,
        project: variant.project || studio.project,
        values,
        quiet: true,
    };
}

function renderVariantThumb(variant) {
    if (!variant) return null;
    const planet = Planet.generatePlanet(variantThumbPlanetOpts(variant), {});
    return paintSurfaceEquirect(planet, VARIANT_THUMB_W, VARIANT_THUMB_H);
}

function renderWorkingThumb() {
    if (!mesh || !map) return null;
    return paintSurfaceEquirect({mesh, map}, VARIANT_THUMB_W, VARIANT_THUMB_H);
}

function renderSearchTile(ind) {
    const tectonics = studio.lastResolved.options.tectonics;
    const planet = Planet.generatePlanet({
        seed: ind.seed,
        n: SEARCH_N,
        jitter: 0.75,
        simulateTectonics: simulate_tectonics,
        polarStraits: tectonics.polarStraits !== false,
        mergeOceanPlates: merge_ocean_plates,
        connectOceans: connect_oceans,
        baseOnly: true,
        project: studio.project,
        values: Object.assign({}, studio.pins, ind.values),
        quiet: true,
    }, {});
    return paintSearchEquirect(planet, SEARCH_TILE_W, SEARCH_TILE_H);
}

function captureLayout() {
    if (!simMap || !simMap.r_elevation) return null;
    return LayoutArtifact.fromMap(simMap, {
        n: N,
        jitter,
        seed: studio.seed,
    });
}


function loadLayout(payload) {
    pending_layout = LayoutArtifact.usable(payload) ? LayoutArtifact.toFields(payload) : null;
    planetCache.layout = null;
}


function clearLayout() {
    pending_layout = null;
    planetCache.layout = null;
    delete planetCache.layoutFields;
}


function hasLayoutCache() {
    return !!pending_layout;
}


function captureShape() {
    if (!map || !map.r_elevation || mesh === simMesh) return null;
    const spacing = shapeSpacingKm;
    return ShapeArtifact.fromMap(map, {
        n: last_detail_n || (studio.lastResolved && studio.lastResolved.options.detail.n),
        jitter,
        shapeSeed: shape_seed || studio.shapeSeed || studio.seed,
        spacingKm: spacing,
    });
}


function runShape(seed) {
    shape_seed = (seed | 0) || studio.seed;
    detail_pass = true;
    generateMap();
    pending_shape = captureShape();
    detail_pass = false;
    return pending_shape;
}

function isShaped() {
    return !!(map && map.r_elevation && mesh && simMesh && mesh !== simMesh);
}


function loadShape(payload) {
    if (!ShapeArtifact.usable(payload)) {
        pending_shape = null;
        return;
    }
    pending_shape = payload;
    if (payload.shapeSeed) shape_seed = payload.shapeSeed | 0;
    generateMap();
}


function clearShape() {
    pending_shape = null;
}

function showLayout() {
    pending_shape = null;
    TdOverlay.setGridShown(false);
    TdOverlay.setHoverTile(null);
    generateMap();
}

function applyDrawMode(mode) {
    if (DRAW_MODES.indexOf(mode) === -1) return;
    const prev = drawMode;
    drawMode = mode;
    if ((prev === 'relief') !== (mode === 'relief')) TdOverlay.repaintSurfaces();
    draw();
}

Studio.mount(studio, {
    generateMesh,
    generateMap,
    draw,
    drawNow,
    renderVariantThumb,
    renderWorkingThumb,
    getViewMode: () => viewMode,
    getDrawMode: () => drawMode,
    getN: () => N,
    getJitter: () => jitter,
    getShapeSpacing: () => shapeSpacingKm,
    getRotation: () => rotation,
    setViewMode: applyViewMode,
    setDrawMode: applyDrawMode,
    setDrawPlateVectors(flag) { draw_plateVectors = flag; draw(); },
    setDrawPlateBoundaries(flag) { draw_plateBoundaries = flag; draw(); },
    setN(n) { N = n; clearLayout(); generateMesh(); },
    setJitter(value) { jitter = value; clearLayout(); generateMesh(); },
    setShapeSpacing(km) {
        shapeSpacingKm = Math.max(10, km | 0);
        pending_shape = null;
        generateMap();
    },
    setRotation(value) { rotation = value; draw(); },
    getProcess: () => ({
        simulateTectonics: simulate_tectonics,
        detailPass: detail_pass,
        mergeOceanPlates: merge_ocean_plates,
        connectOceans: connect_oceans,
    }),
    setProcess,
    runShape,
    loadShape,
    clearShape,
    captureShape,
    isShaped,
    showLayout,
    captureLayout,
    loadLayout,
    clearLayout,
    hasLayoutCache,
    setTdCrops,
    enableTdCrops,
    startTdJobPoll,
    renderSearchTile,
    refreshTdCropList,
});

/* Embed + capture adapter. The sidebar does not go through these. */
window.setN = newN => { N = newN; clearLayout(); generateMesh(); };
window.setJitter = newJitter => { jitter = newJitter; clearLayout(); generateMesh(); };
window.setP = newP => studio.setParam('plates', newP);
window.setRotation = newRotation => { rotation = newRotation; draw(); };
window.setDrawMode = newMode => {
    applyDrawMode(newMode);
    studio.syncModeButtons();
};
window.setViewMode = newMode => { applyViewMode(newMode); studio.syncModeButtons(); };
window.setDrawPlateVectors = flag => { draw_plateVectors = flag; draw(); };
window.setDrawPlateBoundaries = flag => { draw_plateBoundaries = flag; draw(); };
window.setTectonicOption = (key, value) => {
    if (!(key in Tectonics.DEFAULTS)) throw new Error(`unknown tectonic option: ${key}`);
    studio.setParam(key, value);
};
window.setDetailOption = (key, value) => {
    if (!(key in Detail.DEFAULTS)) throw new Error(`unknown detail option: ${key}`);
    studio.setParam(key, value);
};

setupDragRotation();
document.querySelector('.north-compass')?.addEventListener('click', reorientNorth);
document.querySelector('.view-reset')?.addEventListener('click', resetView);
document.querySelector('.measure-toggle')?.addEventListener('click', () => {
    Measure.setActive(!Measure.isActive());
    syncMeasureUi();
    paintMeasureOverlay();
});
restoreViewState();
syncViewModeDom();
{
    const globe = document.querySelector('.globe');
    const onViewport = () => {
        if (syncEquirectCanvasSize()) draw();
    };
    if (globe && typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(onViewport).observe(globe);
    }
    window.addEventListener('resize', onViewport);
}
studio.syncModeButtons();
const hasPicker = !!document.getElementById('project-page');
function startWorkspace() {
    if (!hasPicker || startup.skipPicker) {
        if (hasPicker) {
            Studio.writeStoredProject(studio.project);
            Studio.syncAddressBar(studio.project, studio.seed, studio.variant && studio.variant.id);
            Studio.showWorkspace(studio);
        }
        if (isShaped()) studio.setPlanetReady(true);
        else generateMesh();
    } else {
        Studio.showProjectPage(studio);
    }
    setupTdOverlay();
}
if (studio.ready) studio.ready.then(startWorkspace);
else startWorkspace();
