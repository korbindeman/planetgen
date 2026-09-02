/*
 * CPU renderer for headless captures. Same mesh, colormap and look as the
 * WebGL path: barycentric interpolation across the quad geometry, then
 * Look.surfaceAlbedo (or Look.reliefAlbedo) and a screen-space hillshade.
 * No browser, no GL. Palette, ice, lighting and overlay colours live in look.js.
 */
'use strict';

const {mat4, vec4} = require('gl-matrix');
const Tectonics = require('./tectonics');
const Planet = require('./planet');
const Look = require('./look');
const {encodePng, decodePng} = require('./png');

const GLOBE_SIZE = 1024;
const EQUIRECT_W = 2048;
const EQUIRECT_H = 1024;
const PI = Math.PI;
const TWO_PI = 2 * PI;
const POLE_LAT = PI / 2 - 1e-6;
const POLE_SNAP = 3 * PI / 180;
const {OVERLAY_LEGEND, PLATE_ARROW, BOUNDARY_INK} = Look;
const {surfaceAlbedo, reliefAlbedo, climateAlbedo, hillshade, northPoleLines} = Look;

function paintedOverlay(overlay) {
    return overlay === 'plates' || overlay === 'crust';
}

function surfaceLook(overlay) {
    if (overlay === 'relief') return 'relief';
    if (overlay === 'climate') return 'climate';
    return 'surface';
}

function globeProjection(yaw, rotation, zoom) {
    const u = mat4.create();
    mat4.scale(u, u, [zoom, zoom, 0.5]);
    /* ECEF is Z-up. Rx(-90) stands the globe north-up; negate X so east
       is right, matching the WebGL view and the equirect. */
    mat4.scale(u, u, [-1, 1, 1]);
    mat4.rotate(u, u, -Math.PI / 2, [1, 0, 0]);
    mat4.rotate(u, u, -rotation + yaw, [0, 0, 1]);
    return u;
}

function project(x, y, z, matrix) {
    const p = vec4.transformMat4([], [x, y, z, 1], matrix);
    const w = p[3] || 1;
    return {x: p[0] / w, y: p[1] / w, z: p[2] / w};
}

function toScreen(clip, width, height) {
    return {
        x: (clip.x * 0.5 + 0.5) * width,
        y: (-clip.y * 0.5 + 0.5) * height,
        z: clip.z,
    };
}

function makeTarget(width, height, fill) {
    const rgba = Buffer.alloc(width * height * 4, fill || 0);
    const zbuf = new Float32Array(width * height);
    zbuf.fill(Infinity);
    return {rgba, zbuf, width, height};
}

