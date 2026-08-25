/*
 * Shape sketch cached on a variant. The 23 km height (and the climate
 * sampled onto it) is an artifact of that node, not a generate flag.
 *
 * Browser-free so the studio, the bake API, and check:pipeline share one
 * encode. Preview tiles are a different artifact.
 */
'use strict';

const F32 = ['r_meters', 'r_elevation', 'r_moisture', 'r_temperature'];
const U8 = ['r_crust_type'];
const I32 = ['r_plate'];


function u8ToB64(u8) {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
    }
    const chunk = 0x8000;
    let s = '';
    for (let i = 0; i < u8.length; i += chunk) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
}


function b64ToU8(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}


function asU8(arr) {
    return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}


function encodeF32(arr) {
    return arr ? u8ToB64(asU8(arr)) : null;
}


function decodeF32(b64, n) {
    if (!b64) return null;
    const bytes = b64ToU8(b64);
    const src = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const out = new Float32Array(n);
    out.set(src.subarray(0, n));
    return out;
}


function encodeU8(arr) {
    return arr ? u8ToB64(asU8(arr)) : null;
}


function decodeU8(b64, n) {
    if (!b64) return null;
    const src = b64ToU8(b64);
    const out = new Uint8Array(n);
    out.set(src.subarray(0, n));
    return out;
}


function encodeI32(arr) {
    return arr ? u8ToB64(asU8(arr)) : null;
}


function decodeI32(b64, n) {
    if (!b64) return null;
    const bytes = b64ToU8(b64);
    const src = new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const out = new Int32Array(n);
    out.set(src.subarray(0, n));
    return out;
}


function fromMap(map, meta) {
    if (!map || !map.r_elevation) return null;
    const cells = map.r_elevation.length;
    const payload = {
        n: (meta && meta.n) || cells,
        cells,
        jitter: meta && meta.jitter,
        shapeSeed: meta && meta.shapeSeed,
        spacingKm: meta && meta.spacingKm,
        f32: {},
        u8: {},
        i32: {},
    };
    for (const name of F32) {
        if (map[name]) payload.f32[name] = encodeF32(map[name]);
    }
    for (const name of U8) {
        if (map[name]) payload.u8[name] = encodeU8(map[name]);
    }
    for (const name of I32) {
        if (map[name]) payload.i32[name] = encodeI32(map[name]);
    }
    return payload;
}


function toFields(payload) {
    if (!payload) return null;
    const cells = (payload.cells || payload.n) | 0;
    if (!(cells > 0)) return null;
    const fields = {
        n: (payload.n || cells) | 0,
        cells,
    };
    const f32 = payload.f32 || {};
    const u8 = payload.u8 || {};
    const i32 = payload.i32 || {};
    for (const name of F32) {
        if (f32[name]) fields[name] = decodeF32(f32[name], cells);
    }
    for (const name of U8) {
        if (u8[name]) fields[name] = decodeU8(u8[name], cells);
    }
    for (const name of I32) {
        if (i32[name]) fields[name] = decodeI32(i32[name], cells);
    }
    return fields;
}


function marker(payload) {
    return {
        n: payload && payload.n,
        jitter: payload && payload.jitter,
        shapeSeed: payload && payload.shapeSeed,
        spacingKm: payload && payload.spacingKm,
    };
}


module.exports = {
    F32, U8, I32,
    fromMap,
    toFields,
    marker,
};
