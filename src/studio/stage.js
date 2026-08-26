/*
 * The Discover tab is the globe. Layout is the 10k sim. Shape is the
 * sketch. Nothing else may choose the tab — not a stored intent, not
 * variant.shaped, not a pipeline fact. If the layout mesh is up, the
 * Shape tab is off.
 */
'use strict';


function discoverStage(session) {
    if (session && session.searchSession) return 'layout';
    const host = session && session.host;
    if (host && typeof host.isShaped === 'function' && host.isShaped()) return 'shape';
    return 'layout';
}


module.exports = {discoverStage};
