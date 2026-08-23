/*
 * Conditioning-sketch export.
 *
 * Rasterizers live on the Planet document. Writing a project's crop set
 * is `scripts/export-project.mjs` — the CLI and the bake server both
 * call it. Crops go in preview/<name>/.
 */
'use strict';

const Planet = require('../../src/planet');

module.exports = {
    rasterizeEquirect: Planet.rasterizeEquirect,
    rasterizeLonLatBox: Planet.rasterizeLonLatBox,
};