function putPixel(target, x, y, z, r, g, b, a) {
    if (x < 0 || y < 0 || x >= target.width || y >= target.height) return;
    const i = y * target.width + x;
    if (z >= target.zbuf[i]) return;
    target.zbuf[i] = z;
    const p = i * 4;
    const srcA = Math.max(0, Math.min(1, a));
    const dstA = target.rgba[p + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    const s = srcA, d = dstA * (1 - srcA);
    target.rgba[p] = Math.round((r * s + (target.rgba[p] / 255) * d) * 255 / (outA || 1));
    target.rgba[p + 1] = Math.round((g * s + (target.rgba[p + 1] / 255) * d) * 255 / (outA || 1));
    target.rgba[p + 2] = Math.round((b * s + (target.rgba[p + 2] / 255) * d) * 255 / (outA || 1));
    target.rgba[p + 3] = Math.round(outA * 255);
}

function putPixelOpaque(target, x, y, z, r, g, b) {
    if (x < 0 || y < 0 || x >= target.width || y >= target.height) return;
    const i = y * target.width + x;
    if (z >= target.zbuf[i]) return;
    target.zbuf[i] = z;
    const p = i * 4;
    target.rgba[p] = r;
    target.rgba[p + 1] = g;
    target.rgba[p + 2] = b;
    target.rgba[p + 3] = 255;
}

function rasterTriangle(target, a, b, c, shade, overlay, look) {
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(target.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(target.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    if (maxX < minX || maxY < minY) return;

    const v0x = b.x - a.x, v0y = b.y - a.y;
    const v1x = c.x - a.x, v1y = c.y - a.y;
    const den = v0x * v1y - v1x * v0y;
    if (Math.abs(den) < 1e-8) return;

    const dvdx = v1y / den, dwdx = -v0y / den;
    const dvdy = -v1x / den, dwdy = v0x / den;
    let light = 1;
    if (!overlay) {
        const dedx_img = (b.e - a.e) * dvdx + (c.e - a.e) * dwdx;
        const dedy_img = (b.e - a.e) * dvdy + (c.e - a.e) * dwdy;
        light = hillshade(dedx_img, -dedy_img);
    }

    for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5;
            const v2x = px - a.x, v2y = py - a.y;
            const v = (v2x * v1y - v1x * v2y) / den;
            const w = (v0x * v2y - v2x * v0y) / den;
            const u = 1 - v - w;
            if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;
            const z = u * a.z + v * b.z + w * c.z;
            if (overlay) {
                putPixelOpaque(target, x, y, z,
                    Math.round((u * a.r + v * b.r + w * c.r) * 255),
                    Math.round((u * a.g + v * b.g + w * c.g) * 255),
                    Math.round((u * a.b + v * b.b + w * c.b) * 255));
            } else {
                const e = u * a.e + v * b.e + w * c.e;
                const m = u * a.m + v * b.m + w * c.m;
                const t = u * a.t + v * b.t + w * c.t;
                const alb = look === 'relief' ? reliefAlbedo(e)
                    : look === 'climate' ? climateAlbedo(e, m)
                    : surfaceAlbedo(e, m, t);
                putPixelOpaque(target, x, y, z,
                    Math.round(Math.max(0, Math.min(1, alb[0] * light)) * 255),
                    Math.round(Math.max(0, Math.min(1, alb[1] * light)) * 255),
                    Math.round(Math.max(0, Math.min(1, alb[2] * light)) * 255));
            }
        }
    }
}

function vertexAttr(xyz, tm, idx, overlay) {
    if (overlay) {
        return {
            x: xyz[idx * 3], y: xyz[idx * 3 + 1], z: xyz[idx * 3 + 2],
            r: tm[idx * 3], g: tm[idx * 3 + 1], b: tm[idx * 3 + 2],
        };
    }
    return {
        x: xyz[idx * 3], y: xyz[idx * 3 + 1], z: xyz[idx * 3 + 2],
        e: tm[idx * 3], m: tm[idx * 3 + 1], t: tm[idx * 3 + 2],
    };
}

function projectAttr(v, matrix, width, height) {
    const clip = project(v.x, v.y, v.z, matrix);
    const s = toScreen(clip, width, height);
    return Object.assign({}, v, s);
}

function drawIndexed(target, xyz, tm, indices, matrix, overlay, look) {
    const {width, height} = target;
    const n = indices.length;
    for (let i = 0; i < n; i += 3) {
        const A = projectAttr(vertexAttr(xyz, tm, indices[i], overlay), matrix, width, height);
        const B = projectAttr(vertexAttr(xyz, tm, indices[i + 1], overlay), matrix, width, height);
        const C = projectAttr(vertexAttr(xyz, tm, indices[i + 2], overlay), matrix, width, height);
        if (A.z > 0.2 && B.z > 0.2 && C.z > 0.2) continue;
        if (A.x < -2 && B.x < -2 && C.x < -2) continue;
        if (A.x > width + 2 && B.x > width + 2 && C.x > width + 2) continue;
        if (A.y < -2 && B.y < -2 && C.y < -2) continue;
        if (A.y > height + 2 && B.y > height + 2 && C.y > height + 2) continue;
        rasterTriangle(target, A, B, C, 1, overlay, look);
    }
}

function drawUnindexed(target, xyz, tm, count, matrix, overlay, look) {
    const {width, height} = target;
    for (let i = 0; i < count; i += 3) {
        const A = projectAttr(vertexAttr(xyz, tm, i, overlay), matrix, width, height);
        const B = projectAttr(vertexAttr(xyz, tm, i + 1, overlay), matrix, width, height);
        const C = projectAttr(vertexAttr(xyz, tm, i + 2, overlay), matrix, width, height);
        rasterTriangle(target, A, B, C, 1, overlay, look);
    }
}

function blendOver(rgba, width, x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= width) return;
    const p = (y * width + x) * 4;
    if (p < 0 || p + 3 >= rgba.length) return;
    const srcA = Math.max(0, Math.min(1, a));
    const dstA = rgba[p + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    const s = srcA, d = (1 - srcA);
    rgba[p] = Math.round(r * 255 * s + rgba[p] * d);
    rgba[p + 1] = Math.round(g * 255 * s + rgba[p + 1] * d);
    rgba[p + 2] = Math.round(b * 255 * s + rgba[p + 2] * d);
    rgba[p + 3] = Math.round(outA * 255);
}

function drawLine(target, x0, y0, z0, x1, y1, z1, r, g, b, a, width) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return;
    const steps = Math.max(1, Math.ceil(len));
    const rad = Math.max(0.5, width / 2);
    const irad = Math.ceil(rad);
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = x0 + dx * t, y = y0 + dy * t, z = z0 + (z1 - z0) * t;
        const fade = Math.max(0, -2 * z);
        const aa = a * fade;
        if (aa <= 0) continue;
        const cx = Math.round(x), cy = Math.round(y);
        for (let oy = -irad; oy <= irad; oy++) {
            for (let ox = -irad; ox <= irad; ox++) {
                if (ox * ox + oy * oy > rad * rad + 0.2) continue;
                blendOver(target.rgba, target.width, cx + ox, cy + oy, r, g, b, aa);
            }
        }
    }
}

