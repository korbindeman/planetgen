/*
 * Authored strokes on the live globe.
 *
 * Two brushes. Coast grows or eats the sea-level contour and keeps
 * the new shore jagged. Relief paints the local high or the local
 * low: the target comes from the neighbourhood, not a fixed height.
 * The brush is a screen-space disk: the same pixel size at every zoom.
 *
 * Coasts stay the sea-level contour. Math is browser-free so
 * `bun run check:sculpt` can pin a dab and an undo.
 */
'use strict';

const Tectonics = require('./tectonics');
const Cube = require('./cubesphere');
const Look = require('./look');
const TdOverlay = require('./td-overlay');

const TOOLS = ['coast', 'relief'];
const HISTORY_MAX = 80;
const ISOSTASY_M_PER_KM = 145;
const DEFAULT_RADIUS_PX = 56;
const MIN_RADIUS_PX = 16;
const MAX_RADIUS_PX = 200;
const DEFAULT_STRENGTH = 0.6;
const MIN_STRENGTH = 0.08;
const MAX_STRENGTH = 1;
const DAB_FRAC = 0.22;
const HALO_SCALE = 1.75;
const COAST_LAND_LO_M = 18;
const COAST_LAND_HI_M = 280;
const COAST_WATER_LO_M = -280;
const COAST_WATER_HI_M = -12;
const RELIEF_LAND_FLOOR_M = 8;
const RELIEF_WATER_CEIL_M = -12;

const HINTS = {
    coast: 'Drag to grow land. Shift eats the shore.',
    relief: 'Drag to paint the local high. Shift paints the local low.',
};

let tool = null;
let radiusPx = DEFAULT_RADIUS_PX;
let strength = DEFAULT_STRENGTH;
let invertHeld = false;
let hover = null;
let live = null;
let history = [];
let historyIndex = -1;
let hintR = 0;
const outR = [];


function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
}


function falloff(t) {
    if (t >= 1) return 0;
    if (t <= 0) return 1;
    const u = 1 - t * t;
    return u * u;
}


function angleBetween(ax, ay, az, bx, by, bz) {
    const d = ax * bx + ay * by + az * bz;
    const c = d < -1 ? -1 : d > 1 ? 1 : d;
    return Math.acos(c);
}


function lonLatToXyz(lon, lat) {
    return Cube.lonLatToXyz(lon, lat);
}


function cellAngle(mesh) {
    const n = mesh && mesh.numRegions;
    if (!(n > 0)) return 0.05;
    return 2 * Math.sqrt(Math.PI / n);
}


function screenToRadiusRad(a, b, fallback) {
    if (a && b && Number.isFinite(a.lon) && Number.isFinite(b.lon)) {
        const A = lonLatToXyz(a.lon, a.lat);
        const B = lonLatToXyz(b.lon, b.lat);
        const ang = angleBetween(A[0], A[1], A[2], B[0], B[1], B[2]);
        if (ang > 1e-5) return ang;
    }
    return fallback > 0 ? fallback : 0.08;
}


function gatherDisk(mesh, r_xyz, center, radiusRad, startHint) {
    const cells = [];
    const weights = [];
    if (!mesh || !r_xyz || !(radiusRad > 0)) return {cells, weights, hint: startHint | 0};
    if (hintR >= mesh.numRegions) hintR = 0;
    const start = Tectonics.nearestRegion(
        mesh, r_xyz, center, startHint == null ? hintR : startHint, outR,
    );
    hintR = start;
    const seen = new Uint8Array(mesh.numRegions);
    const queue = [start];
    seen[start] = 1;
    let q = 0;
    while (q < queue.length) {
        const r = queue[q++];
        const ang = angleBetween(
            center[0], center[1], center[2],
            r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2],
        );
        if (ang > radiusRad) continue;
        cells.push(r);
        weights.push(falloff(ang / radiusRad));
        mesh.r_circulate_r(outR, r);
        for (let i = 0; i < outR.length; i++) {
            const n = outR[i];
            if (n >= 0 && !seen[n]) {
                seen[n] = 1;
                queue.push(n);
            }
        }
    }
    return {cells, weights, hint: start};
}


