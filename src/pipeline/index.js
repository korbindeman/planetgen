'use strict';

const config = require('./config');
const document = require('./document');
const stages = require('./stages');
const runner = require('./runner');

module.exports = {
    freezeConfig: config.freezeConfig,
    bodyOf: config.bodyOf,
    modelOptions: config.modelOptions,
    assertPristineDefaults: config.assertPristineDefaults,
    createPlanet: document.createPlanet,
    surface: document.surface,
    toLegacy: document.toLegacy,
    stages,
    run: runner.run,
    STAGE_ORDER: runner.STAGE_ORDER,
};
