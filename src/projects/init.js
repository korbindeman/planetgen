/*
 * Initialize: the start of a project.
 *
 * Name it, then pick body buckets. A bucket is a named interval with a
 * real body next to it — not an exact value. Picking Small clamps
 * radius; it does not write 3186. The project stores those buckets
 * until an adopted body is set. Each generate is a working planet.
 *
 * Browser-free, so `bun run check:projects` can hold the record.
 */
'use strict';

const Params = require('../params');
const Search = require('../search');
const World = require('../world');

const NAME_MAX = 48;
const RESERVED = Object.freeze(['earth', 'thalos']);

const DEFAULT_PINS = Object.freeze({
    gravityG: World.DEFAULTS.gravityG,
    axialTiltDeg: World.DEFAULTS.axialTiltDeg,
});

const DEFAULTS = Object.freeze({
    size: 'earth',
    age: 'earth',
    day: 'earth',
    water: 'earth',
});

/* Each option's range must sit inside the vouched interval for that
 * parameter. The hints are real bodies, not targets to copy. */
const AXES = Object.freeze({
    size: Object.freeze({
        param: 'radiusKm',
        label: 'How big',
        options: Object.freeze([
            Object.freeze({id: 'small', label: 'Small', hint: 'Mars-class', range: [2500, 4000]}),
            Object.freeze({id: 'earth', label: 'Earth', hint: 'Earth-class', range: [5500, 7500]}),
            Object.freeze({id: 'large', label: 'Large', hint: 'Bigger than Earth', range: [9000, 14000]}),
            Object.freeze({id: 'xl', label: 'XL', hint: 'The top of this generator', range: [15000, 20000]}),
        ]),
    }),
    age: Object.freeze({
        param: 'ageGyr',
        label: 'How old',
        options: Object.freeze([
            Object.freeze({id: 'young', label: 'Young', hint: 'Early', range: [0.5, 2.5]}),
            Object.freeze({id: 'earth', label: 'Earth', hint: 'Earth-age', range: [3.5, 5.5]}),
            Object.freeze({id: 'old', label: 'Old', hint: 'Old', range: [6.5, 10]}),
        ]),
    }),
    day: Object.freeze({
        param: 'rotationHours',
        label: 'How long is the day',
        options: Object.freeze([
            Object.freeze({id: 'fast', label: 'Short', hint: 'A short day', range: [6, 14]}),
            Object.freeze({id: 'earth', label: 'Earth', hint: 'Earth-like', range: [18, 30]}),
            Object.freeze({id: 'slow', label: 'Long', hint: 'A long day', range: [80, 200]}),
        ]),
    }),
    water: Object.freeze({
        param: 'seaLevelThicknessKm',
        label: 'How much water',
        options: Object.freeze([
            Object.freeze({id: 'dry', label: 'Dry', hint: 'Basins not full', range: [24, 26]}),
            Object.freeze({id: 'earth', label: 'Earth seas', hint: 'Earth seas', range: [28, 30]}),
            Object.freeze({id: 'ocean', label: 'Ocean world', hint: 'Drowned', range: [32, 34]}),
        ]),
    }),
});


function slugFromName(name) {
    const slug = String(name || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (!/^[a-z][a-z0-9-]*$/.test(slug)) return '';
    return slug;
}


function normalizeLabel(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, NAME_MAX);
}


function isReserved(name) {
    return RESERVED.includes(String(name || '').toLowerCase());
}


function optionOf(axis, id) {
    const spec = AXES[axis];
    if (!spec) return null;
    return spec.options.find((item) => item.id === id) || null;
}


function parseInit(raw) {
    const out = {};
    for (const axis of Object.keys(AXES)) {
        const opt = optionOf(axis, raw && raw[axis]);
        out[axis] = opt ? opt.id : DEFAULTS[axis];
    }
    return out;
}