function seaLevelThicknessKm(opts) {
    if (opts && Number.isFinite(opts.seaLevelThicknessKm)) return opts.seaLevelThicknessKm;
    return Tectonics.DEFAULTS.seaLevelThicknessKm;
}


function syncCell(map, r, oldMeters, opts) {
    const meters = map.r_meters;
    const elev = map.r_elevation;
    if (!meters || !elev) return;
    const m = meters[r];
    const grain = elev[r] - Tectonics.metersToElevation(oldMeters);
    elev[r] = Tectonics.metersToElevation(m) + grain;
    if (m >= 0 && map.r_crust_type && map.r_crust_type[r] !== Tectonics.CRUST_CONTINENTAL) {
        map.r_crust_type[r] = Tectonics.CRUST_CONTINENTAL;
    }
    if (m >= 0 && map.r_thickness) {
        const need = seaLevelThicknessKm(opts) + m / ISOSTASY_M_PER_KM;
        if (map.r_thickness[r] < need) map.r_thickness[r] = need;
    }
}


function remember(stroke, map, r) {
    if (stroke.snap.has(r)) return stroke.snap.get(r);
    const rec = {
        meters: map.r_meters[r],
        elevation: map.r_elevation[r],
        type: map.r_crust_type ? map.r_crust_type[r] : 0,
        thickness: map.r_thickness ? map.r_thickness[r] : 0,
        orogeny: map.r_orogeny ? map.r_orogeny[r] : 0,
    };
    stroke.snap.set(r, rec);
    return rec;
}


function writeMeters(map, r, next, opts, stroke) {
    const prev = map.r_meters[r];
    if (stroke) remember(stroke, map, r);
    if (prev === next) return false;
    map.r_meters[r] = next;
    syncCell(map, r, prev, opts);
    return true;
}


function restoreRecord(map, r, rec) {
    map.r_meters[r] = rec.meters;
    map.r_elevation[r] = rec.elevation;
    if (map.r_crust_type) map.r_crust_type[r] = rec.type;
    if (map.r_thickness) map.r_thickness[r] = rec.thickness;
    if (map.r_orogeny && rec.orogeny != null) map.r_orogeny[r] = rec.orogeny;
}


function fade(t) {
    return t * t * (3 - 2 * t);
}


function hash01(ix, iy, iz) {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}


function valueNoise3(x, y, z, freq) {
    const px = x * freq;
    const py = y * freq;
    const pz = z * freq;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const iz = Math.floor(pz);
    const fx = fade(px - ix);
    const fy = fade(py - iy);
    const fz = fade(pz - iz);
    const n000 = hash01(ix, iy, iz);
    const n100 = hash01(ix + 1, iy, iz);
    const n010 = hash01(ix, iy + 1, iz);
    const n110 = hash01(ix + 1, iy + 1, iz);
    const n001 = hash01(ix, iy, iz + 1);
    const n101 = hash01(ix + 1, iy, iz + 1);
    const n011 = hash01(ix, iy + 1, iz + 1);
    const n111 = hash01(ix + 1, iy + 1, iz + 1);
    const n00 = n000 + (n100 - n000) * fx;
    const n10 = n010 + (n110 - n010) * fx;
    const n01 = n001 + (n101 - n001) * fx;
    const n11 = n011 + (n111 - n011) * fx;
    const n0 = n00 + (n10 - n00) * fy;
    const n1 = n01 + (n11 - n01) * fy;
    return n0 + (n1 - n0) * fz;
}


function jaggedAt(x, y, z, cellAng) {
    const f1 = 1 / Math.max(cellAng * 2.4, 0.012);
    return 0.64 * valueNoise3(x, y, z, f1) + 0.36 * valueNoise3(x, y, z, f1 * 2.1);
}


