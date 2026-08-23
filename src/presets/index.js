/*
 * Loading a preset.
 *
 * A preset is a named set of pins: every parameter it names is decided, and
 * everything it omits is free. Resolving one therefore has to do two things,
 * and the second is the one that is easy to get wrong —
 *
 *   1. apply the preset's pins, and
 *   2. return every other parameter to its default.
 *
 * Without (2), loading Earth and then Thalos leaves Earth's nine cratons
 * behind, because Thalos never mentions `cratons` and nothing puts it back.
 * The result is a planet that belongs to neither preset and cannot be
 * reproduced from either file. So this snapshots the pristine defaults when
 * it loads — before any preset or `setTectonicOption` can touch them — and
 * every resolve starts from that snapshot rather than from whatever the last
 * one left behind.
 *
 * Browser-free, like the model it configures, so preset loading can be
 * tested without a browser: `bun run check:presets`.
 */
'use strict';

const Tectonics = require('../tectonics');
const Climate = require('../climate');
const Detail = require('../detail');
const World = require('../world');
const EarthFixture = require('../earth-fixture');
const Params = require('../params');

/* Taken at module load, so it is the values as authored in each module.
 * Nothing mutates DEFAULTS before a user asks for it. */
const PRISTINE = {
    world: Object.assign({}, World.DEFAULTS),
    tectonics: Object.assign({}, Tectonics.DEFAULTS),
    climate: Object.assign({}, Climate.DEFAULTS),
    detail: Object.assign({}, Detail.DEFAULTS),
    fixture: Object.assign({}, EarthFixture.DEFAULTS),
};

/* Listed rather than globbed: the browser bundler resolves requires
 * statically, so a preset only reaches the app if it is named here. */
const PRESETS = [
    {
        name: 'defaults',
        label: 'Defaults',
        /* The empty constraint set. Keeps the current seed — clearing pins
         * is not the same gesture as asking for a different planet. */
        seed: null,
        values: {},
    },
    Object.assign({label: 'Earth'}, require('./earth')),
    Object.assign({label: 'Thalos'}, require('./thalos')),
];


function byName(name) {
    const found = PRESETS.find(p => p.name === name);
    if (!found) throw new Error(`unknown preset "${name}"`);
    return found;
}


/* Full option sets for each module: pristine defaults with the preset's
 * pins laid over them. Assigning these wholesale is what makes unpinning
 * work, so callers should not merge them into the current values. */
function resolve(nameOrPreset) {
    const preset = typeof nameOrPreset === 'string' ? byName(nameOrPreset) : nameOrPreset;

    const problems = Params.checkPreset(preset);
    if (problems.length) throw new Error('invalid preset:\n  ' + problems.join('\n  '));

    const registry = Params.all();
    const options = {
        world: Object.assign({}, PRISTINE.world),
        tectonics: Object.assign({}, PRISTINE.tectonics),
        climate: Object.assign({}, PRISTINE.climate),
        detail: Object.assign({}, PRISTINE.detail),
        fixture: Object.assign({}, PRISTINE.fixture),
    };
    const pins = [];

    for (const [name, value] of Object.entries(preset.values)) {
        const meta = registry[name];
        pins.push({name, value, module: meta.module, unit: meta.unit});
        if (options[meta.module]) options[meta.module][name] = value;
    }

    pins.sort((a, b) => a.name.localeCompare(b.name));
    return {preset, seed: preset.seed, options, pins};
}


module.exports = {PRESETS, PRISTINE, byName, resolve};
