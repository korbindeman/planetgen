/** Height encoding of a planet package node.
 *
 * Every node stores int16 metres: absolute, or a residual against the metre
 * channel of its parent. Format 2 adds int8 centimetres to samples within
 * `band_m` of sea level, where a sub-metre error moves the coastline by many
 * metres. The decoded height is `(100 * metres + centimetres) / 100`.
 *
 * Quantization preserves every sample's land/water classification: a height
 * above sea level never decodes to sea level or below. The metre channel
 * alone classifies each sample exactly as the decoded height does, so a
 * reader of the metre channel still sees the same land and water.
 */

export const FORMAT_VERSION = 2;
export const HEIGHT_FRACTION = 'int8-centimetres-v1';
export const SEA_LEVEL_M = 0;
export const DEFAULT_FRACTION_BAND_M = 64;

/** Whole metres outside the fraction band, clamped to the int16 payload. */
export function metres(value) {
    if (!Number.isFinite(value)) throw new Error('Non-finite package terrain');
    return Math.max(-32767, Math.min(32767, Math.round(value)));
}

function checkBand(bandM) {
    if (!Number.isFinite(bandM) || bandM <= 0 || bandM > 1000)
        throw new Error('Fraction band must be finite, positive and at most 1000 m');
}

/** `[metres, centimetres]` of one height above sea level zero. Centimetres
 * are zero outside the band and lie in -99..49 inside it. */
export function quantizeHeight(h, bandM) {
    if (!Number.isFinite(h)) throw new Error('Non-finite package terrain');
    if (!(Math.abs(h - SEA_LEVEL_M) < bandM)) return [metres(h), 0];
    // `|| 0` folds JavaScript's negative zero into the stored integer zero.
    let total = Math.round(h * 100) || 0;
    if (h > 0 && total < 1) total = 1;
    let whole = Math.round(total / 100) || 0;
    if (total > 0 && whole < 1) whole = 1;
    return [whole, total - 100 * whole];
}

/** The metre channel and, when any sample needs one, the centimetre channel
 * of a node's heights. */
export function quantizeNode(heights, bandM) {
    checkBand(bandM);
    const whole = new Int16Array(heights.length), cm = new Int8Array(heights.length);
    let fractional = false;
    for (let k = 0; k < heights.length; k++) {
        const [m, c] = quantizeHeight(heights[k], bandM);
        whole[k] = m; cm[k] = c;
        if (c) fractional = true;
    }
    return {metres: whole, centimetres: fractional ? cm : null};
}

/** What a reader decodes from a node's two channels. */
export function decodeNode(whole, cm) {
    const out = new Float64Array(whole.length);
    for (let k = 0; k < whole.length; k++) out[k] = cm ? (100 * whole[k] + cm[k]) / 100 : whole[k];
    return out;
}

/** Uncompressed node payload: int16 values, then int8 centimetres if any. */
export function nodePayload(values, cm) {
    const head = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    return cm ? Buffer.concat([head, Buffer.from(cm.buffer, cm.byteOffset, cm.byteLength)]) : head;
}