function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const t = clamp(p, 0, 1) * (sorted.length - 1);
    const lo = Math.floor(t);
    const hi = Math.ceil(t);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (t - lo);
}


function collectSide(meters, cells, land) {
    const vals = [];
    for (let i = 0; i < cells.length; i++) {
        const m = meters[cells[i]];
        if (land ? m >= 0 : m < 0) vals.push(m);
    }
    vals.sort((a, b) => a - b);
    return vals;
}


function sideStats(vals) {
    if (!vals.length) return null;
    const p15 = percentile(vals, 0.15);
    const p50 = percentile(vals, 0.5);
    const p85 = percentile(vals, 0.85);
    return {p15, p50, p85, span: Math.max(p85 - p15, 1)};
}


function coastTargets(meters, cells) {
    const land = collectSide(meters, cells, true);
    const water = collectSide(meters, cells, false);
    const landT = land.length
        ? clamp(percentile(land, 0.2), COAST_LAND_LO_M, COAST_LAND_HI_M)
        : 80;
    const waterT = water.length
        ? clamp(percentile(water, 0.8), COAST_WATER_LO_M, COAST_WATER_HI_M)
        : -70;
    return {landT, waterT};
}


function sameSideCount(mesh, meters, r, land) {
    mesh.r_circulate_r(outR, r);
    let n = 0;
    for (let i = 0; i < outR.length; i++) {
        const nb = outR[i];
        if (nb < 0) continue;
        if (land ? meters[nb] >= 0 : meters[nb] < 0) n++;
    }
    return n;
}


function paintRoom(stroke, r, want) {
    if (!stroke || !stroke.painted) return want;
    const prev = stroke.painted.get(r) || 0;
    const room = 1 - prev;
    if (room <= 0) return 0;
    const use = want < room ? want : room;
    stroke.painted.set(r, prev + use);
    return use;
}


function affectRadiusRad(mesh, radiusRad) {
    return Math.max(radiusRad || 0, cellAngle(mesh) * 1.2);
}


function coastDab(mesh, map, center, radiusRad, amount, invert, opts, stroke) {
    const {r_xyz, r_meters} = map;
    const disk = gatherDisk(mesh, r_xyz, center, radiusRad, hintR);
    hintR = disk.hint;
    if (!disk.cells.length) return false;
    const halo = gatherDisk(mesh, r_xyz, center, radiusRad * HALO_SCALE, disk.hint);
    const {landT, waterT} = coastTargets(r_meters, halo.cells);
    const cellAng = cellAngle(mesh);
    const add = !invert;
    const thresh = 0.72 - 0.38 * clamp(amount, 0, 1);
    let changed = false;
    for (let i = 0; i < disk.cells.length; i++) {
        const r = disk.cells[i];
        const w = disk.weights[i];
        if (w <= 0) continue;
        const current = r_meters[r];
        const isLand = current >= 0;
        if (add && isLand) continue;
        if (!add && !isLand) continue;
        const jag = jaggedAt(r_xyz[3 * r], r_xyz[3 * r + 1], r_xyz[3 * r + 2], cellAng);
        const attach = sameSideCount(mesh, r_meters, r, add) / 6;
        const score = w * (0.42 + 0.58 * jag) + 0.28 * attach;
        if (score < thresh) continue;
        const t = paintRoom(stroke, r, clamp(w * (0.65 + 0.35 * amount), 0.35, 1));
        if (t <= 0) continue;
        const target = add ? landT : waterT;
        let next = current + (target - current) * t;
        if (add && next < 8) next = 8 + jag * 36;
        if (!add && next >= -8) next = -12 - jag * 40;
        if (writeMeters(map, r, next, opts, stroke)) changed = true;
    }
    return changed;
}


