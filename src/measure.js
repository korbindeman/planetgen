/*
 * Great-circle measure on the globe and the equirect.
 *
 * Click two points, read kilometres off this planet's radius. Further
 * clicks add legs. The path is a geodesic, never a screen chord — a
 * chord across the map is not a distance on the sphere.
 *
 * Math is browser-free so `bun run check:measure` can pin it. Paint
 * reuses the overlay projector so wrapping and the far hemisphere
 * break in the same places as the tile grid.
 */
'use strict';

const Cube = require('./cubesphere');
const Look = require('./look');
const TdOverlay = require('./td-overlay');

const DEG = Math.PI / 180;
const SAME_RAD = 1e-5;

let active = false;
let points = [];
let hover = null;


function clamp1(x) {
    return x < -1 ? -1 : x > 1 ? 1 : x;
}


function angleRad(a, b) {
    const lat1 = a.lat * DEG;
    const lat2 = b.lat * DEG;
    const dLat = lat2 - lat1;
    const dLon = (b.lon - a.lon) * DEG;
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h = sinDLat * sinDLat
        + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    return 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}


function distanceKm(a, b, radiusKm) {
    return angleRad(a, b) * radiusKm;
}


function interpolate(a, b, t) {
    const A = Cube.lonLatToXyz(a.lon, a.lat);
    const B = Cube.lonLatToXyz(b.lon, b.lat);
    const d = clamp1(A[0] * B[0] + A[1] * B[1] + A[2] * B[2]);
    const omega = Math.acos(d);
    let x, y, z;
    if (omega < 1e-8) {
        x = A[0];
        y = A[1];
        z = A[2];
    } else if (Math.PI - omega < 1e-6) {
        /* Antipodes: infinitely many geodesics. Pick one through a pole. */
        const axis = Math.abs(A[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        let px = A[1] * axis[2] - A[2] * axis[1];
        let py = A[2] * axis[0] - A[0] * axis[2];
        let pz = A[0] * axis[1] - A[1] * axis[0];
        const plen = Math.hypot(px, py, pz) || 1;
        px /= plen;
        py /= plen;
        pz /= plen;
        const c = Math.cos(t * Math.PI);
        const s = Math.sin(t * Math.PI);
        x = A[0] * c + px * s;
        y = A[1] * c + py * s;
        z = A[2] * c + pz * s;
    } else {
        const s = Math.sin(omega);
        const w0 = Math.sin((1 - t) * omega) / s;
        const w1 = Math.sin(t * omega) / s;
        x = w0 * A[0] + w1 * B[0];
        y = w0 * A[1] + w1 * B[1];
        z = w0 * A[2] + w1 * B[2];
    }
    return Cube.xyzToLonLat([x, y, z]);
}


function geodesic(a, b, radiusKm) {
    const ang = angleRad(a, b);
    const km = ang * (radiusKm || 6371);
    const steps = Math.max(8, Math.min(256, Math.round(km / 40) || 8));
    const pts = new Array(steps + 1);
    for (let i = 0; i <= steps; i++) pts[i] = interpolate(a, b, i / steps);
    return pts;
}


function formatDistance(km) {
    if (!Number.isFinite(km) || km < 0) return '';
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
}


function formatElev(m) {
    if (!Number.isFinite(m)) return '';
    const sign = m < 0 ? '-' : '';
    const abs = Math.abs(m);
    if (abs < 1000) return `${sign}${Math.round(abs)} m`;
    const km = abs / 1000;
    return `${sign}${km.toFixed(km >= 10 ? 0 : 1)} km`;
}


function formatDelta(fromM, toM) {
    if (!Number.isFinite(fromM) || !Number.isFinite(toM)) return '';
    const d = toM - fromM;
    const sign = d > 0 ? '+' : d < 0 ? '-' : '';
    const abs = Math.abs(d);
    if (abs < 1000) return `${sign}${Math.round(abs)} m`;
    const km = abs / 1000;
    return `${sign}${km.toFixed(km >= 10 ? 0 : 1)} km`;
}


function formatAngle(rad) {
    if (!Number.isFinite(rad) || rad < 0) return '';
    const deg = rad * 180 / Math.PI;
    if (deg < 0.05) return '';
    if (deg < 10) return `${deg.toFixed(1)}°`;
    return `${Math.round(deg)}°`;
}


function samePoint(a, b) {
    return a && b && angleRad(a, b) < SAME_RAD;
}


function isActive() {
    return active;
}


function setActive(on) {
    const next = !!on;
    if (active === next) return false;
    active = next;
    if (!active) hover = null;
    return true;
}


function getPoints() {
    return points;
}


function getHover() {
    return hover;
}


function addPoint(at) {
    if (!at || !Number.isFinite(at.lon) || !Number.isFinite(at.lat)) return false;
    const last = points[points.length - 1];
    if (last && samePoint(last, at)) return false;
    points.push({lon: at.lon, lat: at.lat, elevM: at.elevM});
    return true;
}


function popPoint() {
    if (!points.length) return false;
    points.pop();
    return true;
}


function clear() {
    const had = points.length > 0 || hover;
    points = [];
    hover = null;
    return had;
}


function setHover(at) {
    const next = at && Number.isFinite(at.lon) && Number.isFinite(at.lat)
        ? {lon: at.lon, lat: at.lat, elevM: at.elevM}
        : null;
    const prev = hover;
    if (!next && !prev) return false;
    if (next && prev
        && next.lon === prev.lon
        && next.lat === prev.lat
        && next.elevM === prev.elevM) {
        return false;
    }
    hover = next;
    return true;
}


function pathLegs(radiusKm) {
    const pts = hover && points.length ? points.concat([hover]) : points;
    const legs = [];
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        legs.push({
            a,
            b,
            km: distanceKm(a, b, radiusKm),
            rad: angleRad(a, b),
            live: !!(hover && i === pts.length - 1 && b === hover),
        });
    }
    return legs;
}


function readout(radiusKm) {
    const legs = pathLegs(radiusKm);
    const totalKm = legs.reduce((s, leg) => s + leg.km, 0);
    const totalRad = legs.reduce((s, leg) => s + leg.rad, 0);
    const last = legs[legs.length - 1];
    const delta = last ? formatDelta(last.a.elevM, last.b.elevM) : '';
    let value = '';
    let hint = 'Click a start.';
    if (!points.length) {
        hint = 'Click a start.';
    } else if (!legs.length) {
        hint = 'Click an end.';
    } else {
        value = formatDistance(totalKm);
        const extras = [formatAngle(totalRad), delta && `Δ ${delta}`].filter(Boolean);
        hint = extras.length ? extras.join(' · ') : 'Click to add. Escape clears.';
    }
    return {value, hint, totalKm, legs};
}


function overlayCanvas() {
    let el = document.getElementById('measure-overlay');
    if (el) return el;
    const src = document.getElementById('output');
    if (!src || !src.parentElement) return null;
    el = document.createElement('canvas');
    el.id = 'measure-overlay';
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.pointerEvents = 'none';
    const parent = src.parentElement;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const plates = document.getElementById('plate-overlay');
    if (plates) plates.insertAdjacentElement('afterend', el);
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


function syncReadout(radiusKm) {
    const el = document.querySelector('.measure-readout');
    if (!el) return;
    if (!active) {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    const {value, hint} = readout(radiusKm);
    const valueEl = el.querySelector('.measure-readout-value');
    const hintEl = el.querySelector('.measure-readout-hint');
    if (valueEl) {
        valueEl.textContent = value;
        valueEl.hidden = !value;
    }
    if (hintEl) hintEl.textContent = hint;
}


function drawVertex(ctx, q, ink) {
    if (q.front === false) return;
    ctx.beginPath();
    ctx.arc(q.x, q.y, Look.MEASURE.vertexR + 1.5, 0, Math.PI * 2);
    ctx.fillStyle = ink.halo;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(q.x, q.y, Look.MEASURE.vertexR, 0, Math.PI * 2);
    ctx.fillStyle = ink.fill;
    ctx.fill();
}


function drawLabel(ctx, text, q) {
    if (!text || q.front === false) return;
    ctx.save();
    ctx.font = '650 13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(17,17,17,0.85)';
    ctx.fillStyle = Look.MEASURE.labelHex;
    ctx.strokeText(text, q.x, q.y - 8);
    ctx.fillText(text, q.x, q.y - 8);
    ctx.restore();
}


function paintLeg(ctx, project, leg, radiusKm, ink) {
    const pts = geodesic(leg.a, leg.b, radiusKm);
    ctx.beginPath();
    TdOverlay.strokeLonLatPath(ctx, project, pts);
    ctx.strokeStyle = ink.halo;
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.strokeStyle = ink.fill;
    ctx.lineWidth = 2;
    ctx.stroke();
    const mid = interpolate(leg.a, leg.b, 0.5);
    drawLabel(ctx, formatDistance(leg.km), project(mid.lon, mid.lat));
}


function paint(view) {
    const el = overlayCanvas();
    if (!el) return;
    const radiusKm = view.radiusKm;
    syncReadout(radiusKm);
    if (!active) {
        hideOverlay(el);
        return;
    }
    el.style.display = 'block';
    const space = TdOverlay.fitScreenCanvas(el);
    if (!space) return;
    const {ctx, width, height} = space;
    const legs = pathLegs(radiusKm);
    const ink = {
        fill: Look.MEASURE.hex,
        halo: Look.MEASURE.haloHex,
    };
    const verts = hover ? points.concat([hover]) : points;
    for (const shift of TdOverlay.paintShifts(view)) {
        const project = TdOverlay.projector(view, width, height, shift);
        for (const leg of legs) paintLeg(ctx, project, leg, radiusKm, ink);
        for (const p of verts) drawVertex(ctx, project(p.lon, p.lat), ink);
    }
}


module.exports = {
    angleRad,
    distanceKm,
    interpolate,
    geodesic,
    formatDistance,
    formatElev,
    formatDelta,
    formatAngle,
    samePoint,
    isActive,
    setActive,
    getPoints,
    getHover,
    addPoint,
    popPoint,
    clear,
    setHover,
    pathLegs,
    readout,
    paint,
};
