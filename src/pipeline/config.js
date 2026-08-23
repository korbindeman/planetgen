/*
 * Frozen pipeline config.
 *
 * A preset resolve plus caller overrides, snapshotted once. Models still
 * call World.derive themselves (climate rates depend on the mesh they
 * run on), but they merge this snapshot over pristine DEFAULTS — nobody
 * writes through to the module objects.
 */
'use strict';

const World = require('../world');
const Tectonics = require('../tectonics');
const Climate = require('../climate');
const Detail = require('../detail');
const EarthFixture = require('../earth-fixture');
const Presets = require('../presets');

const BODY_KEYS = [
    'radiusKm', 'gravityG', 'landFraction',
    'rotationHours', 'axialTiltDeg', 'ageGyr',
];


function freezeBag(bag) {
    return Object.freeze(Object.assign({}, bag));
}


function resolvePreset(input) {
    const values = input.values
        || (input.preset && typeof input.preset === 'object' && input.preset.values)
        || {};
    if (typeof input.preset === 'string') {
        const named = Presets.byName(input.preset);
        return Presets.resolve({
            name: named.name,
            seed: named.seed,
            values: Object.assign({}, named.values, values),
        });
    }
    if (input.preset && typeof input.preset === 'object' && input.preset.name) {
        return Presets.resolve({
            name: input.preset.name,
            seed: input.preset.seed,
            values: Object.assign({}, input.preset.values || {}, values),
        });
    }
    return Presets.resolve({name: 'defaults', values});
}


/* One immutable config. `derived` is a snapshot at the sim mesh size, for
 * the document and for inspection — climate still derives per mesh. */
function freezeConfig(input = {}) {
    const resolved = resolvePreset(input);
    const world = Object.assign({}, resolved.options.world, input.world);
    const tectonics = Object.assign(
        {},
        resolved.options.tectonics,
        input.tectonics,
        input.tectonicOptions,
    );
    const climate = Object.assign({}, resolved.options.climate, input.climate);
    const detail = Object.assign({}, resolved.options.detail, input.detail);
    const fixture = Object.assign({}, resolved.options.fixture, input.fixture);

    if (input.simSteps != null) tectonics.steps = input.simSteps;
    if (input.p != null) tectonics.plates = input.p;
    if (input.polarStraits != null) tectonics.polarStraits = input.polarStraits;
    if (input.detailN != null) detail.n = input.detailN;

    const seed = input.seed != null
        ? (EarthFixture.isEarthSeed(input.seed) ? EarthFixture.TOKEN : (input.seed | 0) || 1)
        : (resolved.seed != null
            ? (EarthFixture.isEarthSeed(resolved.seed) ? EarthFixture.TOKEN : resolved.seed)
            : 88);
    const n = input.n == null ? 10000 : (input.n | 0);
    const jitter = input.jitter == null ? 0.75 : input.jitter;

    const options = Object.freeze({
        world: freezeBag(world),
        tectonics: freezeBag(tectonics),
        climate: freezeBag(climate),
        detail: freezeBag(detail),
        fixture: freezeBag(fixture),
    });

    const derived = World.derive(Object.assign({}, world, tectonics, climate), n);

    return Object.freeze({
        seed,
        n,
        jitter,
        simulateTectonics: input.simulateTectonics !== false,
        detailPass: input.detailPass !== false,
        erosion: input.erosion !== false,
        climateOn: input.climateOn === 'surface' ? 'surface' : 'sim',
        mergeOceanPlates: !!input.mergeOceanPlates,
        connectOceans: !!input.connectOceans,
        quiet: !!input.quiet,
        options,
        derived: Object.freeze(derived),
        pins: resolved.pins,
        preset: resolved.preset ? resolved.preset.name : 'defaults',
    });
}


function bodyOf(config) {
    const world = config.options.world;
    const body = {};
    for (const key of BODY_KEYS) body[key] = world[key];
    return Object.freeze(body);
}


/* Options one model entry point wants: body + its own bag. */
function modelOptions(config, module, extra) {
    return Object.assign({}, config.options.world, config.options[module], extra);
}


function assertPristineDefaults() {
    const problems = [];
    const pairs = [
        ['world', World.DEFAULTS, Presets.PRISTINE.world],
        ['tectonics', Tectonics.DEFAULTS, Presets.PRISTINE.tectonics],
        ['climate', Climate.DEFAULTS, Presets.PRISTINE.climate],
        ['detail', Detail.DEFAULTS, Presets.PRISTINE.detail],
        ['fixture', EarthFixture.DEFAULTS, Presets.PRISTINE.fixture],
    ];
    for (const [name, live, pristine] of pairs) {
        for (const key of Object.keys(pristine)) {
            if (live[key] !== pristine[key]) {
                problems.push(`${name}.${key}: live ${live[key]} !== pristine ${pristine[key]}`);
            }
        }
    }
    return problems;
}


module.exports = {
    BODY_KEYS,
    freezeConfig,
    bodyOf,
    modelOptions,
    assertPristineDefaults,
};