function reliefTarget(stats, high, amount, land) {
    const floor = land ? 55 : 80;
    const extra = Math.max(0.18 * stats.span, floor) * amount;
    let target = high ? stats.p85 + extra : stats.p15 - extra;
    const lo = stats.p15 - 0.35 * stats.span;
    const hi = stats.p85 + 0.35 * stats.span;
    if (land) {
        target = Math.max(target, RELIEF_LAND_FLOOR_M);
        return clamp(target, Math.max(lo, RELIEF_LAND_FLOOR_M), Math.max(hi, RELIEF_LAND_FLOOR_M + 40));
    }
    target = Math.min(target, RELIEF_WATER_CEIL_M);
    return clamp(target, Math.min(lo, RELIEF_WATER_CEIL_M - 40), Math.min(hi, RELIEF_WATER_CEIL_M));
}


function reliefDab(mesh, map, center, radiusRad, amount, invert, opts, stroke) {
    const {r_xyz, r_meters} = map;
    const disk = gatherDisk(mesh, r_xyz, center, radiusRad, hintR);
    hintR = disk.hint;
    if (!disk.cells.length) return false;
    const halo = gatherDisk(mesh, r_xyz, center, radiusRad * HALO_SCALE, disk.hint);
    const landVals = collectSide(r_meters, halo.cells, true);
    const waterVals = collectSide(r_meters, halo.cells, false);
    const land = sideStats(landVals);
    const water = sideStats(waterVals);
    const high = !invert;
    let changed = false;
    for (let i = 0; i < disk.cells.length; i++) {
        const r = disk.cells[i];
        const w = disk.weights[i];
        if (w <= 0) continue;
        const current = r_meters[r];
        const isLand = current >= 0;
        const stats = isLand ? land : water;
        if (!stats) continue;
        const t = paintRoom(stroke, r, w * amount * 0.75);
        if (t <= 0) continue;
        const span = Math.max(stats.span, isLand ? 60 : 90);
        const family = {p15: stats.p15, p50: stats.p50, p85: stats.p85, span};
        let aimed = reliefTarget(family, high, amount, isLand);
        aimed += (current - stats.p50) * 0.4;
        if (isLand) {
            aimed = Math.max(aimed, RELIEF_LAND_FLOOR_M);
            const lo = Math.max(family.p15 - 0.35 * span, RELIEF_LAND_FLOOR_M);
            const hi = Math.max(family.p85 + 0.35 * span, RELIEF_LAND_FLOOR_M + 40);
            aimed = clamp(aimed, lo, hi);
        } else {
            aimed = Math.min(aimed, RELIEF_WATER_CEIL_M);
            const lo = Math.min(family.p15 - 0.35 * span, RELIEF_WATER_CEIL_M - 40);
            const hi = Math.min(family.p85 + 0.35 * span, RELIEF_WATER_CEIL_M);
            aimed = clamp(aimed, lo, hi);
        }
        const next = current + (aimed - current) * t;
        if (writeMeters(map, r, next, opts, stroke)) changed = true;
    }
    return changed;
}


function historyEntryFromSnap(snap) {
    const cells = new Int32Array(snap.size);
    const meters = new Float32Array(snap.size);
    const elevation = new Float32Array(snap.size);
    const type = new Uint8Array(snap.size);
    const thickness = new Float32Array(snap.size);
    const orogeny = new Float32Array(snap.size);
    let i = 0;
    for (const [r, rec] of snap) {
        cells[i] = r;
        meters[i] = rec.meters;
        elevation[i] = rec.elevation;
        type[i] = rec.type;
        thickness[i] = rec.thickness;
        orogeny[i] = rec.orogeny || 0;
        i++;
    }
    return {cells, meters, elevation, type, thickness, orogeny};
}


