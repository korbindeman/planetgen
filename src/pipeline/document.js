/*
 * The Planet document.
 *
 * Stages write into `sim` or `detail`. They do not replace the object.
 * Overlay views keep reading `sim` after coasts have been warped.
 */
'use strict';

const {bodyOf} = require('./config');


function createPlanet(config) {
    return {
        config,
        body: bodyOf(config),
        sim: null,
        detail: null,
        geometry: null,
    };
}


function surface(planet) {
    return planet.detail || planet.sim;
}


/* Aliases the app and the scripts already read. Mutates `planet` so one
 * object is both the document and the legacy return. */
function toLegacy(planet) {
    const vis = surface(planet);
    planet.seed = planet.config.seed;
    planet.n = planet.config.n;
    planet.p = planet.config.options.tectonics.plates;
    planet.jitter = planet.config.jitter;
    planet.mesh = vis.mesh;
    planet.map = vis.map;
    planet.simMesh = planet.sim.mesh;
    planet.simMap = planet.sim.map;
    return planet;
}


module.exports = {createPlanet, surface, toLegacy};
