/*
 * Linear stage runner.
 *
 * config → body → meshes (inside tectonics/detail) → tectonics →
 * climate(sim) → detail → erosion → seaLevel → climate(surface?) →
 * geometry.
 */
'use strict';

const {freezeConfig} = require('./config');
const {createPlanet, toLegacy} = require('./document');
const stages = require('./stages');

const STAGE_ORDER = [
    'tectonics',
    'climate',
    'detail',
    'erosion',
    'seaLevel',
    'geometry',
];


function run(input = {}, cache = {}) {
    const config = input.config && input.config.options
        ? input.config
        : freezeConfig(input);
    const planet = createPlanet(config);

    stages.tectonics(planet, cache);
    stages.climate(planet, planet.sim.mesh, planet.sim.map);
    stages.detail(planet, cache);
    stages.erosion(planet);
    stages.seaLevel(planet);
    if (config.climateOn === 'surface') {
        const vis = planet.detail || planet.sim;
        stages.climate(planet, vis.mesh, vis.map);
    }
    stages.geometry(planet);

    return toLegacy(planet);
}


module.exports = {run, STAGE_ORDER};
