/*
 * Linear stage runner.
 *
 * Layout (tectonics + climate on the sim) is cached on the mesh cache
 * object so Shape can rerun without touching plates. Shape is detail +
 * erosion on that sim. seaLevel and geometry always run on whatever is
 * visible at the end.
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


function layoutKey(config) {
    return JSON.stringify({
        seed: config.seed,
        n: config.n,
        jitter: config.jitter,
        simulateTectonics: config.simulateTectonics,
        mergeOceanPlates: config.mergeOceanPlates,
        connectOceans: config.connectOceans,
        baseOnly: config.baseOnly,
        world: config.options.world,
        tectonics: config.options.tectonics,
        climate: config.options.climate,
        fixture: config.options.fixture,
    });
}


function takeLayout(planet, cache) {
    const key = layoutKey(planet.config);
    if (cache.layout && cache.layout.key === key && cache.layout.sim) {
        planet.sim = cache.layout.sim;
        return true;
    }
    stages.tectonics(planet, cache);
    if (!planet.config.baseOnly) {
        stages.climate(planet, planet.sim.mesh, planet.sim.map);
    }
    cache.layout = {key, sim: planet.sim};
    return false;
}


function runShape(planet, cache) {
    if (!planet.config.detailPass) return;
    stages.detail(planet, cache);
    stages.erosion(planet);
}


function run(input = {}, cache = {}) {
    const config = input.config && input.config.options
        ? input.config
        : freezeConfig(input);
    const planet = createPlanet(config);

    takeLayout(planet, cache);
    if (!config.baseOnly) runShape(planet, cache);
    stages.seaLevel(planet);
    if (!config.baseOnly) {
        if (config.climateOn === 'surface') {
            const vis = planet.detail || planet.sim;
            stages.climate(planet, vis.mesh, vis.map);
        }
        stages.geometry(planet);
    }

    return toLegacy(planet);
}


module.exports = {run, runShape, takeLayout, layoutKey, STAGE_ORDER};
