/*
 * Layout sim cached on a variant. Plates, crust, climate, and the story
 * maps are an artifact of that node, not a regenerate from the recipe.
 *
 * Browser-free so the studio, the bake API, and check:pipeline share one
 * encode. Shape reads this the same way it reads a live sim.
 */
'use strict';

const Codec = require('./field-codec');

const F32 = [
    'r_meters', 'r_elevation', 'r_moisture', 'r_temperature',
    'r_thickness', 'r_crust_age', 'r_orogeny',
    'r_arc', 'r_arcPeak', 'r_arcAge',
    'r_hotspot', 'r_hotspotPeak', 'r_hotspotAge',
];
const PACKED3 = ['r_orogenyDir', 'r_arcDir'];
const U8 = ['r_crust_type', 'r_boundary'];
const I32 = ['r_plate'];
const NAMES = {f32: F32, packed3: PACKED3, u8: U8, i32: I32};
/* Contract only. Bump when a required field is gone or renamed, or the
 * packing changes. Do not bump when the sim changes. */
const SCHEMA = 1;


function usable(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (!Codec.schemaReadable(payload, SCHEMA)) return false;
    const cells = (payload.cells || payload.n) | 0;
    if (!(cells > 0)) return false;
    if (!payload.f32 || !payload.f32.r_elevation) return false;
    if (!payload.i32 || !payload.i32.r_plate) return false;
    if (!Array.isArray(payload.plates) || !payload.plates.length) return false;
    return true;
}


function vec3Of(value) {
    if (!value || value.length < 3) return null;
    const x = Number(value[0]), y = Number(value[1]), z = Number(value[2]);
    if (![x, y, z].every(Number.isFinite)) return null;
    return [x, y, z];
}


function encodePlate(plate) {
    if (!plate) return null;
    const pole = vec3Of(plate.pole);
    const omega = Number(plate.omega);
    if (!pole || !Number.isFinite(omega)) return null;
    const out = {
        id: plate.id | 0,
        pole,
        omega,
        bornMyr: Number(plate.bornMyr) || 0,
        parent: plate.parent | 0,
    };
    if (typeof plate.name === 'string' && plate.name) out.name = plate.name;
    if (Number.isFinite(plate.retiredMyr)) out.retiredMyr = plate.retiredMyr;
    if (Number.isFinite(plate.scale) && plate.scale !== 1) out.scale = plate.scale;
    return out;
}


function decodePlate(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const pole = vec3Of(raw.pole);
    const omega = Number(raw.omega);
    if (!pole || !Number.isFinite(omega)) return null;
    const plate = {
        id: raw.id | 0,
        pole,
        omega,
        bornMyr: Number(raw.bornMyr) || 0,
        parent: raw.parent | 0,
        sites: [],
        scale: Number.isFinite(raw.scale) ? raw.scale : 1,
    };
    if (typeof raw.name === 'string' && raw.name) plate.name = raw.name;
    if (Number.isFinite(raw.retiredMyr)) plate.retiredMyr = raw.retiredMyr;
    return plate;
}


function encodeVec3List(list) {
    if (!list || !list.length) return [];
    const out = [];
    for (const item of list) {
        const v = vec3Of(item);
        if (v) out.push(v);
    }
    return out;
}


function encodeOcean(set) {
    if (!set) return [];
    return Array.from(set, (id) => id | 0);
}


function fromMap(map, meta) {
    if (!map || !map.r_elevation) return null;
    const cells = map.r_elevation.length;
    const plates = (map.plates || []).map(encodePlate).filter(Boolean);
    if (!plates.length) return null;
    return Object.assign({
        schema: SCHEMA,
        n: (meta && meta.n) || cells,
        cells,
        jitter: meta && meta.jitter,
        seed: meta && meta.seed,
        plates,
        plate_is_ocean: encodeOcean(map.plate_is_ocean),
        hotspots: encodeVec3List(map.hotspots),
        extra_ocean_seeds: Array.isArray(map.extra_ocean_seeds)
            ? map.extra_ocean_seeds.map((r) => r | 0)
            : [],
        nextPlateId: map.nextPlateId | 0,
        elapsedMyr: Number(map.elapsedMyr) || 0,
        targetPlateCount: map.targetPlateCount | 0,
    }, Codec.encodeNamed(map, NAMES));
}


function toFields(payload) {
    if (!usable(payload)) return null;
    const cells = (payload.cells || payload.n) | 0;
    if (!(cells > 0)) return null;
    const plates = (payload.plates || []).map(decodePlate).filter(Boolean);
    if (!plates.length) return null;
    const fields = Object.assign({
        n: (payload.n || cells) | 0,
        cells,
        jitter: payload.jitter,
        seed: payload.seed,
        plates,
        plate_is_ocean: (payload.plate_is_ocean || []).map((id) => id | 0),
        hotspots: encodeVec3List(payload.hotspots),
        extra_ocean_seeds: (payload.extra_ocean_seeds || []).map((r) => r | 0),
        nextPlateId: payload.nextPlateId | 0,
        elapsedMyr: Number(payload.elapsedMyr) || 0,
        targetPlateCount: payload.targetPlateCount | 0,
    }, Codec.decodeNamed(payload, NAMES, cells));
    if (!fields.r_elevation) return null;
    return fields;
}


function marker(payload) {
    return {
        n: payload && payload.n,
        jitter: payload && payload.jitter,
        seed: payload && payload.seed,
        cells: payload && payload.cells,
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
