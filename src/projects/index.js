/*
 * Loading a project or the Earth fixture.
 *
 * A project is a tree of variants plus an optional adopted body. Earth is
 * the fixture: authored knobs and a seed token, no tree. Resolving one
 * starts from the pristine defaults and lays the authored bag over them.
 * A caller overlay (studio, a variant recipe) replaces that bag entirely
 * so a freed body value is not put back.
 *
 * Without the pristine reset, loading Earth and then Thalos leaves
 * Earth's nine cratons behind. So this snapshots the defaults at load —
 * before any resolve can touch them — and every resolve starts there.
 *
 * Browser-free, so `bun run check:projects` can hold this without a browser.
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
const Variants = require('./variants');
const Init = require('./init');

/* Taken at module load, so it is the values as authored in each module.
 * Nothing mutates DEFAULTS before a user asks for it. */
const PRISTINE = {
    world: Object.assign({}, World.DEFAULTS),
    tectonics: Object.assign({}, Tectonics.DEFAULTS),
    climate: Object.assign({}, Climate.DEFAULTS),
    detail: Object.assign({}, Detail.DEFAULTS),
    fixture: Object.assign({}, EarthFixture.DEFAULTS),
};

/* Shipped worlds are listed rather than globbed: the browser bundler
 * resolves requires statically. User projects are registered at runtime
 * from `preview/<name>/project.json`. */
const SHIPPED = [
    require('./thalos'),
    require('./earth'),
];
const PROJECTS = SHIPPED.slice();

const DEFAULT = 'thalos';


function isShipped(name) {
    return SHIPPED.some(p => p.name === name);
}


function byName(name) {
    const found = PROJECTS.find(p => p.name === name);
    if (!found) throw new Error(`unknown project "${name}"`);
    return found;
}


function list() {
    const extra = PROJECTS.filter(p => !isShipped(p.name));
    extra.sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
    return SHIPPED.concat(extra);
}


function resetRegistry() {
    PROJECTS.splice(0, PROJECTS.length, ...SHIPPED);
}


function register(raw) {
    const project = Init.parseRecord(raw);
    if (isShipped(project.name)) {
        throw new Error(`"${project.name}" is a shipped project`);
    }
    const problems = Params.checkProject(project).concat(checkPipeline(project));
    if (problems.length) throw new Error('invalid project:\n  ' + problems.join('\n  '));
    const i = PROJECTS.findIndex(p => p.name === project.name);
    if (i >= 0) PROJECTS[i] = project;
    else PROJECTS.push(project);
    return project;
}


function isFixture(nameOrProject) {
    const project = typeof nameOrProject === 'string' ? byName(nameOrProject) : nameOrProject;
    return !!(project && project.fixture);
}


/* The bag a file authors: adopted body for a project, body plus knobs
 * for the fixture. A project still initializing draws from its buckets. */
function authored(nameOrProject) {
    const project = typeof nameOrProject === 'string' ? byName(nameOrProject) : nameOrProject;
    if (project.fixture) {
        return Object.assign({}, project.body || {}, project.values || {});
    }
    if (project.body && Object.keys(project.body).length) {
        return Object.assign({}, project.body);
    }
    if (project.init) return Init.draw(project, 1);
    return {};
}


function namedOf(nameOrProject) {
    if (typeof nameOrProject === 'string') return byName(nameOrProject);
    if (nameOrProject && nameOrProject.name) return byName(nameOrProject.name);
    throw new Error('unknown project');
}


/* Full option sets for each module: pristine defaults with the authored
 * bag or a caller overlay laid over them. Assigning these wholesale is
 * what makes a freed body value actually free, so callers should not
 * merge them into the current values. */
function resolve(nameOrProject) {
    const named = namedOf(nameOrProject);
    const overlay = (nameOrProject && typeof nameOrProject === 'object' && nameOrProject.values != null)
        ? nameOrProject.values
        : null;

    const problems = Params.checkProject(named)
        .concat(checkPipeline(named))
        .concat(overlay ? Params.checkValues(named.name, overlay) : []);
    if (problems.length) throw new Error('invalid project:\n  ' + problems.join('\n  '));

    const registry = Params.all();
    const options = {
        world: Object.assign({}, PRISTINE.world),
        tectonics: Object.assign({}, PRISTINE.tectonics),
        climate: Object.assign({}, PRISTINE.climate),
        detail: Object.assign({}, PRISTINE.detail),
        fixture: Object.assign({}, PRISTINE.fixture),
    };
    const values = overlay != null ? overlay : authored(named);
    const applied = [];

    for (const [name, value] of Object.entries(values)) {
        const meta = registry[name];
        if (!meta) continue;
        applied.push({name, value, module: meta.module, unit: meta.unit});
        if (options[meta.module]) options[meta.module][name] = value;
    }

    applied.sort((a, b) => a.name.localeCompare(b.name));
    return {
        project: named,
        seed: named.fixture ? named.seed : null,
        options,
        body: Params.pickBody(Object.assign({}, options.world, options.tectonics)),
        applied,
        pins: applied,
        fixture: !!named.fixture,
    };
}


function checkPipeline(project) {
    const problems = [];
    const known = new Set(STAGES.map(s => s.id));
    const name = project && project.name ? project.name : 'project';
    if (project && project.fixture && project.init) {
        problems.push(`${name}: a fixture has no initialize buckets`);
    }
    if (project && project.init != null && !project.fixture) {
        problems.push.apply(problems, Init.checkInit(project.init, name));
    }
    const pipeline = project && project.pipeline;
    if (pipeline == null) return problems;
    if (typeof pipeline !== 'object' || Array.isArray(pipeline)) {
        problems.push(`${name}: pipeline is not an object`);
        return problems;
    }
    for (const [id, note] of Object.entries(pipeline)) {
        if (!known.has(id)) problems.push(`${name}: unknown pipeline stage "${id}"`);
        if (note != null && typeof note !== 'string') {
            problems.push(`${name}.${id}: pipeline note must be a string`);
        }
    }
    return problems;
}


function recipeOf(variant, adopted) {
    return Object.assign({}, adopted || {}, (variant && variant.body) || {}, (variant && variant.values) || {}, (variant && variant.pins) || {});
}


function parseCatalog(raw, name) {
    const project = name && PROJECTS.find(p => p.name === name);
    return Variants.parseCatalog(raw, name, project && project.body);
}


module.exports = {
    PROJECTS, SHIPPED, DEFAULT, PRISTINE, STAGES, byName, list, register,
    resetRegistry, isShipped, resolve, checkPipeline,
    isFixture, authored, recipeOf, parseCatalog,
    dir: Artifacts.dir,
    bakeDir: Artifacts.bakeDir,
    variantDir: Artifacts.variantDir,
    catalogPath: Artifacts.catalogPath,
    projectFile: Artifacts.projectFile,
    thumbPath: Artifacts.thumbPath,
    shapePath: Artifacts.shapePath,
    layoutPath: Artifacts.layoutPath,
    isVariantId: Artifacts.isVariantId,
    sameSeed: Artifacts.sameSeed,
    Variants,
    Init,
};
