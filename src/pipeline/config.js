/*
 * Frozen pipeline config.
 *
 * A project resolve plus caller overrides, snapshotted once. Models still
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
const Projects = require('../projects');
const Params = require('../params');

const BODY_KEYS = Params.bodyNames();


function freezeBag(bag) {
    return Object.freeze(Object.assign({}, bag));
}


function pickProject(input) {
    if (EarthFixture.isEarthSeed(input.seed)) return Projects.byName('earth');
    if (typeof input.project === 'string') return Projects.byName(input.project);
    if (input.project && typeof input.project === 'object' && input.project.name) {
        return input.project;
    }
    return Projects.byName(Projects.DEFAULT);
}


function resolveProject(input) {
    const named = pickProject(input);
    /* `values` is the complete overlay when the caller has one (the app,
     * a variant recipe). Do not merge the authored bag back over it — that
     * would re-apply a freed body value. No values means use the file. */
    const values = input.values != null ? input.values : Projects.authored(named);
    return Projects.resolve({
        name: named.name,
        values,
    });
}


/* One immutable config. `derived` is a snapshot at the sim mesh size, for
 * the document and for inspection — climate still derives per mesh. */
function freezeConfig(input = {}) {
    const resolved = resolveProject(input);
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
    else detail.n = World.regionsForSpacingKm(detail.shapeSpacingKm || 23, world);

    const seed = input.seed != null
        ? (EarthFixture.isEarthSeed(input.seed) ? EarthFixture.TOKEN : (input.seed | 0) || 1)
        : (resolved.seed != null
            ? (EarthFixture.isEarthSeed(resolved.seed) ? EarthFixture.TOKEN : resolved.seed)
            : 1);
    const shapeSeed = input.shapeSeed != null
        ? (EarthFixture.numericSeed(input.shapeSeed) || 1)
        : EarthFixture.numericSeed(seed);
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
        shapeSeed,
        n,
        jitter,
        simulateTectonics: input.simulateTectonics !== false,
        /* Tectonics + sea level only: no climate, detail, erosion, or
         * geometry. Search tiles use this — continent layout is enough. */
        baseOnly: !!input.baseOnly,
        detailPass: input.baseOnly ? false : input.detailPass === true,
        erosion: input.baseOnly ? false : input.erosion !== false && input.detailPass === true,
        climateOn: input.climateOn === 'surface' ? 'surface' : 'sim',
        mergeOceanPlates: !!input.mergeOceanPlates,
        connectOceans: !!input.connectOceans,
        quiet: !!input.quiet,
        options,
        derived: Object.freeze(derived),
        pins: resolved.pins,
        project: resolved.project ? resolved.project.name : Projects.DEFAULT,
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
        ['world', World.DEFAULTS, Projects.PRISTINE.world],
        ['tectonics', Tectonics.DEFAULTS, Projects.PRISTINE.tectonics],
        ['climate', Climate.DEFAULTS, Projects.PRISTINE.climate],
        ['detail', Detail.DEFAULTS, Projects.PRISTINE.detail],
        ['fixture', EarthFixture.DEFAULTS, Projects.PRISTINE.fixture],
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
