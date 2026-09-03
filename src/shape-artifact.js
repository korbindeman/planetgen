/*
 * Shape sketch cached on a variant. The 23 km height (and the climate
 * sampled onto it) is an artifact of that node, not a generate flag.
 *
 * Browser-free so the studio, the bake API, and check:pipeline share one
 * encode. Preview tiles are a different artifact.
 */
'use strict';

const Codec = require('./field-codec');

const F32 = [
    'r_meters', 'r_elevation', 'r_moisture', 'r_temperature',
    'r_arc', 'r_arcPeak', 'r_arcAge',
    'r_hotspot', 'r_hotspotPeak', 'r_hotspotAge',
    'r_orogeny', 'r_crust_age',
    'r_discharge',
];
const PACKED3 = ['r_orogenyDir', 'r_arcDir'];
const U8 = ['r_crust_type', 'r_boundary'];
const I32 = ['r_plate', 'r_drainTo'];
const NAMES = {f32: F32, packed3: PACKED3, u8: U8, i32: I32};
/* Contract only. Bump when a required field is gone or renamed, or the
 * packing changes. Do not bump when the sketch pass changes. */
const SCHEMA = 1;


function usable(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (!Codec.schemaReadable(payload, SCHEMA)) return false;
    const cells = (payload.cells || payload.n) | 0;
    if (!(cells > 0)) return false;
    if (!payload.f32 || !payload.f32.r_elevation) return false;
    return true;
}


function fromMap(map, meta) {
    if (!map || !map.r_elevation) return null;
    const cells = map.r_elevation.length;
    return Object.assign({
        schema: SCHEMA,
        n: (meta && meta.n) || cells,
        cells,
        jitter: meta && meta.jitter,
        shapeSeed: meta && meta.shapeSeed,
        spacingKm: meta && meta.spacingKm,
    }, Codec.encodeNamed(map, NAMES));
}


function toFields(payload) {
    if (!usable(payload)) return null;
    const cells = (payload.cells || payload.n) | 0;
    if (!(cells > 0)) return null;
    return Object.assign({
        n: (payload.n || cells) | 0,
        cells,
    }, Codec.decodeNamed(payload, NAMES, cells));
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
    SCHEMA,
    F32, PACKED3, U8, I32,
    usable,
    fromMap,
    toFields,
    marker,
};