function snapshotCurrent(map, cells) {
    const meters = new Float32Array(cells.length);
    const elevation = new Float32Array(cells.length);
    const type = new Uint8Array(cells.length);
    const thickness = new Float32Array(cells.length);
    const orogeny = new Float32Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
        const r = cells[i];
        meters[i] = map.r_meters[r];
        elevation[i] = map.r_elevation[r];
        if (map.r_crust_type) type[i] = map.r_crust_type[r];
        if (map.r_thickness) thickness[i] = map.r_thickness[r];
        if (map.r_orogeny) orogeny[i] = map.r_orogeny[r];
    }
    return {cells: Int32Array.from(cells), meters, elevation, type, thickness, orogeny};
}


function applyEntry(map, entry) {
    const {cells, meters, elevation, type, thickness, orogeny} = entry;
    for (let i = 0; i < cells.length; i++) {
        const r = cells[i];
        map.r_meters[r] = meters[i];
        map.r_elevation[r] = elevation[i];
        if (map.r_crust_type) map.r_crust_type[r] = type[i];
        if (map.r_thickness) map.r_thickness[r] = thickness[i];
        if (map.r_orogeny && orogeny) map.r_orogeny[r] = orogeny[i];
    }
}


function pushHistory(before, after) {
    if (!before || !before.cells.length) return false;
    history = history.slice(0, historyIndex + 1);
    history.push({before, after});
    if (history.length > HISTORY_MAX) history.shift();
    historyIndex = history.length - 1;
    return true;
}


function canUndo() {
    return historyIndex >= 0;
}


function canRedo() {
    return historyIndex < history.length - 1;
}


function undo(map) {
    if (!canUndo() || !map || !map.r_meters) return false;
    applyEntry(map, history[historyIndex].before);
    historyIndex--;
    return true;
}


function redo(map) {
    if (!canRedo() || !map || !map.r_meters) return false;
    historyIndex++;
    applyEntry(map, history[historyIndex].after);
    return true;
}


function clearHistory() {
    history = [];
    historyIndex = -1;
    live = null;
}


function tools() {
    return TOOLS.slice();
}


function getTool() {
    return tool;
}


function isActive() {
    return !!tool;
}


function setTool(name) {
    const next = TOOLS.indexOf(name) >= 0 ? name : null;
    if (tool === next) return false;
    tool = next;
    if (!tool) hover = null;
    return true;
}


function setActive(on) {
    if (!on) return setTool(null);
    if (tool) return false;
    return setTool('coast');
}


function getRadiusPx() {
    return radiusPx;
}


function setRadiusPx(px) {
    const next = clamp(Math.round(Number(px) || 0), MIN_RADIUS_PX, MAX_RADIUS_PX);
    if (next === radiusPx) return false;
    radiusPx = next;
    return true;
}


function nudgeRadius(dir) {
    const step = radiusPx < 40 ? 4 : 8;
    return setRadiusPx(radiusPx + (dir > 0 ? step : -step));
}


function getStrength() {
    return strength;
}


function setStrength(value) {
    const next = clamp(Number(value) || 0, MIN_STRENGTH, MAX_STRENGTH);
    if (next === strength) return false;
    strength = next;
    return true;
}


function nudgeStrength(dir) {
    return setStrength(strength + (dir > 0 ? 0.08 : -0.08));
}


function setInvert(on) {
    const next = !!on;
    if (invertHeld === next) return false;
    invertHeld = next;
    return true;
}


function isInvert() {
    return invertHeld;
}


function setHover(at) {
    const next = at && Number.isFinite(at.lon) && Number.isFinite(at.lat)
        ? {
            lon: at.lon,
            lat: at.lat,
            xyz: at.xyz || lonLatToXyz(at.lon, at.lat),
            screenX: at.screenX,
            screenY: at.screenY,
            radiusRad: at.radiusRad,
        }
        : null;
    const prev = hover;
    if (!next && !prev) return false;
    if (next && prev
        && next.lon === prev.lon && next.lat === prev.lat
        && next.screenX === prev.screenX && next.screenY === prev.screenY) {
        return false;
    }
    hover = next;
    return true;
}