function checkInit(raw, label) {
    const problems = [];
    const tag = label || 'project';
    if (raw == null) return problems;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return [`${tag}: init is not an object`];
    }
    for (const [axis, id] of Object.entries(raw)) {
        if (!AXES[axis]) {
            problems.push(`${tag}.init: unknown bucket "${axis}"`);
            continue;
        }
        if (!optionOf(axis, id)) {
            problems.push(`${tag}.init.${axis}: unknown bucket "${id}"`);
        }
    }
    return problems;
}


function rangesOf(init) {
    const parsed = parseInit(init);
    const out = {};
    for (const [axis, spec] of Object.entries(AXES)) {
        const opt = optionOf(axis, parsed[axis]);
        if (opt) out[spec.param] = opt.range.slice();
    }
    return out;
}


function draw(project, seed) {
    const out = Object.assign({}, DEFAULT_PINS);
    const parsed = parseInit(project && project.init);
    const rand = Search.rngFrom(seed == null ? 1 : seed);
    for (const [axis, spec] of Object.entries(AXES)) {
        if (project && project.body && Params.isBody(spec.param) && spec.param in project.body) {
            continue;
        }
        const range = optionOf(axis, parsed[axis]).range;
        const value = range[0] + rand() * (range[1] - range[0]);
        out[spec.param] = Search.quantize(spec.param, value, range);
    }
    Object.assign(out, Params.pickBody((project && project.body) || {}));
    return out;
}


function startingPins(project) {
    if (project && project.fixture) return Object.assign({}, (project.body) || {});
    if (project && project.body && Object.keys(project.body).length) {
        return Object.assign({}, project.body);
    }
    return Object.assign({}, DEFAULT_PINS);
}


function buildRecord(input) {
    const label = normalizeLabel(input && (input.label || input.name));
    const name = slugFromName(label);
    const problems = [];
    if (!label) problems.push('name the project');
    else if (!name) problems.push('the name must start with a letter');
    if (isReserved(name)) problems.push(`"${label}" is already a project`);
    const init = parseInit(input && input.init);
    problems.push.apply(problems, checkInit(init, name || 'project'));
    if (problems.length) {
        const error = new Error(problems[0]);
        error.problems = problems;
        throw error;
    }
    return {
        name,
        label,
        pipeline: {layout: 'in play'},
        init,
    };
}


function parseRecord(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('project is not an object');
    }
    if (raw.fixture) throw new Error('a user project is not a fixture');
    const label = normalizeLabel(raw.label || raw.name);
    const name = typeof raw.name === 'string' ? slugFromName(raw.name) : slugFromName(label);
    if (!name) throw new Error('project has no name');
    if (isReserved(name)) throw new Error(`"${name}" is a shipped project`);
    const init = raw.init != null ? parseInit(raw.init) : null;
    const body = Params.pickBody(raw.body || {});
    const project = {
        name,
        label: label || name,
        pipeline: raw.pipeline && typeof raw.pipeline === 'object' && !Array.isArray(raw.pipeline)
            ? Object.assign({}, raw.pipeline)
            : {layout: 'in play'},
    };
    if (init) project.init = init;
    if (Object.keys(body).length) project.body = body;
    return project;
}


const bucketProblems = [];
for (const [axis, spec] of Object.entries(AXES)) {
    const vouched = Params.vouchedRange(spec.param);
    if (!vouched) {
        bucketProblems.push(`${spec.param} has no vouched range`);
        continue;
    }
    for (const opt of spec.options) {
        if (opt.range[0] < vouched[0] || opt.range[1] > vouched[1]) {
            bucketProblems.push(`${axis}.${opt.id} [${opt.range}] leaves vouched [${vouched}]`);
        }
    }
}
if (bucketProblems.length) {
    throw new Error('init buckets are out of date:\n  ' + bucketProblems.join('\n  '));
}


module.exports = {
    NAME_MAX,
    RESERVED,
    DEFAULT_PINS,
    DEFAULTS,
    AXES,
    slugFromName,
    normalizeLabel,
    isReserved,
    optionOf,
    parseInit,
    checkInit,
    rangesOf,
    draw,
    startingPins,
    buildRecord,
    parseRecord,
};
