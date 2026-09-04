/*
 * What a terrain-diffusion bake is asked for: the conditioning channels, in
 * the physical units the model was trained on, and the job body that carries
 * them.
 *
 * This exists so the studio and a headless script submit the *same* body. The
 * cube-tile export used to live only in the browser bundle, so there was no
 * way to bake a tile without a page open — and no way to check the app's own
 * path from a script. A second implementation would have drifted from it on
 * the first change; one that the app itself calls cannot.
 *
 * DOM-free, like the rest of src/. `f32ToB64` is the only thing that touches
 * a platform global, and `btoa` is in both browsers and Bun.
 */
'use strict';

const Cube = require('./cubesphere');
const TdTile = require('./td-tile');
const Tectonics = require('./tectonics');

const {clamp01, elevationToMeters} = Tectonics;

/*
 * The scale between this planet's unit fields and the model's units. The
 * painter reads the same numbers back the other way — see `tempCToT` and
 * `precipToM` in scripts/paint-td-terrain.mjs — so they are shared rather
 * than written down twice. A tile coloured on a different scale from the one
 * it was conditioned on is a whole-crop colour error, not a subtle one.
 */
const TEMP_SCALE = 40;
const TEMP_OFFSET = -15;
const PRECIP_MIN = 60;
const PRECIP_RANGE = 3400;
const PRECIP_POWER = 1.55;

function temperatureToC(t) {
    return Math.max(-40, Math.min(40, TEMP_SCALE * t + TEMP_OFFSET));
}

function moistureToPrecipMm(m) {
    return PRECIP_MIN + PRECIP_RANGE * Math.pow(clamp01(m), PRECIP_POWER);
}

/* Neither of these is simulated. They are shaped guesses, flagged as such in
 * docs/stages/terrain.md § Open. */
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

function fieldsToTdLayers(fields, width, height, latAtRow) {
    const n = width * height;
    const heightmap = new Float32Array(n);
    const temperature = new Float32Array(n);
    const temperatureStd = new Float32Array(n);
    const precipitation = new Float32Array(n);
    const precipitationCv = new Float32Array(n);
    const rowLat = latAtRow
        || ((y) => (Math.PI / 2) - (y + 0.5) / height * Math.PI);
    for (let y = 0; y < height; y++) {
        const lat = rowLat(y);
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const eM = elevationToMeters(fields.elev[i]);
            const m = fields.moist[i];
            heightmap[i] = eM;
            temperature[i] = temperatureToC(fields.temp[i]);
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

function f32ToB64(arr) {
    const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const chunk = 0x8000;
    let s = '';
    for (let i = 0; i < u8.length; i += chunk) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
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

/*
 * One tile's conditioning, and the job that carries it.
 *
 * Conditioned on the face's conformal bake plane, not the tile's own square.
 * The square's axes are up to 30 degrees from perpendicular on the ground and
 * the model paints terrain isotropic in whatever grid it is given, so that
 * skew came out as terrain combed a different way on every face — the thing
 * that made a cube fold visible. The plane is shared by the whole face, so
 * `rect` still puts two touching tiles on overlapping cells of one lattice
 * and the bake still gives them the same noise there. A fold tile's rect also
 * carries its halo, and the job resamples the lot back onto the tile raster
 * afterwards, so nothing downstream sees any of this.
 *
 * The lon/lat box that rides along is nominal — for the GeoTIFF geotransform
 * and for framing the view. The tile identity is what places the result.
 */
function tileJobBody(planet, tile, opts = {}) {
    const cells = opts.cells
        || Cube.tileCells(tile.level, planet.body.radiusKm, TdTile.SCALE_KM);
    const pad = opts.padCells != null ? opts.padCells : TdTile.CONTEXT_PAD;
    const halo = TdTile.haloCellsFor(tile);
    const rect = Cube.tileBakeRect(tile, cells, pad, halo);
    const raw = opts.rasterize(tile, rect);
    const layers = fieldsToTdLayers(raw, rect.width, rect.height, (row) => {
        const mid = Cube.xyzToLonLat(
            Cube.bakeDirection(tile, rect, rect.width / 2, row + 0.5),
        );
        return mid.lat * Math.PI / 180;
    });
    const box = Cube.tileBBox(tile);
    return {
        name: Cube.tileName(tile),
        tile,
        west: box.west,
        south: box.south,
        east: box.east,
        north: box.north,
        cropW: rect.width - 2 * pad,
        cropH: rect.height - 2 * pad,
        padCells: pad,
        /* The lattice cell of the padded top-left, so two tiles of one face
         * that touch ask the bake for the same WorldPipeline coordinates. */
        originI: rect.originI,
        originJ: rect.originJ,
        bakeStep: rect.step,
        tileCells: cells,
        haloCells: TdTile.SEAM_HALO_CELLS,
        scaleKm: TdTile.SCALE_KM,
        layers: encodeTdLayers(layers),
    };
}

module.exports = {
    TEMP_SCALE,
    TEMP_OFFSET,
    PRECIP_MIN,
    PRECIP_RANGE,
    PRECIP_POWER,
    temperatureToC,
    moistureToPrecipMm,
    temperatureStdC,
    precipitationCvPct,
    fieldsToTdLayers,
    f32ToB64,
    encodeTdLayers,
    tileJobBody,
};