function getHover() {
    return hover;
}


function isLive() {
    return !!live;
}


function pointFromAt(at) {
    if (!at) return null;
    const xyz = at.xyz || (Number.isFinite(at.lon) ? lonLatToXyz(at.lon, at.lat) : null);
    if (!xyz) return null;
    return {
        lon: at.lon,
        lat: at.lat,
        xyz,
        screenX: at.screenX,
        screenY: at.screenY,
        radiusRad: at.radiusRad,
    };
}


function resolveRadiusRad(mesh, at) {
    const raw = at && at.radiusRad;
    return affectRadiusRad(mesh, raw > 0 ? raw : 0.08);
}


function beginStroke(mesh, map, at, opts) {
    if (!tool || !mesh || !map || !map.r_meters || !map.r_xyz) return false;
    const pt = pointFromAt(at);
    if (!pt) return false;
    const radiusRad = resolveRadiusRad(mesh, pt);
    live = {
        tool,
        invert: invertHeld,
        mesh,
        map,
        opts: opts || null,
        radiusRad,
        strength,
        snap: new Map(),
        painted: new Map(),
        path: [pt],
        last: pt,
        dirty: false,
    };
    applyDab(pt);
    hover = pt;
    return true;
}


function applyDab(to) {
    if (!live) return false;
    const {mesh, map, opts, tool: kind, invert, strength: amt} = live;
    const radiusRad = to.radiusRad > 0 ? affectRadiusRad(mesh, to.radiusRad) : live.radiusRad;
    live.radiusRad = radiusRad;
    let changed = false;
    if (kind === 'coast') {
        changed = coastDab(mesh, map, to.xyz, radiusRad, amt, invert, opts, live);
    } else {
        changed = reliefDab(mesh, map, to.xyz, radiusRad, amt, invert, opts, live);
    }
    if (changed) live.dirty = true;
    return changed;
}


function slerpXyz(a, b, t) {
    const d = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
    const omega = Math.acos(d);
    if (omega < 1e-8) return [b[0], b[1], b[2]];
    const s = Math.sin(omega);
    const w0 = Math.sin((1 - t) * omega) / s;
    const w1 = Math.sin(t * omega) / s;
    const len = Math.hypot(a[0] * w0 + b[0] * w1, a[1] * w0 + b[1] * w1, a[2] * w0 + b[2] * w1) || 1;
    return [
        (a[0] * w0 + b[0] * w1) / len,
        (a[1] * w0 + b[1] * w1) / len,
        (a[2] * w0 + b[2] * w1) / len,
    ];
}


function moveStroke(at) {
    if (!live) return false;
    const pt = pointFromAt(at);
    if (!pt) return false;
    const last = live.last;
    const moved = angleBetween(
        last.xyz[0], last.xyz[1], last.xyz[2],
        pt.xyz[0], pt.xyz[1], pt.xyz[2],
    );
    if (moved < 1e-5) {
        hover = pt;
        return false;
    }
    const step = Math.max(1e-4, live.radiusRad * DAB_FRAC);
    const n = Math.max(1, Math.ceil(moved / step));
    let changed = false;
    for (let i = 1; i <= n; i++) {
        const xyz = i === n ? pt.xyz : slerpXyz(last.xyz, pt.xyz, i / n);
        const dab = {
            lon: pt.lon,
            lat: pt.lat,
            xyz,
            screenX: pt.screenX,
            screenY: pt.screenY,
            radiusRad: pt.radiusRad || live.radiusRad,
        };
        if (applyDab(dab)) changed = true;
    }
    live.path.push(pt);
    live.last = pt;
    hover = pt;
    return changed;
}


function endStroke() {
    if (!live) return false;
    const {map, snap, dirty} = live;
    const committed = dirty && snap.size > 0;
    if (committed) {
        const before = historyEntryFromSnap(snap);
        const after = snapshotCurrent(map, before.cells);
        pushHistory(before, after);
    }
    live = null;
    return committed;
}


