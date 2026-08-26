/*
 * Typed-array fields packed as base64. Layout and Shape artifacts share
 * this encode; they do not share a file format.
 */
'use strict';


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


function encodeNamed(map, names) {
    const f32 = {}, packed3 = {}, u8 = {}, i32 = {};
    for (const name of names.f32 || []) {
        if (map[name]) f32[name] = encodeF32(map[name]);
    }
    for (const name of names.packed3 || []) {
        if (map[name]) packed3[name] = encodeF32(map[name]);
    }
    for (const name of names.u8 || []) {
        if (map[name]) u8[name] = encodeU8(map[name]);
    }
    for (const name of names.i32 || []) {
        if (map[name]) i32[name] = encodeI32(map[name]);
    }
    return {f32, packed3, u8, i32};
}


function decodeNamed(payload, names, cells) {
    const fields = {};
    const f32 = (payload && payload.f32) || {};
    const packed3 = (payload && payload.packed3) || {};
    const u8 = (payload && payload.u8) || {};
    const i32 = (payload && payload.i32) || {};
    for (const name of names.f32 || []) {
        if (f32[name]) fields[name] = decodeF32(f32[name], cells);
    }
    for (const name of names.packed3 || []) {
        if (packed3[name]) fields[name] = decodeF32(packed3[name], cells * 3);
    }
    for (const name of names.u8 || []) {
        if (u8[name]) fields[name] = decodeU8(u8[name], cells);
    }
    for (const name of names.i32 || []) {
        if (i32[name]) fields[name] = decodeI32(i32[name], cells);
    }
    return fields;
}


/* Unstamped files from this era are schema 1. A future schema this
 * generator does not know is unreadable. */
function schemaOf(payload) {
    const n = payload && payload.schema | 0;
    return n >= 1 ? n : 1;
}


function schemaReadable(payload, current) {
    return schemaOf(payload) <= (current | 0);
}


module.exports = {
    encodeF32, decodeF32,
    encodeU8, decodeU8,
    encodeI32, decodeI32,
    encodeNamed, decodeNamed,
    schemaOf, schemaReadable,
};
