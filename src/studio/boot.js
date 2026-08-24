/*
 * Startup: URL, stored project, skip-picker.
 *
 * The first-paint script in index.html only toggles `html.is-picker` from
 * the same keys — `?project=`, `?seed=`, `?variant=`, `planetgen.activeProject`.
 * Labels, title, and which project actually opens live here.
 */
'use strict';

const Projects = require('../projects');
const EarthFixture = require('../earth-fixture');
const Artifacts = require('../projects/artifacts');

const ACTIVE_PROJECT_KEY = 'planetgen.activeProject';
const ACTIVE_VARIANT_KEY = 'planetgen.activeVariant';


function knownProject(name) {
    return Projects.PROJECTS.some(p => p.name === name) ? name : null;
}


function readStoredProject() {
    try {
        return knownProject(localStorage.getItem(ACTIVE_PROJECT_KEY));
    } catch (_) {
        return null;
    }
}


function writeStoredProject(name) {
    if (!knownProject(name)) return;
    try { localStorage.setItem(ACTIVE_PROJECT_KEY, name); } catch (_) { /* private mode / quota */ }
}


function storedVariantsOf(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [project, id] of Object.entries(raw)) {
        if (knownProject(project) && Artifacts.isVariantId(id)) out[project] = id;
    }
    return out;
}


function nextStoredVariants(all, project, id) {
    const out = Object.assign({}, storedVariantsOf(all));
    if (knownProject(project) && Artifacts.isVariantId(id)) out[project] = id;
    else if (knownProject(project)) delete out[project];
    return out;
}


function readStoredVariants() {
    try {
        return storedVariantsOf(JSON.parse(localStorage.getItem(ACTIVE_VARIANT_KEY) || 'null'));
    } catch (_) {
        return {};
    }
}


function readStoredVariant(project) {
    return readStoredVariants()[project] || null;
}


function writeStoredVariant(project, id) {
    if (!knownProject(project)) return;
    try {
        localStorage.setItem(ACTIVE_VARIANT_KEY, JSON.stringify(nextStoredVariants(readStoredVariants(), project, id)));
    } catch (_) { /* private mode / quota */ }
}


function parseSeedParam(raw) {
    if (raw == null || raw === '') return null;
    const text = String(raw).trim();
    if (EarthFixture.isEarthSeed(text)) return EarthFixture.TOKEN;
    const n = Number(text);
    if (!Number.isFinite(n)) return null;
    return n | 0;
}


function queryOf(search) {
    const q = new URLSearchParams(search || '');
    const project = (q.get('project') || '').trim().toLowerCase();
    const variant = (q.get('variant') || '').trim();
    return {
        project: project || null,
        seed: parseSeedParam(q.get('seed')),
        variant: Artifacts.isVariantId(variant) ? variant : null,
    };
}


/* `search` and `stored` are injectable so this stays browser-free. */
function resolveStartup(input = {}) {
    const search = input.search != null
        ? input.search
        : (typeof location !== 'undefined' ? location.search : '');
    const stored = input.stored !== undefined ? input.stored : readStoredProject();
    const query = queryOf(search);
    const urlProject = knownProject(query.project);
    const queryProject = urlProject || (EarthFixture.isEarthSeed(query.seed) ? 'earth' : null);
    /* A seed in the query is a deep link into a planet, so skip the picker. */
    const project = queryProject
        || (query.seed != null || query.variant ? (stored || Projects.DEFAULT) : stored);
    const skipPicker = project != null;
    const opened = project || Projects.DEFAULT;
    const openedProject = Projects.byName(opened);
    const seed = query.seed != null
        ? (EarthFixture.isEarthSeed(query.seed) ? EarthFixture.TOKEN : query.seed)
        : (openedProject.fixture ? openedProject.seed : 1);
    return {
        project: opened,
        seed,
        variant: query.variant,
        seedFromQuery: query.seed != null,
        skipPicker,
    };
}


function syncAddressBar(project, seed, variant) {
    if (typeof history === 'undefined' || typeof location === 'undefined') return;
    try {
        const url = new URL(location.href);
        if (knownProject(project)) url.searchParams.set('project', project);
        else url.searchParams.delete('project');
        if (seed != null && seed !== '') url.searchParams.set('seed', String(seed));
        else url.searchParams.delete('seed');
        if (Artifacts.isVariantId(variant)) url.searchParams.set('variant', variant);
        else url.searchParams.delete('variant');
        const next = `${url.pathname}${url.search}${url.hash}`;
        if (next !== `${location.pathname}${location.search}${location.hash}`) {
            history.replaceState(null, '', next);
        }
    } catch (_) { /* file: or opaque origin */ }
}


module.exports = {
    ACTIVE_PROJECT_KEY,
    ACTIVE_VARIANT_KEY,
    knownProject,
    readStoredProject,
    writeStoredProject,
    storedVariantsOf,
    nextStoredVariants,
    readStoredVariant,
    writeStoredVariant,
    parseSeedParam,
    queryOf,
    resolveStartup,
    syncAddressBar,
};
