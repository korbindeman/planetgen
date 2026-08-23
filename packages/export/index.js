/*
 * Conditioning-sketch export.
 *
 * Writes the five-channel GeoTIFF handoff terrain-diffusion reads.
 * The CLI is still `bun run export:td`; this package is the place that
 * work moves into, and the rasterizers the script already uses.
 */
'use strict';

const Planet = require('../../src/planet');

module.exports = {
    rasterizeEquirect: Planet.rasterizeEquirect,
    rasterizeLonLatBox: Planet.rasterizeLonLatBox,
};
