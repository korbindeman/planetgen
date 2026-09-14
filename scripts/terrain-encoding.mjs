/** Precision identity of authored terrain, before package quantization. */
export const HEIGHT_ENCODING = 'float32-metres-v1';

/** Existing integer-truncated campaigns are immutable legacy sources. A new
 * worker must not resume them, even with --force, or mix their tiles with floats. */
export function requireCurrentEncoding(settings, legacyCampaign = false) {
    if (legacyCampaign || (settings && settings.heightEncoding !== HEIGHT_ENCODING))
        throw new Error('Campaign terrain precision changed. Save a new variant before baking Float32 heights.');
}

/** Missing stamps describe a legacy source, never proof of Float32 precision.
 * Readers may consume coherent legacy artifacts, but cannot mix encodings. */
export function assertHeightEncoding(record, expected, label) {
    const actual = record?.heightEncoding ?? null;
    expected ??= null;
    if ((expected !== null && expected !== HEIGHT_ENCODING) || actual !== expected)
        throw new Error(`${label}: terrain height encoding differs from the campaign`);
}
