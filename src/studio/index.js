/*
 * The studio: picker, shell, stage panels, variant tree. Chrome is Preact.
 * The renderer keeps WebGL, mesh generation, and process flags.
 */
'use strict';

const Projects = require('../projects');
const Params = require('../params');
const Search = require('../search');
const LayoutArtifact = require('../layout-artifact');
const ShapeArtifact = require('../shape-artifact');
const EarthFixture = require('../earth-fixture');
const TdOverlay = require('../td-overlay');
const Boot = require('./boot');
const Sidebar = require('./sidebar');
const Ui = require('./ui');
const Undo = require('./undo');
const { mountHudIcons } = require('./icons.js');

const SEED_HISTORY_MAX = 50;
const VARIANTS_KEY = 'planetgen.variants';
const SAVED_SEEDS_KEY = 'planetgen.savedSeeds';
const SEARCH_KEEPS_KEY = 'planetgen.searchKeeps';
const Variants = Projects.Variants;
const Init = Projects.Init;
let thumbFill = 0;


function createSession(startup) {
    const project = startup.project;
    const named = Projects.byName(project);
    const pins = Init.startingPins(named);
    const seed = startup.seed != null ? startup.seed : 1;
    return {
        project,
        seed,
        shapeSeed: seed,
        pins,
        workingValues: {},
        lastResolved: Projects.resolve({name: project, values: effectiveBag(project, pins, {})}),
        projectModified: false,
        planetReady: false,
        seedHistory: [seed],
        seedHistoryIndex: 0,
        searchSession: null,
        searchRun: 0,
        variant: null,
        workingParent: null,
        workingRanges: null,
        workingThumb: '',
        compareId: null,
        discovery: false,
        catalog: Variants.emptyCatalog(project),
        pendingVariantId: startup.variant || null,
        seedFromQuery: !!startup.seedFromQuery,
        pipelineFact: null,
        pipelineShapeBusy: false,
        pipelineLayoutBusy: false,
        layoutBackfill: false,
        host: null,
        ui: {
            variantsOpen: false,
            saveName: '',
            undo: null,
            pickerView: 'list',
            createDraft: Object.assign({name: ''}, Init.DEFAULTS),
            createError: '',
            createBusy: false,
        },
    };
}


function parseSeed(raw) {
    return Boot.parseSeedParam(raw);
}


function projectLabel(name) {
    try {
        const project = Projects.byName(name);
        return project && project.label ? project.label : name;
    } catch (_) {
        return name;
    }
}


function effectiveBag(project, pins, workingValues) {
    if (Projects.isFixture(project)) {
        return Object.assign({}, Projects.authored(project), workingValues || {});
    }
    return Object.assign({}, workingValues || {}, pins || {});
}


function variantValues(session) {
    return session.workingValues || {};
}


function effectiveValues(session) {
    return effectiveBag(session.project, session.pins, session.workingValues);
}


function loadVariantState(session, variant) {
    session.variant = variant;
    session.pins = Variants.inheritedPins(session.catalog.variants, variant);
    session.workingValues = Object.assign({}, variant.body, variant.values);
    session.workingParent = null;
    session.workingRanges = null;
    session.discovery = false;
    session.shapeSeed = variant.shapeSeed || variant.seed;
    session.ui.saveName = Variants.lineageName(session.catalog.variants, variant);
}


function searchPins(session) {
    if (session.variant) {
        return Variants.inheritedPins(session.catalog.variants, session.variant);
    }
    return Object.assign({}, session.pins);
}


function searchExtra(session) {
    return {
        project: session.project,
        parent: session.searchSession && session.searchSession.parentId
            || (session.variant && session.variant.id),
        pins: searchPins(session),
        body: searchPins(session),
        ranges: session.searchSession && session.searchSession.ranges,
    };
}


function paramValue(session, name) {
    const bag = effectiveValues(session);
    if (name in bag) return bag[name];
    return Projects.PRISTINE[Params.all()[name].module][name];
}


function syncContext(session) {
    const id = session.variant && session.variant.id;
    const overlayId = id && !isWorkingDirty(session) ? id : null;
    TdOverlay.setContext(session.project, session.seed, overlayId);
    Boot.syncAddressBar(session.project, session.seed, id);
}


function paint(session) {
    if (typeof session.redraw === 'function') session.redraw();
}


function forgetLayoutCache(session) {
    if (session.host && session.host.clearLayout) session.host.clearLayout();
    session.layoutBackfill = false;
}


function applyPins(session, rebuild) {
    session.lastResolved = Projects.resolve({name: session.project, values: effectiveValues(session)});
    paint(session);
    syncContext(session);
    if (rebuild) {
        forgetLayoutCache(session);
        session.host.generateMesh();
    }
}


function rerunShapeIfLive(session) {
    if (session.host && session.host.isShaped && session.host.isShaped()) {
        session.host.runShape(session.shapeSeed || session.seed);
    }
}


function setParam(session, name, value) {
    const shapeGene = Params.phase(name) === 'shape';
    /* Earth locks layout; Shape genes still move, because the fixture
     * exists so shaping can be tried on a known tectonic base. */
    if (Projects.isFixture(session.project) && !shapeGene) return;
    if (!Projects.isFixture(session.project) && name in session.pins) {
        session.pins[name] = value;
    } else {
        session.workingValues[name] = value;
    }
    session.projectModified = true;
    /* Shape genes do not touch plates. A live sketch re-runs in place,
     * the same way shuffling the shape seed does. */
    applyPins(session, !shapeGene);
    if (shapeGene) rerunShapeIfLive(session);
}


function toggleParamPin(session, name) {
    if (Projects.isFixture(session.project) || !Params.isBody(name)) return;
    if (name in session.pins) {
        session.workingValues[name] = session.pins[name];
        delete session.pins[name];
    } else {
        session.pins[name] = paramValue(session, name);
        delete session.workingValues[name];
    }
    session.projectModified = true;
    applyPins(session, true);
}


function markProjectModified(session) {
    if (session.projectModified) return;
    session.projectModified = true;
    paint(session);
}


function markShaped(session, id, value) {
    if (!id) return;
    const found = Variants.findById(readVariants(session), id);
    if (found) found.shaped = !!value;
    if (session.variant && session.variant.id === id) session.variant.shaped = !!value;
}


function renderParams(session) {
    paint(session);
}


function renderProjectState(session) {
    paint(session);
}


function renderPipeline(session) {
    paint(session);
}


async function refreshPipeline(session) {
    TdOverlay.setContext(session.project, session.seed, session.variant && session.variant.id);
    try {
        const q = new URLSearchParams({project: session.project, seed: String(session.seed)});
        if (session.variant) q.set('variant', session.variant.id);
        const res = await fetch(`${TdOverlay.TD_API}/pipeline?${q}`);
        if (res.ok) session.pipelineFact = await res.json();
    } catch {
        /* authored notes only */
    }
    renderPipeline(session);
}