function cancelStroke() {
    if (!live) return false;
    const {map, snap} = live;
    for (const [r, rec] of snap) restoreRecord(map, r, rec);
    live = null;
    return true;
}


function readout() {
    if (!tool) return {value: '', hint: '', undo: canUndo(), redo: canRedo()};
    const size = `${radiusPx} px`;
    const amp = `${Math.round(strength * 100)}%`;
    return {
        value: `${size} · ${amp}`,
        hint: HINTS[tool] || '',
        undo: canUndo(),
        redo: canRedo(),
        tool,
        radiusPx,
        strength,
    };
}


function overlayCanvas() {
    let el = document.getElementById('sculpt-overlay');
    if (el) return el;
    const src = document.getElementById('output');
    if (!src || !src.parentElement) return null;
    el = document.createElement('canvas');
    el.id = 'sculpt-overlay';
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.pointerEvents = 'none';
    const parent = src.parentElement;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const measure = document.getElementById('measure-overlay');
    if (measure) measure.insertAdjacentElement('afterend', el);
    else src.insertAdjacentElement('afterend', el);
    return el;
}


function hideOverlay(el) {
    if (el.width !== 1 || el.height !== 1) {
        el.width = 1;
        el.height = 1;
    }
    el.style.display = 'none';
}


function syncReadout() {
    const el = document.querySelector('.sculpt-readout');
    if (!el) return;
    if (!tool) {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    const {value, hint, undo, redo} = readout();
    const valueEl = el.querySelector('.sculpt-readout-value');
    const hintEl = el.querySelector('.sculpt-readout-hint');
    if (valueEl) {
        valueEl.textContent = value;
        valueEl.hidden = !value;
    }
    if (hintEl) hintEl.textContent = hint;
    const undoBtn = el.querySelector('.sculpt-undo');
    const redoBtn = el.querySelector('.sculpt-redo');
    if (undoBtn) undoBtn.disabled = !undo;
    if (redoBtn) redoBtn.disabled = !redo;
}


function paint(view) {
    const el = overlayCanvas();
    if (!el) return;
    syncReadout();
    if (!tool) {
        hideOverlay(el);
        return;
    }
    el.style.display = 'block';
    const space = TdOverlay.fitScreenCanvas(el);
    if (!space) return;
    const {ctx, width, height} = space;
    const at = hover || (live && live.last);
    if (!at) return;
    const ink = {
        fill: Look.SCULPT.hex,
        halo: Look.SCULPT.haloHex,
    };
    const rpx = radiusPx;
    for (const shift of TdOverlay.paintShifts(view)) {
        const project = TdOverlay.projector(view, width, height, shift);
        const q = project(at.lon, at.lat);
        if (q.front === false) continue;
        ctx.beginPath();
        ctx.arc(q.x, q.y, rpx, 0, Math.PI * 2);
        ctx.strokeStyle = ink.halo;
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.strokeStyle = ink.fill;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
}


module.exports = {
    TOOLS,
    HINTS,
    HISTORY_MAX,
    DEFAULT_RADIUS_PX,
    MIN_RADIUS_PX,
    MAX_RADIUS_PX,
    DEFAULT_STRENGTH,
    falloff,
    gatherDisk,
    screenToRadiusRad,
    cellAngle,
    affectRadiusRad,
    percentile,
    coastTargets,
    coastDab,
    reliefDab,
    tools,
    getTool,
    isActive,
    setTool,
    setActive,
    getRadiusPx,
    setRadiusPx,
    nudgeRadius,
    getStrength,
    setStrength,
    nudgeStrength,
    setInvert,
    isInvert,
    setHover,
    getHover,
    isLive,
    beginStroke,
    moveStroke,
    endStroke,
    cancelStroke,
    canUndo,
    canRedo,
    undo,
    redo,
    clearHistory,
    readout,
    paint,
};