function plateBoundarySegments(mesh, map) {
    const {t_xyz, r_plate} = map;
    const segs = [];
    for (let s = 0; s < mesh.numSides; s++) {
        const begin_r = mesh.s_begin_r(s), end_r = mesh.s_end_r(s);
        if (r_plate[begin_r] === r_plate[end_r]) continue;
        const inner_t = mesh.s_inner_t(s), outer_t = mesh.s_outer_t(s);
        segs.push([
            t_xyz[3 * inner_t], t_xyz[3 * inner_t + 1], t_xyz[3 * inner_t + 2],
            t_xyz[3 * outer_t], t_xyz[3 * outer_t + 1], t_xyz[3 * outer_t + 2],
        ]);
    }
    return segs;
}

function drawBoundariesGlobe(target, segs, matrix, ink) {
    const {width, height} = target;
    for (const s of segs) {
        const a = toScreen(project(s[0], s[1], s[2], matrix), width, height);
        const b = toScreen(project(s[3], s[4], s[5], matrix), width, height);
        drawLine(target, a.x, a.y, a.z, b.x, b.y, b.z, ink[0], ink[1], ink[2], ink[3], 1.4);
    }
}

function drawNorthPole(target, matrix) {
    const {width, height} = target;
    for (const line of northPoleLines()) {
        const a = toScreen(project(line.a[0], line.a[1], line.a[2], matrix), width, height);
        const b = toScreen(project(line.b[0], line.b[1], line.b[2], matrix), width, height);
        drawLine(target, a.x, a.y, a.z, b.x, b.y, b.z, line.ca[0], line.ca[1], line.ca[2], line.ca[3], 1.6);
    }
}

function isPoleLat(lat) {
    return Math.abs(lat) > POLE_LAT;
}

function vertexLonLat(xyz, tm, idx, overlay) {
    const x = xyz[idx * 3], y = xyz[idx * 3 + 1], z = xyz[idx * 3 + 2];
    let lat = Math.asin(Math.max(-1, Math.min(1, z)));
    if (PI / 2 - Math.abs(lat) < POLE_SNAP) lat = Math.sign(lat || z) * (PI / 2);
    const tm0 = tm[idx * 3], tm1 = tm[idx * 3 + 1], tm2 = tm[idx * 3 + 2];
    return overlay
        ? {lon: Math.atan2(y, x), lat, r: tm0, g: tm1, b: tm2}
        : {lon: Math.atan2(y, x), lat, e: tm0, m: tm1, t: tm2};
}

function emitEquirectVerts(out, verts, shift, overlay) {
    for (let i = 0; i < 3; i++) {
        const v = verts[i];
        const y = Math.max(-1.02, Math.min(1.02, (2 * v.lat) / PI));
        if (overlay) out.push({x: (v.lon + shift) / PI, y, z: -0.5, r: v.r, g: v.g, b: v.b});
        else out.push({x: (v.lon + shift) / PI, y, z: -0.5, e: v.e, m: v.m, t: v.t});
    }
}

function emitEquirectTriangle(out, verts, overlay) {
    const v = [
        Object.assign({}, verts[0]),
        Object.assign({}, verts[1]),
        Object.assign({}, verts[2]),
    ];
    for (let i = 1; i < 3; i++) {
        while (v[i].lon - v[0].lon > PI) v[i].lon -= TWO_PI;
        while (v[0].lon - v[i].lon > PI) v[i].lon += TWO_PI;
    }
    emitEquirectVerts(out, v, 0, overlay);
    const minL = Math.min(v[0].lon, v[1].lon, v[2].lon);
    const maxL = Math.max(v[0].lon, v[1].lon, v[2].lon);
    if (minL < -PI) emitEquirectVerts(out, v, TWO_PI, overlay);
    if (maxL > PI) emitEquirectVerts(out, v, -TWO_PI, overlay);
}

function appendEquirectTriangle(out, verts, overlay) {
    const poles = [];
    for (let i = 0; i < 3; i++) if (isPoleLat(verts[i].lat)) poles.push(i);
    if (poles.length === 1) {
        const p = poles[0];
        const a = verts[(p + 1) % 3];
        const b = verts[(p + 2) % 3];
        let lonA = a.lon, lonB = b.lon;
        while (lonB - lonA > PI) lonB -= TWO_PI;
        while (lonA - lonB > PI) lonB += TWO_PI;
        const poleLat = Math.sign(verts[p].lat) * (PI / 2);
        const poleA = Object.assign({}, verts[p], {lon: lonA, lat: poleLat});
        const poleB = Object.assign({}, verts[p], {lon: lonB, lat: poleLat});
        const aFix = Object.assign({}, a, {lon: lonA});
        const bFix = Object.assign({}, b, {lon: lonB});
        emitEquirectTriangle(out, [aFix, bFix, poleB], overlay);
        emitEquirectTriangle(out, [aFix, poleB, poleA], overlay);
        return;
    }
    emitEquirectTriangle(out, verts, overlay);
}

