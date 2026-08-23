/*
 * Loading a project.
 *
 * Work in this repo happens in a project: Earth or Thalos. Thalos is the
 * default. A project is a named set of pins: every parameter it names is
 * decided, and everything it omits is free. Resolving one therefore has
 * to do two things, and the second is the one that is easy to get wrong —
 *
 *   1. apply the project's pins, and
 *   2. return every other parameter to its default.
 *
 * Without (2), loading Earth and then Thalos leaves Earth's nine cratons
 * behind, because Thalos never mentions `cratons` and nothing puts it back.
 * The result is a planet that belongs to neither project and cannot be
 * reproduced from either file. So this snapshots the pristine defaults when
 * it loads — before any project or `setTectonicOption` can touch them — and
 * every resolve starts from that snapshot rather than from whatever the last
 * one left behind.
 *
 * Browser-free, like the model it configures, so project loading can be
 * tested without a browser: `bun run check:projects`.
 */
'use strict';

const Tectonics = require('../tectonics');
const Climate = require('../climate');
const Detail = require('../detail');
const World = require('../world');
const EarthFixture = require('../earth-fixture');
const Params = require('../params');
const STAGES = require('./pipeline');
const Artifacts = require('./artifacts');

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
 * statically, so a project only reaches the app if it is named here. */
const PROJECTS = [
    Object.assign({label: 'Thalos'}, require('./thalos')),
    Object.assign({label: 'Earth'}, require('./earth')),
];

const DEFAULT = 'thalos';


function byName(name) {
    const found = PROJECTS.find(p => p.name === name);
    if (!found) throw new Error(`unknown project "${name}"`);
    return found;
}


/* Full option sets for each module: pristine defaults with the project's
 * pins laid over them. Assigning these wholesale is what makes unpinning
 * work, so callers should not merge them into the current values. */
function resolve(nameOrProject) {
    const project = typeof nameOrProject === 'string' ? byName(nameOrProject) : nameOrProject;

    const problems = Params.checkProject(project).concat(checkPipeline(project));
    if (problems.length) throw new Error('invalid project:\n  ' + problems.join('\n  '));

    const registry = Params.all();
    const options = {
        world: Object.assign({}, PRISTINE.world),
        tectonics: Object.assign({}, PRISTINE.tectonics),
        climate: Object.assign({}, PRISTINE.climate),
        detail: Object.assign({}, PRISTINE.detail),
        fixture: Object.assign({}, PRISTINE.fixture),
    };
    const pins = [];

    for (const [name, value] of Object.entries(project.values || {})) {
        const meta = registry[name];
        pins.push({name, value, module: meta.module, unit: meta.unit});
        if (options[meta.module]) options[meta.module][name] = value;
    }

    pins.sort((a, b) => a.name.localeCompare(b.name));
    return {project, seed: project.seed, options, pins};
}


function checkPipeline(project) {
    const problems = [];
    const known = new Set(STAGES.map(s => s.id));
    const name = project && project.name ? project.name : 'project';
    const pipeline = project && project.pipeline;
    if (pipeline == null) return problems;
    if (typeof pipeline !== 'object' || Array.isArray(pipeline)) {
        return [`${name}: pipeline is not an object`];
    }
    for (const [id, note] of Object.entries(pipeline)) {
        if (!known.has(id)) problems.push(`${name}: unknown pipeline stage "${id}"`);
        if (note != null && typeof note !== 'string') {
            problems.push(`${name}.${id}: pipeline note must be a string`);
        }
    }
    return problems;
}


module.exports = {
    PROJECTS, DEFAULT, PRISTINE, STAGES, byName, resolve, checkPipeline,
    dir: Artifacts.dir,
    bakeDir: Artifacts.bakeDir,
    sameSeed: Artifacts.sameSeed,
};
