/*
 * Fine hydrology — not implemented. How hard to cut is open.
 *
 * Real river networks, discharge, lakes and canyons on the baked 90 m
 * (or 30 m) DEM. Not on the planetgen mesh. The bake already looks
 * eroded; this pass connects drainage. Do not rerun Shape's
 * stream-power recipe here. See docs/stages/carve-hydrology.md.
 */
'use strict';

function run() {
    throw new Error(
        '@planetgen/hydrology is a named slot. Fine drainage runs on the baked DEM, not the planetgen mesh. See docs/stages/carve-hydrology.md.',
    );
}

module.exports = {run};