function buildEquirectTris(xyz, tm, indices, overlay) {
    const out = [];
    const n = indices.length;
    for (let i = 0; i < n; i += 3) {
        appendEquirectTriangle(out, [
            vertexLonLat(xyz, tm, indices[i], overlay),
            vertexLonLat(xyz, tm, indices[i + 1], overlay),
            vertexLonLat(xyz, tm, indices[i + 2], overlay),
        ], overlay);
    }
    return out;
}

function equirectMatrix(panX, xshift) {
    const p = mat4.create();
    mat4.translate(p, p, [panX + xshift, 0, 0]);
    return p;
}

function wrapPanX(x) {
    return ((x + 1) % 2 + 2) % 2 - 1;
}

function drawEquirectSurface(target, tris, panX, overlay, look) {
    const {width, height} = target;
    for (const xshift of [-2, 0, 2]) {
        const matrix = equirectMatrix(panX, xshift);
        for (let i = 0; i < tris.length; i += 3) {
            const A = projectAttr(tris[i], matrix, width, height);
            const B = projectAttr(tris[i + 1], matrix, width, height);
            const C = projectAttr(tris[i + 2], matrix, width, height);
            rasterTriangle(target, A, B, C, 1, overlay, look);
        }
    }
}

function appendEquirectSegment(out, ax, ay, az, bx, by, bz) {
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
        out.push({
            a: [(a.lon + shift) / PI, (2 * a.lat) / PI, -0.5],
            b: [(b.lon + shift) / PI, (2 * b.lat) / PI, -0.5],
        });
    }
}

function drawEquirectBoundaries(target, segs, panX, ink) {
    const {width, height} = target;
    const lines = [];
    for (const s of segs) appendEquirectSegment(lines, s[0], s[1], s[2], s[3], s[4], s[5]);
    for (const xshift of [-2, 0, 2]) {
        const matrix = equirectMatrix(panX, xshift);
        for (const line of lines) {
            const a = toScreen(project(line.a[0], line.a[1], line.a[2], matrix), width, height);
            const b = toScreen(project(line.b[0], line.b[1], line.b[2], matrix), width, height);
            drawLine(target, a.x, a.y, a.z, b.x, b.y, b.z, ink[0], ink[1], ink[2], ink[3], 1.2);
        }
    }
}

/* 5x7 glyphs, 5 columns, LSB = top row. Printable ASCII 32-126. */
const FONT = [
    0,0,0,0,0, 0,0,95,0,0, 0,7,0,7,0, 20,127,20,127,20, 36,42,127,42,18,
    35,19,8,100,98, 54,73,85,34,80, 0,5,3,0,0, 0,28,34,65,0, 0,65,34,28,0,
    20,8,62,8,20, 8,8,62,8,8, 0,80,48,0,0, 8,8,8,8,8, 0,96,96,0,0, 32,16,8,4,2,
    62,81,73,69,62, 0,66,127,64,0, 66,97,81,73,70, 33,65,69,75,49, 24,20,18,127,16,
    39,69,69,69,57, 60,74,73,73,48, 1,113,9,5,3, 54,73,73,73,54, 6,73,73,41,30,
    0,54,54,0,0, 0,86,54,0,0, 8,20,34,65,0, 20,20,20,20,20, 0,65,34,20,8, 2,1,81,9,6,
    62,65,93,89,78, 124,18,17,18,124, 127,73,73,73,54, 62,65,65,65,34, 127,65,65,34,28,
    127,73,73,73,65, 127,9,9,9,1, 62,65,73,73,122, 127,8,8,8,127, 0,65,127,65,0,
    32,64,65,63,1, 127,8,20,34,65, 127,64,64,64,64, 127,2,12,2,127, 127,4,8,16,127,
    62,65,65,65,62, 127,9,9,9,6, 62,65,81,33,94, 127,9,25,41,70, 38,73,73,73,50,
    1,1,127,1,1, 63,64,64,64,63, 31,32,64,32,31, 63,64,56,64,63, 99,20,8,20,99,
    7,8,112,8,7, 97,81,73,69,67, 0,127,65,65,0, 2,4,8,16,32, 0,65,65,127,0,
    4,2,1,2,4, 64,64,64,64,64, 0,1,2,4,0, 32,84,84,84,120, 127,68,68,68,56,
    56,68,68,68,32, 56,68,68,68,127, 56,84,84,84,24, 8,126,9,1,2, 8,84,84,84,60,
    127,4,4,4,120, 0,68,125,64,0, 32,64,64,61,0, 127,16,40,68,0, 0,65,127,64,0,
    124,4,120,4,120, 124,8,4,4,120, 56,68,68,68,56, 124,20,20,20,8, 8,20,20,20,124,
    124,8,4,4,8, 72,84,84,84,32, 4,63,68,64,32, 60,64,64,32,124, 28,32,64,32,28,
    60,64,48,64,60, 68,40,16,40,68, 12,80,80,80,60, 68,100,84,76,68, 0,8,54,65,0,
    0,0,119,0,0, 0,65,54,8,0, 8,4,8,16,8,
];

