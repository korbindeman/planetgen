/*
 * Fine hydrology — not implemented. How hard to cut is open.
 *
 * Real river networks, discharge, lakes and canyons on the baked 90 m
 * (or 30 m) DEM. Not on the planetgen mesh. The grain-independent drain
 * is src/route.js. Shape already uses a light cut of that. This package
 * would call the same core on the bake. Do not rerun Shape's incision
 * knobs here. See docs/stages/carve-hydrology.md.
 */
'use strict';

function run() {
    throw new Error(
        '@planetgen/hydrology is a named slot. Fine drainage runs on the baked DEM, not the planetgen mesh. See docs/stages/carve-hydrology.md.',
    );
}

module.exports = {run};
