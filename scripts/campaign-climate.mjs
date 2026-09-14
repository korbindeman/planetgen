/** Climate selection is pinned at campaign creation. Old campaigns have no
 * climate stamp and must continue with their original preview conditioning. */
export function climateMode(previousSettings,requested,legacyCampaign=false) {
    if(requested&&!['preview','seasonal'].includes(requested))throw new Error('Climate must be preview or seasonal');
    if(previousSettings?.climate&&!previousSettings.climate.mode)throw new Error('Invalid saved campaign climate');
    const saved=previousSettings?(previousSettings.climate?.mode||'preview'):(legacyCampaign?'preview':null);
    if(saved&&!['preview','seasonal'].includes(saved))throw new Error('Unknown saved campaign climate');
    if(saved&&requested&&requested!==saved)throw new Error('This campaign already has a climate recipe. Save a new variant to change climate.');
    return saved||requested||'seasonal';
}
export function climateStamp(mode,prepared) {
    // Preserve the exact legacy settings shape, including its missing field.
    if(mode==='preview')return {};
    if(!prepared?.key||!prepared.coarse?.diagnostics?.converged)throw new Error('Seasonal climate is not ready');
    return {climate:{mode:'seasonal',key:prepared.key,version:prepared.coarse.version}};
}
export function assertClimateStamp(previousSettings,stamp) {
    if(previousSettings&&JSON.stringify(previousSettings.climate||null)!==JSON.stringify(stamp.climate||null))
        throw new Error('Saved campaign climate inputs changed. Save a new variant before baking a different climate.');
}