function glyphCol(ch, col) {
    const i = ch.charCodeAt(0);
    if (i < 32 || i > 126) return 0;
    return FONT[(i - 32) * 5 + col];
}

function drawChar(rgba, width, height, x, y, ch, r, g, b, scale) {
    for (let col = 0; col < 5; col++) {
        const bits = glyphCol(ch, col);
        for (let row = 0; row < 7; row++) {
            if (!((bits >> row) & 1)) continue;
            for (let sy = 0; sy < scale; sy++) {
                for (let sx = 0; sx < scale; sx++) {
                    const px = x + col * scale + sx;
                    const py = y + row * scale + sy;
                    if (px < 0 || py < 0 || px >= width || py >= height) continue;
                    const p = (py * width + px) * 4;
                    rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = b; rgba[p + 3] = 255;
                }
            }
        }
    }
}

function textWidth(text, scale) {
    return text.length * 6 * scale;
}

function drawText(rgba, width, height, text, x, y, r, g, b, scale, halo) {
    scale = scale || 2;
    if (halo) {
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            let cx = x + dx;
            for (const ch of text) {
                drawChar(rgba, width, height, cx, y + dy, ch, 17, 17, 17, scale);
                cx += 6 * scale;
            }
        }
    }
    let cx = x;
    for (const ch of text) {
        drawChar(rgba, width, height, cx, y, ch, r, g, b, scale);
        cx += 6 * scale;
    }
}

function fillRect(rgba, width, height, x, y, w, h, r, g, b, a) {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    const x1 = Math.min(width, x0 + (w | 0)), y1 = Math.min(height, y0 + (h | 0));
    for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
            blendOver(rgba, width, px, py, r / 255, g / 255, b / 255, a == null ? 1 : a);
        }
    }
}

function blit(dst, dw, dx, dy, src, sw, sh, tw, th) {
    const dh = dst.length / (dw * 4);
    for (let y = 0; y < th; y++) {
        const sy = Math.min(sh - 1, ((y + 0.5) * sh / th) | 0);
        const dyi = dy + y;
        if (dyi < 0 || dyi >= dh) continue;
        for (let x = 0; x < tw; x++) {
            const sx = Math.min(sw - 1, ((x + 0.5) * sw / tw) | 0);
            const dxi = dx + x;
            if (dxi < 0 || dxi >= dw) continue;
            const si = (sy * sw + sx) * 4;
            const di = (dyi * dw + dxi) * 4;
            const a = src[si + 3] / 255;
            if (a <= 0) continue;
            if (a >= 1) {
                dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = 255;
            } else {
                dst[di] = Math.round(src[si] * a + dst[di] * (1 - a));
                dst[di + 1] = Math.round(src[si + 1] * a + dst[di + 1] * (1 - a));
                dst[di + 2] = Math.round(src[si + 2] * a + dst[di + 2] * (1 - a));
                dst[di + 3] = 255;
            }
        }
    }
}

function strokeArrow(rgba, width, height, x0, y0, x1, y1, r, g, b, lw) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 10) return;
    const ux = dx / len, uy = dy / len;
    const head = Math.min(16, len * 0.32);
    const stamp = (ax, ay, bx, by) => {
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
        const rad = Math.max(1, lw / 2);
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
            const cx = Math.round(x), cy = Math.round(y);
            const ir = Math.ceil(rad);
            for (let oy = -ir; oy <= ir; oy++) {
                for (let ox = -ir; ox <= ir; ox++) {
                    if (ox * ox + oy * oy > rad * rad) continue;
                    const px = cx + ox, py = cy + oy;
                    if (px < 0 || py < 0 || px >= width || py >= height) continue;
                    const p = (py * width + px) * 4;
                    rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = b; rgba[p + 3] = 255;
                }
            }
        }
    };
    stamp(x0, y0, x1, y1);
    stamp(x1, y1, x1 - ux * head + uy * head * 0.55, y1 - uy * head - ux * head * 0.55);
    stamp(x1, y1, x1 - ux * head - uy * head * 0.55, y1 - uy * head + ux * head * 0.55);
}

