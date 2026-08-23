/*
 * Fine hydrology — not implemented.
 *
 * Real river networks, discharge, lakes and canyons on the baked 90 m
 * (or 30 m) DEM. Not on the planetgen mesh. The detail pass already
 * roughs in valleys; this stage cuts the network.
 */
'use strict';

function run() {
    throw new Error(
        '@planetgen/hydrology is a named slot. Fine drainage runs on the baked DEM, not the planetgen mesh. See docs/preparing-for-diffusion.md.',
    );
}

module.exports = {run};