async function persistShape(session, payload) {
    if (!payload) return;
    const variantId = session.variant && session.variant.id;
    const id = variantId || (Projects.isFixture(session.project) ? 'earth' : null);
    if (!id) return;
    payload.project = session.project;
    payload.variant = id;
    const res = await fetch(`${TdOverlay.TD_API}/shape`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || res.statusText);
    }
    if (variantId) {
        markShaped(session, variantId, true);
        await persistCatalog(session);
    }
}


function canPersistLayout(session) {
    return !!(session.variant && session.variant.id
        && !Projects.isFixture(session.project)
        && !isWorkingDirty(session));
}


async function persistLayout(session, payload) {
    if (!payload) return;
    const id = session.variant && session.variant.id;
    if (!id || Projects.isFixture(session.project)) return;
    payload.project = session.project;
    payload.variant = id;
    const res = await fetch(`${TdOverlay.TD_API}/layout`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || res.statusText);
    }
}


async function persistCurrentLayout(session) {
    if (!session.layoutBackfill) return;
    if (!canPersistLayout(session) || !session.host || !session.host.captureLayout) return;
    const payload = session.host.captureLayout();
    if (!payload) return;
    await persistLayout(session, payload);
    if (session.host.loadLayout) session.host.loadLayout(payload);
    session.layoutBackfill = false;
}


async function dropShape(session) {
    const id = session.variant && session.variant.id;
    if (!id || Projects.isFixture(session.project)) return;
    try {
        const q = new URLSearchParams({project: session.project, variant: id});
        await fetch(`${TdOverlay.TD_API}/shape?${q}`, {method: 'DELETE'});
    } catch {
        /* file may already be gone */
    }
    markShaped(session, id, false);
    await persistCatalog(session);
}


async function loadVariantLayout(session) {
    if (!session.host || !session.host.loadLayout) return false;
    if (Projects.isFixture(session.project)) return false;
    const id = session.variant && session.variant.id;
    if (!id) {
        if (session.host.clearLayout) session.host.clearLayout();
        session.layoutBackfill = false;
        return false;
    }
    try {
        const q = new URLSearchParams({project: session.project, variant: id});
        const res = await fetch(`${TdOverlay.TD_API}/layout?${q}`);
        if (res.status === 404) {
            if (session.host.clearLayout) session.host.clearLayout();
            session.layoutBackfill = true;
            return false;
        }
        if (!res.ok) {
            if (session.host.clearLayout) session.host.clearLayout();
            session.layoutBackfill = false;
            return false;
        }
        const payload = await res.json();
        if (!LayoutArtifact.usable(payload)) {
            if (session.host.clearLayout) session.host.clearLayout();
            session.layoutBackfill = false;
            return false;
        }
        session.layoutBackfill = false;
        session.host.loadLayout(payload);
        return true;
    } catch {
        if (session.host.clearLayout) session.host.clearLayout();
        session.layoutBackfill = true;
        return false;
    }
}


async function loadVariantShape(session) {
    if (!session.host || !session.host.loadShape) return;
    const variantId = session.variant && session.variant.id;
    const id = variantId || (Projects.isFixture(session.project) ? 'earth' : null);
    if (!id) {
        if (session.host.isShaped && session.host.isShaped() && session.host.showLayout) {
            session.host.showLayout();
        } else if (session.host.clearShape) {
            session.host.clearShape();
        }
        return;
    }
    try {
        const q = new URLSearchParams({project: session.project, variant: id});
        const res = await fetch(`${TdOverlay.TD_API}/shape?${q}`);
        if (!res.ok) {
            session.host.clearShape();
            if (session.host.isShaped && session.host.isShaped()) session.host.showLayout();
            return;
        }
        const payload = await res.json();
        if (!ShapeArtifact.usable(payload)) {
            session.host.clearShape();
            if (session.host.isShaped && session.host.isShaped()) session.host.showLayout();
            return;
        }
        session.host.loadShape(payload);
        if (variantId) {
            markShaped(session, variantId, true);
            persistCatalog(session);
        }
    } catch {
        session.host.clearShape();
        if (session.host.isShaped && session.host.isShaped()) session.host.showLayout();
    }
}


async function shapeVariant(session, opts) {
    if (session.pipelineShapeBusy) return;
    const regenerate = !!(opts && opts.regenerate);
    await ensureVariant(session);
    session.pipelineShapeBusy = true;
    renderPipeline(session);
    try {
        if (!regenerate && !Projects.isFixture(session.project) && session.variant) {
            const needsHead = !session.variant.shaped || isWorkingDirty(session);
            if (needsHead) await saveWorkingVariant(session, {force: true});
        }
        const payload = session.host.runShape(session.shapeSeed || session.seed);
        await persistShape(session, payload);
        ensureCurrentThumb(session);
        await refreshPipeline(session);
    } catch (err) {
        window.alert(`Shape failed: ${err.message || err}`);
    } finally {
        session.pipelineShapeBusy = false;
        renderPipeline(session);
    }
}


async function regenerateShape(session) {
    if (!session.host || !session.host.runShape) return;
    await shapeVariant(session, {regenerate: true});
}


async function regenerateLayout(session) {
    if (!session.host || !session.host.generateMesh) return;
    if (session.pipelineLayoutBusy) return;
    session.pipelineLayoutBusy = true;
    renderPipeline(session);
    try {
        forgetLayoutCache(session);
        if (session.host.clearShape) session.host.clearShape();
        session.host.generateMesh();
        if (canPersistLayout(session)) {
            const payload = session.host.captureLayout && session.host.captureLayout();
            if (payload) {
                await persistLayout(session, payload);
                if (session.host.loadLayout) session.host.loadLayout(payload);
            }
            await dropShape(session);
        }
    } catch (err) {
        window.alert(`Layout failed: ${err.message || err}`);
    } finally {
        session.pipelineLayoutBusy = false;
        renderPipeline(session);
    }
}


function syncProjectTitle(session) {
    if (!document.documentElement.classList.contains('is-picker')) {
        document.title = `${projectLabel(session.project)} — Procedural Planet Generation`;
    }
    paint(session);
}


function showWorkspace(session) {
    document.documentElement.classList.remove('is-picker');
    document.getElementById('workspace')?.removeAttribute('aria-hidden');
    syncProjectTitle(session);
}


function applyInitWorking(session, project, seed) {
    session.workingRanges = null;
    if (!project || project.fixture) return;
    if (project.body && Object.keys(project.body).length) return;
    if (!project.init) return;
    session.workingRanges = Init.rangesOf(project.init);
    const drawn = Init.draw(project, seed);
    for (const [name, value] of Object.entries(drawn)) {
        if (name in session.pins) continue;
        session.workingValues[name] = value;
    }
}