function paintPlateAnnotations(rgba, width, height, planet, mode, projection, xshift) {
    const {mesh, map} = planet;
    if (!map.plates || !map.plate_centroid) return;
    const toCanvas = (xyz) => {
        if (mode === 'globe') {
            return toScreen(project(xyz[0], xyz[1], xyz[2], projection), width, height);
        }
        const lon = Math.atan2(xyz[1], xyz[0]) + xshift * Math.PI;
        const lat = Math.asin(Math.max(-1, Math.min(1, xyz[2])));
        const clip = {x: lon / PI, y: (2 * lat) / PI, z: -0.5};
        return toScreen(clip, width, height);
    };
    const area = new Int32Array(map.plates.length);
    for (let r = 0; r < mesh.numRegions; r++) area[map.r_plate[r]]++;

    for (let p = 0; p < map.plates.length; p++) {
        const plate = map.plates[p];
        const c = map.plate_centroid[p];
        if (!c || area[p] / mesh.numRegions < 0.012) continue;
        const v = Tectonics.plateVelocity([], plate.pole, plate.omega, c);
        v[0] /= PLATE_ARROW.referenceOmega;
        v[1] /= PLATE_ARROW.referenceOmega;
        v[2] /= PLATE_ARROW.referenceOmega;
        const start = toCanvas(c);
        if (!Number.isFinite(start.x) || !Number.isFinite(start.y)) continue;
        if (mode === 'globe' && start.z > 0.02) continue;
        if (start.x < -40 || start.x > width + 40 || start.y < -40 || start.y > height + 40) continue;
        start.x = Math.min(width - 16, Math.max(16, start.x));
        start.y = Math.min(height - 16, Math.max(16, start.y));
        const tip = [
            c[0] + v[0] * PLATE_ARROW.scale,
            c[1] + v[1] * PLATE_ARROW.scale,
            c[2] + v[2] * PLATE_ARROW.scale,
        ];
        let end = toCanvas(tip);
        const drawBoth = (sx, sy, ex, ey) => {
            const [hr, hg, hb] = PLATE_ARROW.halo;
            const [ar, ag, ab] = PLATE_ARROW.rgb;
            strokeArrow(rgba, width, height, sx, sy, ex, ey, hr, hg, hb, 6);
            strokeArrow(rgba, width, height, sx, sy, ex, ey, ar, ag, ab, 2.4);
        };
        if (mode === 'equirect' && Math.abs(end.x - start.x) > width * 0.5) {
            const shift = end.x > start.x ? -width : width;
            drawBoth(start.x, start.y, end.x + shift, start.y + (end.y - start.y));
            drawBoth(start.x - shift, start.y, end.x, end.y);
        } else {
            let dx = end.x - start.x, dy = end.y - start.y;
            let len = Math.hypot(dx, dy);
            if (len < 22 && len > 0.5) {
                const s = 22 / len;
                end = {x: start.x + dx * s, y: start.y + dy * s};
            }
            drawBoth(start.x, start.y, end.x, end.y);
        }
        const name = String(plate.name);
        const tw = textWidth(name, 2);
        const [lr, lg, lb] = PLATE_ARROW.label;
        drawText(rgba, width, height, name, start.x - tw / 2, start.y - 22, lr, lg, lb, 2, true);
        if (plate.bornMyr > 0) {
            const age = `${(map.elapsedMyr - plate.bornMyr).toFixed(0)} Myr`;
            const aw = textWidth(age, 1);
            drawText(rgba, width, height, age, start.x - aw / 2, start.y + 8, lr, lg, lb, 1, true);
        }
    }
}

function surfaceTm(planet, overlay) {
    if (paintedOverlay(overlay)) return Planet.buildOverlayColorTm(planet.mesh, planet.map, overlay);
    return planet.geometry.tm;
}

function renderGlobe(planet, opts = {}) {
    const size = opts.size || GLOBE_SIZE;
    const overlay = opts.overlay || null;
    const painted = paintedOverlay(overlay);
    const look = surfaceLook(overlay);
    const yaw = opts.yaw || 0;
    const rotation = opts.rotation == null ? -1 : opts.rotation;
    const zoom = opts.zoom == null ? 1 : opts.zoom;
    const matrix = globeProjection(yaw, rotation, zoom);
    const target = makeTarget(size, size);
    const tm = surfaceTm(planet, overlay);
    drawIndexed(target, planet.geometry.xyz, tm, planet.geometry.I, matrix, painted, look);
    if (painted && overlay !== 'crust') {
        drawBoundariesGlobe(target, plateBoundarySegments(planet.mesh, planet.map), matrix, BOUNDARY_INK);
    }
    if (!painted) drawNorthPole(target, matrix);
    if (overlay === 'plates') {
        paintPlateAnnotations(target.rgba, size, size, planet, 'globe', matrix, 0);
    }
    return target;
}

function renderEquirect(planet, opts = {}) {
    const width = opts.width || EQUIRECT_W;
    const height = opts.height || EQUIRECT_H;
    const overlay = opts.overlay || null;
    const painted = paintedOverlay(overlay);
    const look = surfaceLook(overlay);
    const lon0 = Number(opts.lon0) || 0;
    const panX = wrapPanX(-(lon0 / 180));
    const tm = surfaceTm(planet, overlay);
    const tris = buildEquirectTris(planet.geometry.xyz, tm, planet.geometry.I, painted);
    const target = makeTarget(width, height);
    drawEquirectSurface(target, tris, panX, painted, look);
    if (painted && overlay !== 'crust') {
        const ink = BOUNDARY_INK;
        drawEquirectBoundaries(target, plateBoundarySegments(planet.mesh, planet.map), panX, ink);
    }
    if (overlay === 'plates') {
        for (const shift of [-2, 0, 2]) {
            paintPlateAnnotations(target.rgba, width, height, planet, 'equirect', null, shift);
        }
    }
    return target;
}

function captureGlobe(planet, opts = {}) {
    const overlay = opts.overlay || null;
    const cell = 512;
    const labelH = 28;
    const legendH = overlay ? 30 : 0;
    const yaws = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
    const labels = ['0 deg', '90 deg', '180 deg', '270 deg'];
    const width = cell * 2;
    const height = (cell + labelH) * 2 + legendH;
    const rgba = Buffer.alloc(width * height * 4, 255);
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255;
    }
    for (let i = 0; i < yaws.length; i++) {
        const view = renderGlobe(planet, {yaw: yaws[i], overlay, rotation: opts.rotation, zoom: 1});
        const x = (i % 2) * cell;
        const y = Math.floor(i / 2) * (cell + labelH);
        drawText(rgba, width, height, labels[i], x + 10, y + 6, 17, 17, 17, 2, false);
        blit(rgba, width, x, y + labelH, view.rgba, view.width, view.height, cell, cell);
    }
    if (overlay) {
        drawText(rgba, width, height, OVERLAY_LEGEND[overlay], 10, height - 22, 17, 17, 17, 2, false);
    }
    return encodePng(rgba, width, height);
}

function captureEquirect(planet, opts = {}) {
    const overlay = opts.overlay || null;
    const view = renderEquirect(planet, opts);
    if (!overlay) return encodePng(view.rgba, view.width, view.height);
    const legendH = 32;
    const width = view.width;
    const height = view.height + legendH;
    const rgba = Buffer.alloc(width * height * 4, 255);
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255;
    }
    drawText(rgba, width, height, OVERLAY_LEGEND[overlay], 10, 8, 17, 17, 17, 2, false);
    blit(rgba, width, 0, legendH, view.rgba, view.width, view.height, view.width, view.height);
    return encodePng(rgba, width, height);
}

function compareSheet(beforePng, afterPng, opts = {}) {
    const before = decodePng(beforePng);
    const after = decodePng(afterPng);
    const gap = 24;
    const title = opts.title || null;
    const titleH = title ? 28 : 0;
    const labelH = 36;
    const width = before.width + gap + after.width;
    const height = Math.max(before.height, after.height) + labelH + titleH;
    const rgba = Buffer.alloc(width * height * 4, 255);
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255;
    }
    if (title) drawText(rgba, width, height, title, 10, 8, 17, 17, 17, 2, false);
    drawText(rgba, width, height, opts.left ?? 'Before', 10, titleH + 10, 17, 17, 17, 2, false);
    drawText(rgba, width, height, opts.right ?? 'After', before.width + gap + 10, titleH + 10, 17, 17, 17, 2, false);
    blit(rgba, width, 0, titleH + labelH, before.rgba, before.width, before.height, before.width, before.height);
    blit(rgba, width, before.width + gap, titleH + labelH, after.rgba, after.width, after.height, after.width, after.height);
    return encodePng(rgba, width, height);
}

function seedSheet(tiles, view) {
    const images = tiles.map((t) => decodePng(t.png));
    const tileW = view === 'globe' ? 420 : 640;
    const aspect = images[0].height / images[0].width;
    const tileH = Math.round(tileW * aspect);
    const labelH = 24;
    const cols = Math.min(3, images.length);
    const rows = Math.ceil(images.length / cols);
    const width = cols * tileW;
    const height = rows * (tileH + labelH);
    const rgba = Buffer.alloc(width * height * 4, 255);
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255;
    }
    images.forEach((img, i) => {
        const x = (i % cols) * tileW;
        const y = Math.floor(i / cols) * (tileH + labelH);
        drawText(rgba, width, height, `seed ${tiles[i].seed}`, x + 8, y + 4, 17, 17, 17, 2, false);
        blit(rgba, width, x, y + labelH, img.rgba, img.width, img.height, tileW, tileH);
    });
    return encodePng(rgba, width, height);
}

function lerp(a, b, t) { return a + (b - a) * t; }

const {elevRgb, tempRgb, precipRgb, hillshadeField, CROP_COLORS} = Look;