function showProjectPage(session) {
    if (session.searchSession) exitSearch(session);
    session.ui.variantsOpen = false;
    session.ui.pickerView = 'list';
    session.ui.createError = '';
    document.documentElement.classList.add('is-picker');
    document.getElementById('workspace')?.setAttribute('aria-hidden', 'true');
    document.title = 'Projects';
    paint(session);
}


function openProject(session, name) {
    const project = Projects.byName(name);
    Boot.writeStoredProject(project.name);
    showWorkspace(session);
    if (session.planetReady && project.name === session.project) {
        syncContext(session);
        return;
    }
    loadProject(session, project.name);
}


function resetSeedHistory(session, seed) {
    applySeed(session, seed);
    session.seedHistory = [session.seed];
    session.seedHistoryIndex = 0;
    syncSeedHistoryButtons(session);
}


async function loadProject(session, name) {
    if (session.searchSession) exitSearch(session);
    if (session.variant) Boot.writeStoredVariant(session.project, session.variant.id);
    const project = Projects.byName(name);
    const lastId = Boot.readStoredVariant(project.name);
    session.project = project.name;
    session.pins = Init.startingPins(project);
    session.workingValues = {};
    session.variant = null;
    session.workingParent = null;
    session.workingRanges = null;
    session.workingThumb = '';
    session.thumbPending = null;
    thumbFill += 1;
    session.compareId = null;
    session.discovery = false;
    session.ui.variantsOpen = false;
    session.ui.saveName = '';
    Undo.dismissUndo(session, {immediate: true});
    session.catalog = Variants.emptyCatalog(project.name);
    session.pendingVariantId = lastId;
    session.seedFromQuery = false;
    session.projectModified = false;
    Boot.writeStoredProject(session.project);
    syncProjectTitle(session);
    session.lastResolved = Projects.resolve({name: session.project, values: effectiveValues(session)});
    if (session.host && session.host.clearShape) session.host.clearShape();
    forgetLayoutCache(session);
    applyInitWorking(session, project, project.fixture && project.seed != null ? 1 : 1);
    applyPins(session, false);

    await hydrateCatalog(session);
    const resumed = resumeCatalog(session);
    if (resumed && session.catalog.variants.length) await persistCatalog(session);
    if (!resumed) {
        const seed = project.fixture && project.seed != null ? project.seed : 1;
        resetSeedHistory(session, seed);
        applyInitWorking(session, project, session.seed);
        applyPins(session, false);
    }
    if (resumed) await loadVariantLayout(session);
    if (resumed || Projects.isFixture(session.project)) await loadVariantShape(session);
    if (!(session.host && session.host.isShaped && session.host.isShaped())) {
        session.host.generateMesh();
    }
    if (resumed) await persistCurrentLayout(session);
    if (!resumed) {
        syncContext(session);
        syncVariantsUI(session);
        if (session.catalog.variants.length) await persistCatalog(session);
    }
    renderSearchChrome(session);
}


function applySeed(session, next) {
    if (EarthFixture.isEarthSeed(next)) {
        session.seed = EarthFixture.TOKEN;
    } else {
        session.seed = (next | 0);
        if (session.seed === 0) session.seed = 1;
    }
    if (!session.shapeSeed) session.shapeSeed = session.seed;
    paint(session);
}


function syncSeedHistoryButtons(session) {
    paint(session);
}


function commitSeed(session, next) {
    applySeed(session, next);
    if (session.seedHistory[session.seedHistoryIndex] === session.seed) {
        syncSeedHistoryButtons(session);
        syncContext(session);
        return;
    }
    session.seedHistory = session.seedHistory.slice(0, session.seedHistoryIndex + 1);
    session.seedHistory.push(session.seed);
    if (session.seedHistory.length > SEED_HISTORY_MAX) {
        session.seedHistory = session.seedHistory.slice(session.seedHistory.length - SEED_HISTORY_MAX);
    }
    session.seedHistoryIndex = session.seedHistory.length - 1;
    forgetLayoutCache(session);
    session.host.generateMesh();
    syncSeedHistoryButtons(session);
    syncContext(session);
}


function setSeed(session, next) {
    const parsed = parseSeed(next);
    if (parsed == null) {
        paint(session);
        return;
    }
    if (EarthFixture.isEarthSeed(parsed) && session.project !== 'earth') {
        paint(session);
        return;
    }
    if (session.variant) session.discovery = true;
    commitSeed(session, parsed);
}


function shuffleSeed(session) {
    let next;
    do { next = (Math.random() * 0x7fffffff) | 0; } while (next === session.seed);
    if (session.variant) session.discovery = true;
    session.shapeSeed = next;
    if (session.host && session.host.clearShape) session.host.clearShape();
    commitSeed(session, next);
}


function setShapeSeed(session, next) {
    const parsed = parseSeed(next);
    if (parsed == null || EarthFixture.isEarthSeed(parsed)) {
        paint(session);
        return;
    }
    session.shapeSeed = parsed;
    session.projectModified = true;
    paint(session);
    rerunShapeIfLive(session);
}


function shuffleShapeSeed(session) {
    let next;
    do { next = (Math.random() * 0x7fffffff) | 0; } while (next === (session.shapeSeed || session.seed));
    setShapeSeed(session, next);
}


function undoSeed(session) {
    if (session.seedHistoryIndex <= 0) return;
    session.seedHistoryIndex--;
    if (session.variant) session.discovery = true;
    applySeed(session, session.seedHistory[session.seedHistoryIndex]);
    if (session.host && session.host.clearShape) session.host.clearShape();
    forgetLayoutCache(session);
    session.host.generateMesh();
    syncSeedHistoryButtons(session);
    syncContext(session);
}


function redoSeed(session) {
    if (session.seedHistoryIndex >= session.seedHistory.length - 1) return;
    session.seedHistoryIndex++;
    if (session.variant) session.discovery = true;
    applySeed(session, session.seedHistory[session.seedHistoryIndex]);
    if (session.host && session.host.clearShape) session.host.clearShape();
    forgetLayoutCache(session);
    session.host.generateMesh();
    syncSeedHistoryButtons(session);
    syncContext(session);
}