function putLayerRgb(rgba, width, x, y, w, h, rgbAt, shade) {
    for (let i = 0, py = 0; py < h; py++) {
        for (let px = 0; px < w; px++, i++) {
            const c = rgbAt(i);
            const s = shade ? 0.42 + 0.58 * shade[i] : 1;
            const di = ((y + py) * width + (x + px)) * 4;
            rgba[di] = Math.round(c[0] * s);
            rgba[di + 1] = Math.round(c[1] * s);
            rgba[di + 2] = Math.round(c[2] * s);
            rgba[di + 3] = 255;
        }
    }
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

function strokeRect(rgba, width, height, x, y, w, h, r, g, b) {
    for (let i = 0; i < w; i++) {
        blendOver(rgba, width, (x + i) | 0, y | 0, r / 255, g / 255, b / 255, 1);
        blendOver(rgba, width, (x + i) | 0, (y + h) | 0, r / 255, g / 255, b / 255, 1);
    }
    for (let i = 0; i < h; i++) {
        blendOver(rgba, width, x | 0, (y + i) | 0, r / 255, g / 255, b / 255, 1);
        blendOver(rgba, width, (x + w) | 0, (y + i) | 0, r / 255, g / 255, b / 255, 1);
    }
}

function drawWorldSheet(world, crops, cropLayers) {
    const w = world.width, h = world.height;
    const gap = 16;
    const label = 28;
    const cropScale = 6;
    const cropW = crops.length ? cropLayers[0].width * cropScale : 0;
    const cropH = crops.length ? cropLayers[0].height * cropScale : 0;
    const width = w * 2 + gap;
    const height = label + h + gap + label + h + gap + label + cropH;
    const rgba = Buffer.alloc(width * height * 4, 255);
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255;
    }
    const shade = hillshadeField(world.heightmap, w, h);
    drawText(rgba, width, height, 'Coarse elevation (hypsometric + hillshade)', 0, 6, 17, 17, 17, 2, false);
    putLayerRgb(rgba, width, 0, label, w, h, (i) => elevRgb(world.heightmap[i]), shade);
    drawText(rgba, width, height, 'Temperature (C)', w + gap, 6, 17, 17, 17, 2, false);
    putLayerRgb(rgba, width, w + gap, label, w, h, (i) => tempRgb(world.temperature[i]), null);

    const row2 = label + h + gap + label;
    drawText(rgba, width, height, 'Precipitation (mm / yr)', 0, row2 - 22, 17, 17, 17, 2, false);
    putLayerRgb(rgba, width, 0, row2, w, h, (i) => precipRgb(world.precipitation[i]), null);
    drawText(rgba, width, height, 'Crop windows on elevation', w + gap, row2 - 22, 17, 17, 17, 2, false);
    putLayerRgb(rgba, width, w + gap, row2, w, h, (i) => elevRgb(world.heightmap[i]), shade);

    const colors = CROP_COLORS;
    crops.forEach((crop, i) => {
        const [r, g, b] = colors[i % colors.length];
        strokeRect(rgba, width, height, w + gap + crop.x, row2 + crop.y, crop.winW, crop.winH, r, g, b);
        drawText(rgba, width, height, crop.name, w + gap + crop.x + 3, row2 + Math.max(2, crop.y - 14), r, g, b, 2, true);
    });

    const row3 = row2 + h + gap + label;
    crops.forEach((crop, i) => {
        const layers = cropLayers[i];
        const upE = upsampleBilinear(layers.heightmap, layers.width, layers.height, cropW, cropH);
        const upShade = hillshadeField(upE, cropW, cropH);
        const x = i * (cropW + gap);
        drawText(rgba, width, height, `Crop "${crop.name}"  ${layers.width}x${layers.height} coarse cells`, x, row3 - 22, 17, 17, 17, 2, false);
        putLayerRgb(rgba, width, x, row3, cropW, cropH, (j) => elevRgb(upE[j]), upShade);
        const [r, g, b] = colors[i % colors.length];
        strokeRect(rgba, width, height, x, row3, cropW - 1, cropH - 1, r, g, b);
    });
    return encodePng(rgba, width, height);
}

function drawCropPreview(layers, name) {
    const scale = 8;
    const w = layers.width * scale;
    const h = layers.height * scale;
    const gap = 12;
    const label = 26;
    const width = w * 3 + gap * 2;
    const height = label + h;
    const rgba = Buffer.alloc(width * height * 4, 255);
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255;
    }
    const upE = upsampleBilinear(layers.heightmap, layers.width, layers.height, w, h);
    const upT = upsampleBilinear(layers.temperature, layers.width, layers.height, w, h);
    const upP = upsampleBilinear(layers.precipitation, layers.width, layers.height, w, h);
    const shade = hillshadeField(upE, w, h);
    drawText(rgba, width, height, `${name} elevation`, 0, 6, 17, 17, 17, 2, false);
    putLayerRgb(rgba, width, 0, label, w, h, (i) => elevRgb(upE[i]), shade);
    drawText(rgba, width, height, 'temperature', w + gap, 6, 17, 17, 17, 2, false);
    putLayerRgb(rgba, width, w + gap, label, w, h, (i) => tempRgb(upT[i]), null);
    drawText(rgba, width, height, 'precipitation', (w + gap) * 2, 6, 17, 17, 17, 2, false);
    putLayerRgb(rgba, width, (w + gap) * 2, label, w, h, (i) => precipRgb(upP[i]), null);
    return encodePng(rgba, width, height);
}

module.exports = {
    GLOBE_SIZE,
    EQUIRECT_W,
    EQUIRECT_H,
    OVERLAY_LEGEND,
    renderGlobe,
    renderEquirect,
    captureGlobe,
    captureEquirect,
    compareSheet,
    seedSheet,
    drawWorldSheet,
    drawCropPreview,
    encodePng,
};