function parseLegacySeeds() {
    try {
        const raw = localStorage.getItem(SAVED_SEEDS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}


function parseLegacyKeeps() {
    try {
        const raw = localStorage.getItem(SEARCH_KEEPS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}


function catalogCacheKey(project) {
    return `${VARIANTS_KEY}:${project}`;
}


function cacheCatalog(catalog) {
    try {
        localStorage.setItem(catalogCacheKey(catalog.project), JSON.stringify(Variants.serializeCatalog(catalog)));
    } catch (_) { /* private mode / quota */ }
}


function cachedCatalog(project) {
    try {
        const raw = localStorage.getItem(catalogCacheKey(project));
        if (raw) return Projects.parseCatalog(JSON.parse(raw), project);
    } catch (_) { /* ignore */ }
    return null;
}


function keepThumbs(previous, next) {
    if (!previous || !previous.length) return next;
    let changed = false;
    const variants = next.variants.map((item) => {
        if (item.thumb) return item;
        const old = Variants.findById(previous, item.id);
        if (!old || !old.thumb) return item;
        changed = true;
        return Object.assign({}, item, {thumb: old.thumb});
    });
    return changed ? Object.assign({}, next, {variants}) : next;
}


async function persistCatalog(session, opts) {
    const previous = session.catalog.variants;
    const catalog = Projects.parseCatalog(session.catalog, session.project);
    session.catalog = keepThumbs(previous, catalog);
    cacheCatalog(catalog);
    const body = Variants.serializeCatalog(catalog);
    const drop = opts && opts.drop;
    if (drop && drop.length) body.drop = drop;
    try {
        const res = await fetch(`${TdOverlay.TD_API}/variants`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
        });
        if (res.ok) {
            session.catalog = keepThumbs(previous, Variants.mergeCatalogs(
                Projects.parseCatalog(await res.json(), session.project),
                session.catalog,
            ));
            cacheCatalog(session.catalog);
        }
    } catch (_) { /* local cache still has it */ }
}


async function persistThumb(session, id, dataUrl) {
    if (!id || !dataUrl || !dataUrl.startsWith('data:')) return;
    try {
        const res = await fetch(`${TdOverlay.TD_API}/variants/thumb`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({project: session.project, id, data: dataUrl}),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!data.thumb) return;
        const found = Variants.findById(session.catalog.variants, id);
        if (found) found.thumb = data.thumb;
        if (session.variant && session.variant.id === id) session.variant.thumb = data.thumb;
        syncVariantsUI(session);
    } catch (_) { /* optional */ }
}


async function hydrateCatalog(session) {
    const cached = cachedCatalog(session.project);
    let disk = Variants.emptyCatalog(session.project);
    try {
        const res = await fetch(`${TdOverlay.TD_API}/variants?project=${encodeURIComponent(session.project)}`);
        if (res.ok) {
            disk = Projects.parseCatalog(await res.json(), session.project);
        }
    } catch (_) { /* cache / migrate */ }
    let catalog = Variants.mergeCatalogs(disk, cached);
    if (!catalog.variants.length && !Projects.isFixture(session.project)) {
        const migrated = Variants.migrate(
            parseLegacyKeeps(),
            parseLegacySeeds(),
            session.project,
            Projects.byName(session.project).body,
        );
        if (migrated.length) catalog = Variants.mergeCatalogs({
            project: session.project,
            committed: catalog.committed,
            variants: migrated,
        }, catalog);
    }
    session.catalog = catalog;
    cacheCatalog(catalog);
}


function recoverCheckout(session, id) {
    const found = Variants.findById(session.catalog.variants, id);
    if (found) return Variants.isLive(found) ? found : null;
    if (EarthFixture.isEarthSeed(session.seed) || !(session.seed >= 1)) return null;
    const incoming = workingVariant(session, {id});
    if (!incoming) return null;
    incoming.id = id;
    session.catalog = {
        project: session.project,
        committed: session.catalog.committed,
        variants: Variants.remember(session.catalog.variants, incoming),
    };
    return Variants.findById(session.catalog.variants, id);
}


function resumeCatalog(session) {
    const wanted = Variants.wantedId({
        pendingId: session.pendingVariantId,
        lastId: Boot.readStoredVariant(session.project),
        variants: session.catalog.variants,
        seedFromQuery: session.seedFromQuery,
        querySeed: session.seed,
        fixture: Projects.isFixture(session.project),
    });
    session.pendingVariantId = null;
    session.seedFromQuery = false;
    let id = wanted;
    if (!id && !Projects.isFixture(session.project) && session.seed >= 1
        && session.catalog.variants.length
        && !Variants.live(session.catalog.variants).some((item) => (item.seed | 0) === (session.seed | 0))) {
        id = Variants.newId();
    }
    if (!id) {
        syncVariantsUI(session);
        renderProjectState(session);
        syncContext(session);
        return false;
    }
    const found = Variants.findById(session.catalog.variants, id)
        || recoverCheckout(session, id);
    if (!found || !Variants.isLive(found)) {
        syncVariantsUI(session);
        renderProjectState(session);
        syncContext(session);
        return false;
    }
    loadVariantState(session, found);
    resetSeedHistory(session, found.seed);
    applyPins(session, false);
    Boot.writeStoredVariant(session.project, found.id);
    syncContext(session);
    syncVariantsUI(session);
    return true;
}


async function hydrateUserProjects() {
    try {
        const res = await fetch(`${TdOverlay.TD_API}/projects`);
        if (!res.ok) return;
        const data = await res.json();
        for (const item of data.projects || []) {
            try { Projects.register(item); } catch (_) { /* skip junk */ }
        }
    } catch (_) { /* bake server down */ }
}


async function hydrateAndResume(session) {
    await hydrateUserProjects();
    const start = Boot.resolveStartup();
    if (start.skipPicker) showWorkspace(session);
    if (start.project !== session.project && Boot.knownProject(start.project)) {
        await loadProject(session, start.project);
        return;
    }
    await hydrateCatalog(session);
    const resumed = resumeCatalog(session);
    if (session.catalog.variants.length) await persistCatalog(session);
    for (const item of session.catalog.variants) {
        if (item.thumb && item.thumb.startsWith('data:')) {
            await persistThumb(session, item.id, item.thumb);
        }
    }
    if (resumed) await loadVariantLayout(session);
    if (resumed || Projects.isFixture(session.project)) await loadVariantShape(session);
    if (resumed && session.host && session.host.isShaped && session.host.isShaped()) {
        await persistCurrentLayout(session);
    }
}


function beginCreateProject(session) {
    session.ui.pickerView = 'create';
    session.ui.createError = '';
    session.ui.createDraft = Object.assign({name: ''}, Init.DEFAULTS);
    paint(session);
}


function setCreateDraft(session, patch) {
    session.ui.createDraft = Object.assign({}, session.ui.createDraft, patch);
    session.ui.createError = '';
    paint(session);
}


function cancelCreateProject(session) {
    session.ui.pickerView = 'list';
    session.ui.createError = '';
    paint(session);
}


async function createProject(session) {
    if (session.ui.createBusy) return;
    const draft = session.ui.createDraft || {};
    let record;
    try {
        record = Init.buildRecord({
            label: draft.name,
            init: {
                size: draft.size,
                age: draft.age,
                day: draft.day,
                water: draft.water,
            },
        });
    } catch (err) {
        session.ui.createError = (err.problems && err.problems[0]) || String(err.message || err);
        paint(session);
        return;
    }
    session.ui.createBusy = true;
    session.ui.createError = '';
    paint(session);
    try {
        const res = await fetch(`${TdOverlay.TD_API}/projects`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({label: record.label, init: record.init}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            session.ui.createError = data.error || 'Could not create that project.';
            return;
        }
        Projects.register(data.project);
        session.ui.pickerView = 'list';
        session.ui.createDraft = Object.assign({name: ''}, Init.DEFAULTS);
        openProject(session, data.project.name);
    } catch (err) {
        session.ui.createError = 'Could not create that project.';
    } finally {
        session.ui.createBusy = false;
        paint(session);
    }
}


function setCatalogVariants(session, items, opts) {
    const committed = items.some((item) => item.id === session.catalog.committed)
        ? session.catalog.committed
        : null;
    session.catalog = {
        project: session.project,
        committed,
        variants: items,
    };
    return persistCatalog(session, opts);
}


function readVariants(session) {
    return session.catalog.variants || [];
}


function variantThumbOf(canvas) {
    if (!canvas || typeof canvas.toDataURL !== 'function') return '';
    try {
        const width = 480;
        const height = 240;
        const off = document.createElement('canvas');
        off.width = width;
        off.height = height;
        const ctx = off.getContext('2d');
        if (!ctx) return canvas.toDataURL('image/jpeg', 0.72);
        const sw = canvas.width;
        const sh = canvas.height;
        if (!(sw > 0 && sh > 0)) return '';
        const ratio = sw / sh;
        /* A square globe canvas cropped to 2:1 is an equatorial strip.
           Letterbox that. A wide map view is cropped to the fitted 2:1. */
        if (ratio < 1.25) {
            ctx.fillStyle = '#111';
            ctx.fillRect(0, 0, width, height);
            const dh = height;
            const dw = dh * ratio;
            ctx.drawImage(canvas, 0, 0, sw, sh, (width - dw) / 2, 0, dw, dh);
        } else {
            let sx = 0, sy = 0, cw = sw, ch = sh;
            if (ratio > 2) {
                cw = sh * 2;
                sx = (sw - cw) / 2;
            } else if (ratio < 2) {
                ch = sw / 2;
                sy = (sh - ch) / 2;
            }
            ctx.drawImage(canvas, sx, sy, cw, ch, 0, 0, width, height);
        }
        return off.toDataURL('image/jpeg', 0.72);
    } catch (_) {
        return '';
    }
}


function surfaceThumbJpeg(canvas) {
    if (!canvas || typeof canvas.toDataURL !== 'function') return '';
    try {
        return canvas.toDataURL('image/jpeg', 0.86);
    } catch (_) {
        return '';
    }
}


function captureWorkingThumb(session) {
    if (session.host && typeof session.host.renderWorkingThumb === 'function') {
        const painted = surfaceThumbJpeg(session.host.renderWorkingThumb());
        if (painted) {
            session.workingThumb = painted;
            return painted;
        }
    }
    if (session.host && typeof session.host.drawNow === 'function') {
        session.host.drawNow();
    }
    const thumb = variantThumbOf(document.getElementById('output'));
    if (thumb) session.workingThumb = thumb;
    return session.workingThumb || '';
}


function applyCatalogThumb(session, id, thumb) {
    if (!id || !thumb) return null;
    const prev = readVariants(session);
    const next = Variants.putThumb(prev, id, thumb, true);
    if (next === prev) return Variants.findById(prev, id);
    session.catalog = Object.assign({}, session.catalog, {variants: next});
    const found = Variants.findById(next, id);
    if (found && session.variant && session.variant.id === id) session.variant = found;
    return found;
}


function ensureCurrentThumb(session) {
    const thumb = captureWorkingThumb(session);
    if (!session.planetReady || Projects.isFixture(session.project)) return thumb;
    const current = session.variant;
    if (!thumb || !current || isWorkingDirty(session)) return thumb;
    applyCatalogThumb(session, current.id, thumb);
    persistThumb(session, current.id, thumb);
    return thumb;
}


function thumbNaturalWidth(thumb) {
    if (!thumb) return Promise.resolve(0);
    const src = TdOverlay.previewUrl(thumb);
    if (!src) return Promise.resolve(0);
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth || 0);
        img.onerror = () => resolve(0);
        img.src = src;
    });
}


async function fillMissingThumbs(session) {
    if (Projects.isFixture(session.project)) return;
    const run = ++thumbFill;
    ensureCurrentThumb(session);
    if (!session.host || typeof session.host.renderVariantThumb !== 'function') {
        syncVariantsUI(session);
        return;
    }
    for (const item of readVariants(session)) {
        if (run !== thumbFill) return;
        const current = session.variant && item.id === session.variant.id && !isWorkingDirty(session);
        if (item.deleted) continue;
        const lowRes = item.thumb && (await thumbNaturalWidth(item.thumb)) < 800;
        if (item.thumb && !lowRes && !current) continue;
        if (current) {
            ensureCurrentThumb(session);
            continue;
        }
        if (!session.thumbPending) session.thumbPending = new Set();
        session.thumbPending.add(item.id);
        syncVariantsUI(session);
        const canvas = session.host.renderVariantThumb(item);
        const thumb = surfaceThumbJpeg(canvas) || variantThumbOf(canvas);
        session.thumbPending.delete(item.id);
        if (run !== thumbFill) return;
        if (thumb) {
            applyCatalogThumb(session, item.id, thumb);
            persistThumb(session, item.id, thumb);
        }
        syncVariantsUI(session);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}


function variantLabel(list, variant) {
    return Variants.lineageName(list || [], variant);
}


function isWorkingDirty(session) {
    return Variants.dirty(workingVariant(session), session.variant);
}


function workingVariant(session, extra) {
    extra = extra || {};
    return Variants.ofWorking({
        project: session.project,
        seed: session.seed,
        shapeSeed: session.shapeSeed,
        pins: session.pins,
        body: session.pins,
        values: variantValues(session),
        ranges: extra.ranges || (session.searchSession && session.searchSession.ranges)
            || (session.variant && session.variant.ranges)
            || session.workingRanges,
        name: extra.name,
        thumb: extra.thumb,
        id: extra.id,
    });
}


function selectedVariant(session, items) {
    return session.variant ? Variants.findById(items, session.variant.id) : null;
}


function typedVariantName(session) {
    return ((session && session.ui && session.ui.saveName) || '').trim().slice(0, Variants.NAME_MAX);
}


function activeVariantName(session) {
    if (!session || !session.variant) return '';
    return Variants.lineageName(readVariants(session), session.variant);
}


function isRenamed(session) {
    const typed = typedVariantName(session);
    const current = activeVariantName(session);
    return !!(typed && typed !== current);
}


function differentPlanetInput(session, name) {
    return {
        name: name != null ? name : typedVariantName(session),
        seed: session.seed,
        discover: !!session.discovery,
    };
}


function isDifferentPlanet(session) {
    return Variants.differentPlanet(session.variant, differentPlanetInput(session));
}


function saveHint(session, items) {
    const name = typedVariantName(session);
    const dirty = isWorkingDirty(session);
    const head = selectedVariant(session, items);
    const label = variantLabel(items, head);
    const renamed = isRenamed(session);
    if (!head) {
        return name ? `Save starts ${name}.` : 'Save writes the first variant.';
    }
    if (renamed) return `Save starts ${name}. ${label} stays.`;
    if (dirty) return `Save continues ${label}.`;
    return '';
}


function syncVariantsUI(session) {
    paint(session);
}

function syncModeButtons(session) {
    const drawMode = session.host.getDrawMode();
    for (const b of document.querySelectorAll('[data-action="draw"]')) {
        b.setAttribute('aria-pressed', String(b.dataset.draw === drawMode));
    }
    /* Tiles read the sketch. Hide the look-bar toggle on Layout. */
    const tiles = document.getElementById('td-crops-toggle');
    const label = tiles && tiles.closest('label');
    if (label) {
        const live = !!(session.host.isShaped && session.host.isShaped());
        label.hidden = !live;
    }
}


function renderSearchChrome(session) {
    paint(session);
}


function mountSearchTiles(session) {
    paint(session);
}



async function fillSearchSheet(session) {
    const current = session.searchSession;
    if (!current) return;
    const run = ++session.searchRun;
    current.busy = true;
    current.canvases = current.canvases || [];
    paint(session);
    for (let i = 0; i < current.population.length; i++) {
        if (run !== session.searchRun || session.searchSession !== current) return;
        if (!current.canvases[i]) {
            current.canvases[i] = session.host.renderSearchTile(current.population[i]);
        }
        stampVariantThumb(session, i);
        paint(session);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (run !== session.searchRun || session.searchSession !== current) return;
    current.busy = false;
    paint(session);
}


function writeHeadRanges(session, ranges) {
    if (!session.variant) {
        session.workingRanges = ranges;
        return;
    }
    const items = readVariants(session);
    const next = Variants.setRanges(items, session.variant.id, ranges);
    if (next === items) return;
    setCatalogVariants(session, next);
    const found = Variants.findById(next, session.variant.id);
    if (found) session.variant = found;
}


function syncExploreRanges(session) {
    const s = session.searchSession;
    if (!s) return;
    const baseline = s.baseRanges || s.ranges;
    const next = Search.rangesFromLikes({
        genes: s.genes,
        vouched: s.vouched,
        population: s.population,
        liked: [...s.liked],
        ranges: baseline,
    });
    s.ranges = next;
    writeHeadRanges(session, next);
    renderSearchChrome(session);
    syncVariantsUI(session);
}


function toggleSearchLike(session, i) {
    if (!session.searchSession) return;
    if (session.searchSession.liked.has(i)) session.searchSession.liked.delete(i);
    else session.searchSession.liked.add(i);
    syncExploreRanges(session);
}


function stampVariantThumb(session, i) {
    const s = session.searchSession;
    if (!s) return;
    const ind = s.population[i];
    const thumb = variantThumbOf(s.canvases[i]);
    if (!ind || !thumb) return;
    const extra = searchExtra(session);
    const prev = readVariants(session);
    const next = Variants.stampThumb(prev, Variants.ofIndividual(ind, extra), thumb);
    if (next === prev) return;
    setCatalogVariants(session, next);
    const saved = Variants.findByRecipe(next, Variants.ofIndividual(ind, extra));
    if (saved) persistThumb(session, saved.id, thumb);
    syncVariantsUI(session);
}


function syncSearchVariantTile(session) {
    paint(session);
}


function openSearchTile(session, i) {
    const s = session.searchSession;
    if (!s) return;
    const ind = s.population[i];
    if (!ind) return;
    const extra = searchExtra(session);
    const incoming = Variants.ofIndividual(ind, extra);
    if (!incoming) return;
    const pins = searchPins(session);
    const ranges = s.ranges;
    exitSearch(session);
    session.pins = pins;
    session.workingValues = Object.assign({}, incoming.body, incoming.values);
    session.workingRanges = ranges;
    session.projectModified = true;
    if (session.variant) session.discovery = true;
    applyPins(session, false);
    if (session.seed === incoming.seed) {
        session.host.generateMesh();
        syncContext(session);
        syncVariantsUI(session);
        return;
    }
    commitSeed(session, incoming.seed);
    syncVariantsUI(session);
}


async function toggleSearchVariant(session, i) {
    const s = session.searchSession;
    if (!s) return;
    const ind = s.population[i];
    if (!ind) return;
    const extra = searchExtra(session);
    const thumb = variantThumbOf(s.canvases[i]);
    if (thumb) extra.thumb = thumb;
    extra.ranges = s.ranges;
    const incoming = Variants.ofIndividual(ind, extra);
    if (!incoming) return;
    const head = session.variant;
    if (head && Variants.sameRecipe(head, incoming)) {
        syncSearchVariantTile(session, i, true);
        return;
    }
    const already = Variants.findByRecipe(readVariants(session), incoming);
    if (already) {
        syncSearchVariantTile(session, i, true);
        return;
    }
    extra.parent = head ? head.id : extra.parent;
    extra.ranges = s.ranges;
    const child = Variants.ofIndividual(ind, extra);
    if (thumb) child.thumb = thumb;
    const next = Variants.save(readVariants(session), head, child);
    const saved = Variants.findById(next, child.id) || next[0];
    session.catalog = {
        project: session.project,
        committed: session.catalog.committed,
        variants: next,
    };
    await persistCatalog(session);
    session.variant = saved;
    session.discovery = false;
    if (saved && thumb) persistThumb(session, saved.id, thumb);
    Boot.writeStoredVariant(session.project, saved && saved.id);
    session.workingValues = Object.assign({}, incoming.body, incoming.values);
    session.workingRanges = s.ranges;
    session.ui.saveName = saved && saved.name ? saved.name : session.ui.saveName;
    session.projectModified = false;
    if (session.seed !== incoming.seed) applySeed(session, incoming.seed);
    const extras = searchExtra(session);
    s.population.forEach((tile, index) => {
        syncSearchVariantTile(session, index, Variants.hasRecipe(readVariants(session), tile, extras));
    });
    renderSearchChrome(session);
    syncVariantsUI(session);
    syncContext(session);
}


async function applySavedVariant(session, saved) {
    session.variant = saved;
    session.workingParent = null;
    session.workingRanges = saved.ranges || null;
    session.projectModified = false;
    session.compareId = null;
    session.discovery = false;
    session.shapeSeed = saved.shapeSeed || saved.seed;
    session.ui.saveName = saved.name || Variants.lineageName(session.catalog.variants, saved);
    Boot.writeStoredVariant(session.project, saved.id);
    if (saved.thumb) persistThumb(session, saved.id, saved.thumb);
    /* A child starts unshaped. Drop a parent's sketch if it is still on
     * the globe; do not copy the file onto the new id. The tab follows
     * the globe, so this returns Discover to Layout. */
    if (session.host && session.host.clearShape) {
        const shaped = session.host.isShaped && session.host.isShaped();
        session.host.clearShape();
        if (shaped && session.host.showLayout) session.host.showLayout();
        else if (shaped) session.host.generateMesh();
    }
    syncContext(session);
    paint(session);
    return saved;
}


async function saveWorkingVariant(session, opts) {
    if (Projects.isFixture(session.project)) return session.variant;
    const name = typedVariantName(session);
    const head = session.variant;
    const newPlanet = isDifferentPlanet(session);
    const force = !!(opts && opts.force);
    if (!force && !newPlanet && !isWorkingDirty(session) && !isRenamed(session) && head) return head;
    const thumb = captureWorkingThumb(session);
    const layout = session.host && session.host.captureLayout && session.host.captureLayout();
    const incoming = workingVariant(session, {name, thumb});
    if (!incoming) return session.variant;
    const next = Variants.save(readVariants(session), head, incoming);
    const saved = next[0];
    session.catalog = {
        project: session.project,
        committed: session.catalog.committed,
        variants: next,
    };
    await persistCatalog(session);
    if (layout && session.host.loadLayout) session.host.loadLayout(layout);
    await applySavedVariant(session, saved);
    if (layout) await persistLayout(session, layout);
    return saved;
}


async function openVariant(session, id, opts) {
    const variant = Variants.findById(readVariants(session), id);
    if (!variant || variant.deleted) return;
    if (session.searchSession) exitSearch(session);
    loadVariantState(session, variant);
    session.compareId = null;
    if (!opts || !opts.keepOpen) session.ui.variantsOpen = false;
    session.projectModified = false;
    Boot.writeStoredVariant(session.project, variant.id);
    applySeed(session, variant.seed);
    session.seedHistory = [session.seed];
    session.seedHistoryIndex = 0;
    session.lastResolved = Projects.resolve({name: session.project, values: effectiveValues(session)});
    await loadVariantLayout(session);
    if (session.host && session.host.showLayout) session.host.showLayout();
    applyPins(session, false);
    await loadVariantShape(session);
    persistCurrentLayout(session);
    syncContext(session);
    syncVariantsUI(session);
}


async function ensureVariant(session) {
    if (Projects.isFixture(session.project)) return null;
    if (session.variant) return session.variant;
    return saveWorkingVariant(session);
}


function restoreDeletedVariants(session, snapshot) {
    const next = Variants.markDeleted(readVariants(session), snapshot.ids, false);
    setCatalogVariants(session, next);
    if (snapshot.compareId && !session.compareId) session.compareId = snapshot.compareId;
    if (snapshot.workingParent && !session.workingParent) {
        session.workingParent = snapshot.workingParent;
    }
    const restoreCheckout = snapshot.restoreCheckout
        && !session.variant
        && (snapshot.seed == null || (session.seed | 0) === (snapshot.seed | 0));
    if (restoreCheckout) {
        openVariant(session, snapshot.checkoutId, {keepOpen: !!session.ui.variantsOpen});
        return;
    }
    if (session.searchSession) {
        const extra = searchExtra(session);
        session.searchSession.population.forEach((ind, i) => {
            syncSearchVariantTile(session, i, Variants.hasRecipe(next, ind, extra));
        });
    }
    renderSearchChrome(session);
    syncVariantsUI(session);
}


function deleteVariant(session, id) {
    const list = readVariants(session);
    const tip = Variants.findById(list, id);
    if (!tip || tip.deleted) return;
    const doomed = Variants.lineageUnique(list, tip);
    const doomedIds = doomed.map((item) => item.id);
    const idSet = new Set(doomedIds);
    const next = Variants.markDeleted(list, doomedIds, true);
    const snapshot = {
        ids: doomedIds,
        checkoutId: session.variant && session.variant.id,
        restoreCheckout: !!(session.variant && idSet.has(session.variant.id)),
        seed: session.variant && session.variant.seed,
        compareId: session.compareId,
        workingParent: session.workingParent,
    };
    if (idSet.has(session.compareId)) session.compareId = null;
    if (idSet.has(session.workingParent)) session.workingParent = null;
    setCatalogVariants(session, next);
    if (session.variant && idSet.has(session.variant.id)) {
        session.variant = null;
        session.ui.saveName = '';
        Boot.writeStoredVariant(session.project, null);
        applyPins(session, true);
        syncContext(session);
    } else if (idSet.has(Boot.readStoredVariant(session.project))) {
        Boot.writeStoredVariant(session.project, session.variant && session.variant.id);
    }
    if (session.searchSession) {
        const extra = searchExtra(session);
        session.searchSession.population.forEach((ind, i) => {
            syncSearchVariantTile(session, i, Variants.hasRecipe(next, ind, extra));
        });
    }
    renderSearchChrome(session);
    syncVariantsUI(session);
    const label = Variants.lineageName(list, tip);
    Undo.offerUndo(session, {
        message: `${label} deleted`,
        run: () => restoreDeletedVariants(session, snapshot),
    });
}


function exitSearch(session) {
    session.searchRun++;
    session.searchSession = null;
    document.body.classList.remove('search-mode');
    paint(session);
}


function enterSearch(session) {
    if (session.searchSession || Projects.isFixture(session.project)) return;
    const pins = searchPins(session);
    const genes = Search.genesFor(pins);
    if (!genes.length) return;
    const gen = Search.initialPopulation({
        values: pins,
        ranges: (session.variant && session.variant.ranges) || session.workingRanges,
        rng: Date.now(),
    });
    session.searchSession = {
        parentId: session.variant && session.variant.id,
        genes: gen.genes,
        ranges: gen.ranges,
        baseRanges: gen.ranges,
        vouched: gen.vouched,
        population: gen.population,
        liked: new Set(),
        history: [],
        generation: 0,
        canvases: [],
        busy: false,
    };
    document.body.classList.add('search-mode');
    renderSearchChrome(session);
    fillSearchSheet(session);
}


function nextSearch(session) {
    const s = session.searchSession;
    if (!s || s.busy) return;
    s.history.push({
        ranges: s.ranges,
        baseRanges: s.baseRanges,
        population: s.population,
        liked: new Set(s.liked),
        generation: s.generation,
        canvases: s.canvases,
    });
    const next = Search.nextGeneration({
        genes: s.genes,
        ranges: s.ranges,
        vouched: s.vouched,
        population: s.population,
        liked: [...s.liked],
        rng: Date.now() + s.generation + 1,
    });
    s.ranges = next.ranges;
    s.baseRanges = next.ranges;
    s.population = next.population;
    s.liked = new Set();
    s.generation += 1;
    s.canvases = [];
    writeHeadRanges(session, next.ranges);
    fillSearchSheet(session);
}


function backSearch(session) {
    const s = session.searchSession;
    if (!s || s.busy || !s.history.length) return;
    session.searchRun++;
    const prev = s.history.pop();
    s.ranges = prev.ranges;
    s.baseRanges = prev.baseRanges || prev.ranges;
    s.population = prev.population;
    s.liked = prev.liked;
    s.generation = prev.generation;
    s.canvases = prev.canvases || [];
    s.busy = false;
    syncExploreRanges(session);
    mountSearchTiles(session);
    renderSearchChrome(session);
}


function doneSearch(session) {
    const s = session.searchSession;
    if (!s || s.busy) return;
    syncExploreRanges(session);
    exitSearch(session);
}


function populate(session) {
    syncProjectTitle(session);
    applyPins(session, false);
    syncModeButtons(session);
    paint(session);
}


function goLayout(session) {
    if (session.host && session.host.showLayout) session.host.showLayout();
    paint(session);
}


async function goShape(session) {
    const dirty = isWorkingDirty(session);
    const shaped = session.variant && session.variant.shaped;
    if (!dirty && shaped) {
        if (session.pipelineShapeBusy) return;
        session.pipelineShapeBusy = true;
        paint(session);
        try {
            await loadVariantShape(session);
        } finally {
            session.pipelineShapeBusy = false;
            paint(session);
        }
        return;
    }
    await shapeVariant(session);
}


function openVariantsModal(session) {
    if (Projects.isFixture(session.project)) return;
    session.ui.variantsOpen = true;
    ensureCurrentThumb(session);
    fillMissingThumbs(session);
    paint(session);
}


function uiSnapshot(session) {
    const items = readVariants(session);
    return {
        projectLabel: projectLabel(session.project),
        workingSnapshot: workingVariant(session),
        differentPlanet: isDifferentPlanet(session),
        saveHint: saveHint(session, items),
        searchExtra: searchExtra(session),
    };
}


function closestAction(event) {
    const el = event.target && event.target.closest && event.target.closest('[data-action]');
    return el || null;
}


function bind(session) {
    const root = document;
    root.addEventListener('click', event => {
        const el = closestAction(event);
        if (!el) return;
        const action = el.dataset.action;
        if (action === 'view') {
            session.host.setViewMode(el.dataset.view);
            syncModeButtons(session);
        } else if (action === 'draw') {
            session.host.setDrawMode(el.dataset.draw);
            syncModeButtons(session);
            paint(session);
        } else if (action === 'view-toggle') {
            const next = session.host.getViewMode() === 'globe' ? 'equirect' : 'globe';
            session.host.setViewMode(next);
            syncModeButtons(session);
        } else if (action === 'toggle-sidebar') {
            session.sidebar && session.sidebar.toggle({focusToggle: true});
        }
    });

    root.addEventListener('input', event => {
        const el = closestAction(event);
        if (!el) return;
        const action = el.dataset.action;
        if (action === 'plate-vectors') session.host.setDrawPlateVectors(el.checked);
        else if (action === 'plate-boundaries') session.host.setDrawPlateBoundaries(el.checked);
        else if (action === 'td-crops') {
            if (session.host.isShaped && session.host.isShaped()) session.host.setTdCrops(el.checked);
            else el.checked = false;
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            if (session.ui.variantsOpen) {
                event.preventDefault();
                session.ui.variantsOpen = false;
                paint(session);
                return;
            }
            if (document.documentElement.classList.contains('is-picker')) {
                if (session.ui.pickerView === 'create') {
                    event.preventDefault();
                    session.ui.pickerView = 'list';
                    session.ui.createError = '';
                    paint(session);
                    return;
                }
                if (session.planetReady) {
                    event.preventDefault();
                    showWorkspace(session);
                }
            }
            return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            if (Projects.isFixture(session.project)) return;
            if (document.documentElement.classList.contains('is-picker')) return;
            event.preventDefault();
            saveWorkingVariant(session);
            return;
        }
        if (!(event.metaKey || event.ctrlKey)) return;
        if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
        const key = event.key.toLowerCase();
        if (key === 'z') {
            event.preventDefault();
            if (event.shiftKey) redoSeed(session);
            else if (Undo.hasUndo(session)) Undo.runUndo(session);
            else undoSeed(session);
        } else if (key === 'y' && !event.shiftKey) {
            event.preventDefault();
            redoSeed(session);
        }
    });
}


function mount(session, host) {
    mountHudIcons();
    session.sidebar = Sidebar.mount();
    session.host = host;
    session.refreshPipeline = () => refreshPipeline(session);
    session.exitSearch = () => exitSearch(session);
    session.setParam = (name, value) => setParam(session, name, value);
    session.syncModeButtons = () => syncModeButtons(session);
    session.markProjectModified = () => markProjectModified(session);
    session.setPlanetReady = (value) => {
        session.planetReady = !!value;
        if (!value) return;
        persistCurrentLayout(session);
        ensureCurrentThumb(session);
        if (session.ui.variantsOpen) fillMissingThumbs(session);
        paint(session);
    };
    Ui.mount(session, () => uiSnapshot(session), {
        backToProjects: () => showProjectPage(session),
        openProject: (name) => openProject(session, name),
        beginCreateProject: () => beginCreateProject(session),
        cancelCreateProject: () => cancelCreateProject(session),
        setCreateDraft: (patch) => setCreateDraft(session, patch),
        createProject: () => createProject(session),
        save: () => saveWorkingVariant(session),
        setSaveName: (value) => {
            session.ui.saveName = value.slice(0, Variants.NAME_MAX);
            paint(session);
        },
        openVariants: () => openVariantsModal(session),
        closeVariants: () => {
            session.ui.variantsOpen = false;
            paint(session);
        },
        openVariant: (id, opts) => openVariant(session, id, opts),
        deleteVariant: (id) => deleteVariant(session, id),
        runUndo: () => Undo.runUndo(session),
        goLayout: () => goLayout(session),
        goShape: () => goShape(session),
        regenerateShape: () => regenerateShape(session),
        regenerateLayout: () => regenerateLayout(session),
        enterSearch: () => enterSearch(session),
        searchNext: () => nextSearch(session),
        searchBack: () => backSearch(session),
        searchDone: () => doneSearch(session),
        toggleLike: (i) => toggleSearchLike(session, i),
        openSearchTile: (i) => openSearchTile(session, i),
        toggleSearchVariant: (i) => toggleSearchVariant(session, i),
        shuffleSeed: () => shuffleSeed(session),
        undoSeed: () => undoSeed(session),
        redoSeed: () => redoSeed(session),
        setSeed: (value) => setSeed(session, value),
        shuffleShapeSeed: () => shuffleShapeSeed(session),
        setShapeSeed: (value) => setShapeSeed(session, value),
        togglePin: (name) => toggleParamPin(session, name),
        setParam: (name, value) => setParam(session, name, value),
        syncLook: () => syncModeButtons(session),
    });
    bind(session);
    session.generateValues = () => effectiveValues(session);
    session.ensureVariant = () => ensureVariant(session);
    applySeed(session, session.seed);
    populate(session);
    session.ready = hydrateAndResume(session);
}

module.exports = Object.assign({
    createSession,
    mount,
    showWorkspace,
    showProjectPage,
    parseSeed,
    projectLabel,
}, Boot);
