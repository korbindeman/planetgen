/*
 * The studio: picker, sidebar, body pins, variant tree, search chrome.
 *
 * Mounted against the renderer's generate/draw operations. The renderer
 * keeps WebGL, mesh generation, and process flags that are not parameters.
 */
'use strict';

const Projects = require('../projects');
const Params = require('../params');
const Search = require('../search');
const EarthFixture = require('../earth-fixture');
const TdOverlay = require('../td-overlay');
const Boot = require('./boot');
const { mountHudIcons } = require('./icons.js');

const SEED_HISTORY_MAX = 50;
const VARIANTS_KEY = 'planetgen.variants';
const SAVED_SEEDS_KEY = 'planetgen.savedSeeds';
const SEARCH_KEEPS_KEY = 'planetgen.searchKeeps';
const Variants = Projects.Variants;

const MODULE_ORDER = ['world', 'tectonics', 'climate', 'detail'];
const GROUP_LABEL = {
    body: 'Body',
    history: 'History',
    continents: 'Continents',
    volcanism: 'Volcanism',
    polar: 'Poles',
    mesh: 'Detail mesh',
};


function createSession(startup) {
    const project = startup.project;
    const pins = Object.assign({}, Projects.byName(project).body || {});
    const seed = startup.seed != null ? startup.seed : 1;
    return {
        project,
        seed,
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
        pipelineBakeBusy: false,
        host: null,
    };
}


function parseSeed(raw) {
    return Boot.parseSeedParam(raw);
}


function projectLabel(name) {
    const project = Boot.knownProject(name) && Projects.byName(name);
    return project && project.label ? project.label : name;
}


function paramOrder() {
    const registry = Params.all();
    return Params.exposed().slice().sort((a, b) => {
        const ma = MODULE_ORDER.indexOf(registry[a].module);
        const mb = MODULE_ORDER.indexOf(registry[b].module);
        return ma - mb || a.localeCompare(b);
    });
}


function effectiveBag(project, pins, workingValues) {
    if (Projects.isFixture(project)) return Projects.authored(project);
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


function formatValue(meta, value) {
    if (value == null) return 'free';
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    if (meta.unit === 'count' || meta.unit === 'step' || meta.unit === 'km' || meta.unit === 'm') {
        return String(Math.round(value));
    }
    if (meta.unit === 'frac' || meta.unit === '1') return value.toFixed(3);
    return String(Math.round(value * 10) / 10);
}


function applyPins(session, rebuild) {
    session.lastResolved = Projects.resolve({name: session.project, values: effectiveValues(session)});
    renderParams(session);
    renderProjectState(session);
    renderPipeline(session);
    syncVariantsUI(session);
    syncContext(session);
    if (rebuild) session.host.generateMesh();
}


function setParam(session, name, value) {
    if (Projects.isFixture(session.project)) return;
    if (name in session.pins) session.pins[name] = value;
    else session.workingValues[name] = value;
    session.projectModified = true;
    applyPins(session, true);
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
    renderProjectState(session);
}


function renderParams(session) {
    const host = document.getElementById('param-list');
    if (!host) return;
    host.textContent = '';
    const registry = Params.all();
    let lastGroup = null;

    for (const name of paramOrder()) {
        const meta = registry[name];
        const pinned = name in session.pins;
        const value = paramValue(session, name);

        if (meta.group !== lastGroup) {
            lastGroup = meta.group;
            const heading = document.createElement('div');
            heading.className = 'param-group';
            heading.textContent = GROUP_LABEL[meta.group] || meta.group;
            host.append(heading);
        }

        const row = document.createElement('div');
        const probing = !pinned && name in variantValues(session);
        row.className = pinned ? 'param' : probing ? 'param free is-probe' : 'param free';

        const head = document.createElement('div');
        head.className = 'param-head';

        const label = document.createElement('span');
        label.className = 'param-name';
        label.textContent = name;

        const readout = document.createElement('span');
        readout.className = 'param-value';
        readout.textContent = formatValue(meta, value);

        if (!Projects.isFixture(session.project) && Params.isBody(name)) {
            const pin = document.createElement('button');
            pin.type = 'button';
            pin.className = 'param-pin';
            pin.dataset.action = 'toggle-pin';
            pin.dataset.param = name;
            pin.textContent = pinned ? '◉' : '○';
            pin.setAttribute('aria-pressed', String(pinned));
            pin.title = pinned ? `${name} is pinned on this variant — click to free it`
                               : `${name} is free — click to pin it at its current value`;
            head.append(pin, label, readout);
        } else {
            head.append(label, readout);
        }
        row.append(head);

        if (meta.unit === 'bool') {
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.dataset.action = 'set-param';
            box.dataset.param = name;
            box.checked = !!value;
            row.append(box);
        } else if (meta.range) {
            const [lo, hi] = meta.range;
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.dataset.action = 'set-param';
            slider.dataset.param = name;
            slider.min = String(lo);
            slider.max = String(hi);
            slider.step = (meta.unit === 'count' || meta.unit === 'step') ? '1' : String((hi - lo) / 200);
            /* A free parameter still has to show something, so an unset one
               sits at the middle of its range rather than at zero. */
            slider.value = String(value == null ? (lo + hi) / 2 : value);
            row.append(slider);
        }

        host.append(row);
    }
}


function renderProjectState(session) {
    const state = document.getElementById('project-state');
    if (!state) return;
    const bits = [];
    if (!Projects.isFixture(session.project)) {
        bits.push(`${Object.keys(session.pins).length} locked`);
    }
    if (isWorkingDirty(session)) bits.push('uncommitted');
    if (session.variant && session.catalog.committed === session.variant.id) bits.push('adopted');
    else if (session.variant) bits.push('HEAD');
    state.textContent = bits.join(', ');
}


function renderPipeline(session) {
    const hostEl = document.getElementById('project-pipeline');
    if (!hostEl) return;
    const authored = Projects.byName(session.project);
    const notes = authored.pipeline || {};
    const factById = new Map((session.pipelineFact && session.pipelineFact.stages || []).map((s) => [s.id, s]));
    hostEl.textContent = '';
    hostEl.hidden = false;

    for (const stage of Projects.STAGES) {
        const live = factById.get(stage.id);
        const intent = (live && live.intent) || notes[stage.id] || '';
        const fact = live ? live.fact : '';
        const empty = !intent && !fact;
        const later = intent === 'later';
        const row = document.createElement('div');
        row.className = 'pipeline-row'
            + (empty ? ' is-empty' : '')
            + (later ? ' is-later' : '')
            + (fact === 'stale' ? ' is-stale' : '');
        if (stage.title) row.title = stage.title;

        const label = document.createElement('span');
        label.className = 'stage';
        label.textContent = stage.label;

        const right = document.createElement('span');
        right.className = 'status';
        const shown = live ? (fact || '—') : (empty ? '—' : intent);
        right.textContent = shown;
        if (intent && intent !== shown) right.title = intent;

        const tail = document.createElement('span');
        tail.className = 'pipeline-tail';
        tail.append(right);

        if (stage.id === 'regional' && live && live.canBake && session.pipelineFact) {
            const bake = document.createElement('button');
            bake.type = 'button';
            bake.className = 'pipeline-action';
            bake.dataset.action = 'bake-previews';
            bake.textContent = session.pipelineBakeBusy ? 'Baking…' : 'Bake tiles';
            bake.disabled = session.pipelineBakeBusy;
            tail.append(bake);
        }

        row.append(label, tail);
        hostEl.append(row);
    }
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


async function bakeProjectPreviews(session) {
    if (session.pipelineBakeBusy) return;
    await ensureVariant(session);
    const asked = TdOverlay.snapshot();
    session.pipelineBakeBusy = true;
    renderPipeline(session);
    session.host.enableTdCrops();
    try {
        const res = await fetch(`${TdOverlay.TD_API}/preview-bakes`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                project: session.project,
                seed: session.seed,
                values: effectiveValues(session),
                variant: session.variant && session.variant.id,
                connectOceans: session.host.getProcess().connectOceans,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        if (!TdOverlay.stillSameWorld(asked)) return;
        TdOverlay.reload();
        session.host.startTdJobPoll();
        await refreshPipeline(session);
    } catch (err) {
        window.alert(`Bake tiles failed: ${err.message || err}`);
    } finally {
        session.pipelineBakeBusy = false;
        renderPipeline(session);
    }
}


function syncProjectTitle(session) {
    const title = document.getElementById('project-title');
    if (title) title.textContent = projectLabel(session.project);
    if (!document.documentElement.classList.contains('is-picker')) {
        document.title = `${projectLabel(session.project)} — Procedural Planet Generation`;
    }
}


function showWorkspace(session) {
    document.documentElement.classList.remove('is-picker');
    document.getElementById('workspace')?.removeAttribute('aria-hidden');
    syncProjectTitle(session);
}


function showProjectPage(session) {
    if (session.searchSession) exitSearch(session);
    document.getElementById('variants-popover')?.hidePopover?.();
    document.documentElement.classList.add('is-picker');
    document.getElementById('workspace')?.setAttribute('aria-hidden', 'true');
    document.title = 'Projects';
    renderProjectPage(session);
    const current = document.querySelector('.project-card.is-current')
        || document.querySelector('.project-card');
    current?.focus();
}


function renderProjectPage(session) {
    const host = document.getElementById('project-list');
    if (!host) return;
    host.textContent = '';
    for (const project of Projects.PROJECTS) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'project-card' + (project.name === session.project && session.planetReady ? ' is-current' : '');
        card.dataset.action = 'open-project';
        card.dataset.project = project.name;
        if (project.name === session.project && session.planetReady) card.setAttribute('aria-current', 'page');

        card.textContent = project.label || project.name;
        host.append(card);
    }
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
    session.pins = Object.assign({}, project.body || {});
    session.workingValues = {};
    session.variant = null;
    session.workingParent = null;
    session.workingRanges = null;
    session.workingThumb = '';
    session.compareId = null;
    session.discovery = false;
    session.catalog = Variants.emptyCatalog(project.name);
    session.pendingVariantId = lastId;
    session.seedFromQuery = false;
    session.projectModified = false;
    Boot.writeStoredProject(session.project);
    syncProjectTitle(session);
    applyPins(session, false);

    await hydrateCatalog(session);
    if (resumeCatalog(session)) {
        session.host.generateMesh();
        renderSearchChrome(session);
        return;
    }

    const seed = project.fixture && project.seed != null ? project.seed : 1;
    resetSeedHistory(session, seed);
    session.host.generateMesh();
    syncContext(session);
    renderSearchChrome(session);
    syncVariantsUI(session);
}


function applySeed(session, next) {
    if (EarthFixture.isEarthSeed(next)) {
        session.seed = EarthFixture.TOKEN;
    } else {
        session.seed = (next | 0);
        if (session.seed === 0) session.seed = 1;
    }
    const input = document.getElementById('seed-input');
    if (input) input.value = String(session.seed);
    syncVariantsUI(session);
}


function syncSeedHistoryButtons(session) {
    const undo = document.getElementById('seed-undo');
    const redo = document.getElementById('seed-redo');
    if (undo) undo.disabled = session.seedHistoryIndex <= 0;
    if (redo) redo.disabled = session.seedHistoryIndex >= session.seedHistory.length - 1;
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
    session.host.generateMesh();
    syncSeedHistoryButtons(session);
    syncContext(session);
}


function setSeed(session, next) {
    const parsed = parseSeed(next);
    if (parsed == null) {
        const input = document.getElementById('seed-input');
        if (input) input.value = String(session.seed);
        return;
    }
    if (EarthFixture.isEarthSeed(parsed) && session.project !== 'earth') {
        const input = document.getElementById('seed-input');
        if (input) input.value = String(session.seed);
        return;
    }
    if (session.variant) session.discovery = true;
    commitSeed(session, parsed);
}


function shuffleSeed(session) {
    let next;
    do { next = (Math.random() * 0x7fffffff) | 0; } while (next === session.seed);
    if (session.variant) session.discovery = true;
    commitSeed(session, next);
}


function undoSeed(session) {
    if (session.seedHistoryIndex <= 0) return;
    session.seedHistoryIndex--;
    if (session.variant) session.discovery = true;
    applySeed(session, session.seedHistory[session.seedHistoryIndex]);
    session.host.generateMesh();
    syncSeedHistoryButtons(session);
    syncContext(session);
}


function redoSeed(session) {
    if (session.seedHistoryIndex >= session.seedHistory.length - 1) return;
    session.seedHistoryIndex++;
    if (session.variant) session.discovery = true;
    applySeed(session, session.seedHistory[session.seedHistoryIndex]);
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


async function persistCatalog(session) {
    const catalog = Projects.parseCatalog(session.catalog, session.project);
    session.catalog = catalog;
    cacheCatalog(catalog);
    try {
        const res = await fetch(`${TdOverlay.TD_API}/variants`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(Variants.serializeCatalog(catalog)),
        });
        if (res.ok) session.catalog = Projects.parseCatalog(await res.json(), session.project);
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
        const found = Variants.findById(session.catalog.variants, id);
        if (found && data.thumb) found.thumb = data.thumb;
    } catch (_) { /* optional */ }
}


async function hydrateCatalog(session) {
    let catalog = cachedCatalog(session.project) || Variants.emptyCatalog(session.project);
    try {
        const res = await fetch(`${TdOverlay.TD_API}/variants?project=${encodeURIComponent(session.project)}`);
        if (res.ok) {
            catalog = Projects.parseCatalog(await res.json(), session.project);
        }
    } catch (_) { /* cache / migrate */ }
    if (!catalog.variants.length && !Projects.isFixture(session.project)) {
        const migrated = Variants.migrate(
            parseLegacyKeeps(),
            parseLegacySeeds(),
            session.project,
            Projects.byName(session.project).body,
        );
        if (migrated.length) catalog.variants = migrated;
    }
    session.catalog = catalog;
    cacheCatalog(catalog);
    if (catalog.variants.length) await persistCatalog(session);
    for (const item of session.catalog.variants) {
        if (item.thumb && item.thumb.startsWith('data:')) {
            await persistThumb(session, item.id, item.thumb);
        }
    }
}


function resumeCatalog(session) {
    const id = Variants.resumeId({
        pendingId: session.pendingVariantId,
        lastId: Boot.readStoredVariant(session.project),
        committed: session.catalog.committed,
        variants: session.catalog.variants,
        seedFromQuery: session.seedFromQuery,
        fixture: Projects.isFixture(session.project),
    });
    session.pendingVariantId = null;
    session.seedFromQuery = false;
    const found = id && Variants.findById(session.catalog.variants, id);
    if (!found) {
        if (id && session.catalog.variants.length) Boot.writeStoredVariant(session.project, null);
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


async function hydrateAndResume(session) {
    await hydrateCatalog(session);
    resumeCatalog(session);
}


function setCatalogVariants(session, items) {
    const committed = items.some((item) => item.id === session.catalog.committed)
        ? session.catalog.committed
        : null;
    session.catalog = {
        project: session.project,
        committed,
        variants: items,
    };
    return persistCatalog(session);
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
        ctx.drawImage(canvas, 0, 0, width, height);
        return off.toDataURL('image/jpeg', 0.72);
    } catch (_) {
        return '';
    }
}


function captureWorkingThumb(session) {
    const thumb = variantThumbOf(document.getElementById('output'));
    if (thumb) session.workingThumb = thumb;
    return session.workingThumb || '';
}


function versionLabel(variant) {
    if (!variant) return 'working';
    if (variant.name) return variant.name;
    return String(variant.seed);
}


function isWorkingDirty(session) {
    return Variants.dirty(workingVariant(session), session.variant);
}


function workingVariant(session, extra) {
    extra = extra || {};
    return Variants.ofWorking({
        project: session.project,
        parent: extra.parent != null ? extra.parent
            : (session.variant && session.variant.id) || session.workingParent,
        seed: session.seed,
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


function renderVariantsList(session, items) {
    const list = document.getElementById('variants-list');
    if (!list) return;
    list.replaceChildren();
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'variants-empty';
        empty.textContent = 'No versions yet. Save the globe to start the tree.';
        list.append(empty);
        return;
    }
    const current = selectedVariant(session, items);
    for (const rowInfo of Variants.treeRows(items)) {
        const variant = rowInfo.variant;
        const committed = session.catalog.committed === variant.id;
        const isHead = current && current.id === variant.id;
        const isCompare = session.compareId === variant.id;

        if (rowInfo.notes.length) {
            const edge = document.createElement('div');
            edge.className = 'variant-edge';
            edge.style.paddingLeft = `${8 + rowInfo.depth * 16}px`;
            edge.textContent = rowInfo.notes.join(' · ');
            list.append(edge);
        }

        const row = document.createElement('div');
        row.className = 'variant-row'
            + (isHead ? ' is-current' : '')
            + (isCompare ? ' is-compare' : '')
            + (committed ? ' is-committed' : '');
        row.style.marginLeft = `${rowInfo.depth * 16}px`;

        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'variant-item';
        pick.dataset.action = 'compare-variant';
        pick.dataset.id = variant.id;
        pick.title = `Compare ${versionLabel(variant)}`;

        if (variant.thumb) {
            const img = document.createElement('img');
            img.className = 'variant-thumb';
            img.src = variant.thumb;
            img.alt = '';
            pick.append(img);
        } else {
            const blank = document.createElement('span');
            blank.className = 'variant-thumb-empty';
            blank.textContent = 'No thumbnail';
            pick.append(blank);
        }
        const meta = document.createElement('span');
        meta.className = 'variant-meta';
        const label = document.createElement('span');
        label.className = 'variant-name';
        label.textContent = versionLabel(variant);
        const num = document.createElement('span');
        num.className = 'variant-seed';
        num.textContent = String(variant.seed);
        meta.append(label, num);
        pick.append(meta);
        row.append(pick);

        const badges = document.createElement('div');
        badges.className = 'variant-badges';
        if (isHead) {
            const head = document.createElement('span');
            head.className = 'variant-badge';
            head.textContent = 'HEAD';
            badges.append(head);
        }
        if (committed) {
            const adopted = document.createElement('span');
            adopted.className = 'variant-badge';
            adopted.textContent = 'adopted';
            badges.append(adopted);
        }
        if ((variant.generation || 1) > 1) {
            const gen = document.createElement('span');
            gen.className = 'variant-badge';
            gen.textContent = `gen ${variant.generation}`;
            badges.append(gen);
        }
        if (badges.childNodes.length) row.append(badges);

        const actions = document.createElement('div');
        actions.className = 'variant-actions';
        if (!isHead) {
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'variant-open';
            open.dataset.action = 'open-variant';
            open.dataset.id = variant.id;
            open.textContent = 'Open';
            open.title = isWorkingDirty(session)
                ? `Check out ${versionLabel(variant)} — unsaved work is not kept`
                : `Check out ${versionLabel(variant)}`;
            actions.append(open);
        }
        if (committed) {
            const mark = document.createElement('span');
            mark.className = 'variant-committed';
            mark.title = 'Adopted — expensive stages use this version';
            mark.textContent = 'Adopted';
            actions.append(mark);
        } else {
            const adopt = document.createElement('button');
            adopt.type = 'button';
            adopt.className = 'variant-commit';
            adopt.dataset.action = 'commit-variant';
            adopt.dataset.id = variant.id;
            adopt.title = 'Adopt this version for the pipeline';
            adopt.textContent = 'Adopt';
            actions.append(adopt);
        }
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'variant-delete';
        del.dataset.action = 'delete-variant';
        del.dataset.id = variant.id;
        del.setAttribute('aria-label', `Remove ${versionLabel(variant)}`);
        del.textContent = '×';
        actions.append(del);
        row.append(actions);
        list.append(row);
    }
}


function comparePair(session, items) {
    const head = selectedVariant(session, items);
    const other = session.compareId ? Variants.findById(items, session.compareId) : null;
    const dirty = isWorkingDirty(session);
    if (other && (!head || other.id !== head.id)) {
        return {
            a: {
                label: dirty ? 'Uncommitted' : `${versionLabel(head)} · HEAD`,
                thumb: dirty ? session.workingThumb : (head && head.thumb),
            },
            b: {label: versionLabel(other), thumb: other.thumb},
        };
    }
    if (dirty && head) {
        return {
            a: {label: 'Uncommitted', thumb: session.workingThumb},
            b: {label: `${versionLabel(head)} · HEAD`, thumb: head.thumb},
        };
    }
    return null;
}


function renderVersionCompare(session, items) {
    const host = document.getElementById('versions-compare');
    const stage = document.getElementById('versions-compare-stage');
    const imgA = document.getElementById('versions-compare-a');
    const imgB = document.getElementById('versions-compare-b');
    const labelA = document.getElementById('versions-compare-a-label');
    const labelB = document.getElementById('versions-compare-b-label');
    if (!host || !imgA || !imgB) return;
    const pair = comparePair(session, items);
    if (!pair || !pair.a.thumb || !pair.b.thumb) {
        host.hidden = true;
        return;
    }
    host.hidden = false;
    imgA.hidden = !pair.a.thumb;
    imgB.hidden = !pair.b.thumb;
    if (pair.a.thumb) imgA.src = pair.a.thumb;
    if (pair.b.thumb) imgB.src = pair.b.thumb;
    if (labelA) labelA.textContent = pair.a.label;
    if (labelB) labelB.textContent = pair.b.label;
    const slider = document.getElementById('versions-compare-slider');
    if (stage && slider) stage.style.setProperty('--split', `${slider.value}%`);
}


function typedVersionName() {
    const nameInput = document.getElementById('variant-name');
    return nameInput ? nameInput.value.trim().slice(0, Variants.NAME_MAX) : '';
}


function branchInput(session, name) {
    return {
        name: name != null ? name : typedVersionName(),
        seed: session.seed,
        discover: !!session.discovery,
    };
}


function isBranching(session, name) {
    return Variants.wouldBranch(session.variant, branchInput(session, name));
}


function saveHint(session, items) {
    const name = typedVersionName();
    const dirty = isWorkingDirty(session);
    const head = selectedVariant(session, items);
    if (isBranching(session, name)) {
        if (name) return `Branches from ${versionLabel(head)} as ${name}.`;
        return `A new planet — save will branch from ${versionLabel(head)}.`;
    }
    if (!head) return 'Saves the globe as the first version.';
    if (dirty) return `Saves ${versionLabel(head)} — a newer generation of this line.`;
    return '';
}


function syncSaveButton(session) {
    const items = readVariants(session);
    const selected = selectedVariant(session, items);
    const dirty = isWorkingDirty(session);
    const name = typedVersionName();
    const branching = isBranching(session, name);
    const saveBtn = document.getElementById('variant-save');
    if (saveBtn) {
        if (branching) saveBtn.textContent = name ? `Branch as ${name}` : 'Branch';
        else if (!selected) saveBtn.textContent = name ? `Save as ${name}` : 'Save';
        else if (dirty) saveBtn.textContent = 'Save';
        else saveBtn.textContent = 'Saved';
        saveBtn.disabled = !branching && !dirty && !!selected;
    }
    const hint = document.getElementById('versions-save-hint');
    if (hint) {
        const text = saveHint(session, items);
        hint.textContent = text;
        hint.hidden = !text;
    }
}


function syncVariantsUI(session) {
    const items = readVariants(session);
    const selected = selectedVariant(session, items);
    const dirty = isWorkingDirty(session);
    syncSaveButton(session);
    const status = document.getElementById('versions-status');
    if (status) {
        if (dirty && selected) status.textContent = `On ${versionLabel(selected)} · uncommitted`;
        else if (dirty && session.workingParent) {
            const parent = Variants.findById(items, session.workingParent);
            status.textContent = parent ? `From ${versionLabel(parent)} · uncommitted` : 'Uncommitted';
        } else if (dirty) status.textContent = 'Uncommitted';
        else if (selected) status.textContent = `HEAD · ${versionLabel(selected)}`;
        else status.textContent = '';
    }
    const button = document.getElementById('variants-btn');
    if (button) {
        const blocked = Projects.isFixture(session.project);
        button.hidden = blocked;
        button.disabled = blocked;
        button.textContent = items.length ? `Versions ${items.length}` : 'Versions';
        button.classList.toggle('is-dirty', dirty && !blocked);
        button.title = dirty
            ? (isBranching(session)
                ? 'Uncommitted — a new planet, save will branch'
                : 'Uncommitted — save this version, or name a branch')
            : 'Versions of this project';
    }
    renderVersionCompare(session, items);
    renderVariantsList(session, items);
}


function positionVariantsPopover() {
    const button = document.getElementById('variants-btn');
    const popover = document.getElementById('variants-popover');
    if (!button || !popover) return;
    const rect = button.getBoundingClientRect();
    const gap = 8;
    const width = Math.min(384, window.innerWidth - 16);
    let left = rect.right + gap;
    let top = rect.top;
    if (left + width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - width - 8);
        top = rect.bottom + gap;
    }
    const maxTop = window.innerHeight - 16;
    popover.style.width = `${width}px`;
    popover.style.left = `${left}px`;
    popover.style.top = `${Math.min(top, maxTop)}px`;
    popover.style.transformOrigin = `${Math.max(0, rect.left - left)}px ${Math.max(0, rect.top - top)}px`;
}


function setupVariants(session) {
    const form = document.getElementById('variants-form');
    const popover = document.getElementById('variants-popover');
    if (form) {
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            saveWorkingVariant(session);
        });
    }
    if (popover) {
        popover.addEventListener('toggle', (event) => {
            const open = event.newState === 'open';
            document.getElementById('variants-btn')?.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (!open) return;
            captureWorkingThumb(session);
            syncVariantsUI(session);
            positionVariantsPopover();
            document.getElementById('variant-name')?.focus();
        });
        window.addEventListener('resize', () => {
            if (popover.matches(':popover-open')) positionVariantsPopover();
        });
        const slider = document.getElementById('versions-compare-slider');
        const stage = document.getElementById('versions-compare-stage');
        if (slider && stage) {
            slider.addEventListener('input', () => {
                stage.style.setProperty('--split', `${slider.value}%`);
            });
        }
        const nameInput = document.getElementById('variant-name');
        if (nameInput) {
            nameInput.addEventListener('input', () => syncSaveButton(session));
        }
    }
    syncVariantsUI(session);
}


function syncModeButtons(session) {
    const drawMode = session.host.getDrawMode();
    for (const b of document.querySelectorAll('[data-action="draw"]')) {
        b.setAttribute('aria-pressed', String(b.dataset.draw === drawMode));
    }
}


function renderSearchChrome(session) {
    const start = document.getElementById('search-start');
    const controls = document.getElementById('search-controls');
    const sheet = document.getElementById('search-sheet');
    const genes = Search.genesFor(searchPins(session));
    const blocked = Projects.isFixture(session.project) || genes.length === 0;
    if (start) {
        start.hidden = !!session.searchSession;
        start.disabled = blocked || !!session.searchSession;
        start.title = Projects.isFixture(session.project)
            ? 'Earth is a reference — explore does not run there'
            : 'Sample freeable ranges and pick the planets you like';
    }
    if (controls) controls.hidden = !session.searchSession;
    if (sheet) sheet.hidden = !session.searchSession;
    if (!session.searchSession) return;

    const s = session.searchSession;
    const next = document.getElementById('search-next');
    const back = document.getElementById('search-back');
    const done = document.getElementById('search-done');
    if (next) next.disabled = s.busy;
    if (back) back.disabled = s.busy || !s.history.length;
    if (done) done.disabled = s.busy;
    const status = document.getElementById('search-status');
    if (status) {
        const n = s.population.length;
        const ready = s.canvases.filter(Boolean).length;
        const saved = readVariants(session).length;
        const savedBit = saved ? ` · ${saved} versions` : '';
        status.textContent = s.busy
            ? `Generation ${s.generation + 1} · ${ready} / ${n}`
            : `Generation ${s.generation + 1} · ${s.liked.size} liked${savedBit}`;
    }
    const host = document.getElementById('search-ranges');
    if (host) {
        host.textContent = '';
        for (const name of s.genes) {
            const row = document.createElement('div');
            row.className = 'search-range';
            row.textContent = `${name}  ${Search.formatRange(name, s.ranges[name])}`;
            host.append(row);
        }
    }
}


function mountSearchTiles(session) {
    const grid = document.getElementById('search-grid');
    if (!grid || !session.searchSession) return;
    grid.textContent = '';
    const extras = searchExtra(session);
    const saved = readVariants(session);
    session.searchSession.population.forEach((ind, i) => {
        const liked = session.searchSession.liked.has(i);
        const kept = Variants.hasRecipe(saved, ind, extras);
        const tile = document.createElement('div');
        tile.className = 'search-tile'
            + (session.searchSession.canvases[i] ? '' : ' is-pending')
            + (liked ? ' is-liked' : '')
            + (kept ? ' is-kept' : '');
        tile.dataset.index = String(i);

        const face = document.createElement('button');
        face.type = 'button';
        face.className = 'search-tile-face';
        face.dataset.action = 'toggle-like';
        face.dataset.index = String(i);
        face.setAttribute('aria-pressed', String(liked));
        face.setAttribute('aria-label', liked ? 'Unlike this planet' : 'Like this planet');
        if (session.searchSession.canvases[i]) face.append(session.searchSession.canvases[i]);

        const actions = document.createElement('div');
        actions.className = 'search-tile-actions';

        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'search-tile-open';
        open.dataset.action = 'open-search';
        open.dataset.index = String(i);
        open.setAttribute('aria-label', 'Open in the viewer without saving');
        open.title = 'Open as uncommitted work — save will branch';
        open.textContent = 'Open';

        const keep = document.createElement('button');
        keep.type = 'button';
        keep.className = 'search-tile-keep';
        keep.dataset.action = 'toggle-variant';
        keep.dataset.index = String(i);
        keep.setAttribute('aria-pressed', String(kept));
        keep.setAttribute('aria-label', kept ? 'Already a version' : 'Save as a branch');
        keep.title = kept
            ? 'This planet is already a version'
            : (session.variant ? 'Save as a branch of the current version' : 'Save as the first version');
        keep.textContent = kept ? 'Saved' : (session.variant ? 'Branch' : 'Save');

        actions.append(open, keep);
        tile.append(face, actions);
        grid.append(tile);
    });
}


async function fillSearchSheet(session) {
    const current = session.searchSession;
    if (!current) return;
    const run = ++session.searchRun;
    current.busy = true;
    current.canvases = current.canvases || [];
    mountSearchTiles(session);
    renderSearchChrome(session);
    for (let i = 0; i < current.population.length; i++) {
        if (run !== session.searchRun || session.searchSession !== current) return;
        if (!current.canvases[i]) {
            current.canvases[i] = session.host.renderSearchTile(current.population[i]);
        }
        if (run !== session.searchRun || session.searchSession !== current) return;
        const tile = document.querySelector(`#search-grid .search-tile[data-index="${i}"]`);
        const face = tile && tile.querySelector('.search-tile-face');
        if (face && !face.contains(current.canvases[i])) {
            tile.classList.remove('is-pending');
            face.append(current.canvases[i]);
        }
        stampVariantThumb(session, i);
        renderSearchChrome(session);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (run !== session.searchRun || session.searchSession !== current) return;
    current.busy = false;
    renderSearchChrome(session);
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
    const liked = session.searchSession.liked.has(i);
    const tile = document.querySelector(`#search-grid .search-tile[data-index="${i}"]`);
    const face = tile && tile.querySelector('.search-tile-face');
    if (tile) tile.classList.toggle('is-liked', liked);
    if (face) {
        face.setAttribute('aria-pressed', String(liked));
        face.setAttribute('aria-label', liked ? 'Unlike this planet' : 'Like this planet');
    }
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


function syncSearchVariantTile(session, i, kept) {
    const tile = document.querySelector(`#search-grid .search-tile[data-index="${i}"]`);
    const button = tile && tile.querySelector('.search-tile-keep');
    if (tile) tile.classList.toggle('is-kept', kept);
    if (button) {
        button.setAttribute('aria-pressed', String(kept));
        button.setAttribute('aria-label', kept ? 'Already a version' : 'Save as a branch');
        button.textContent = kept ? 'Saved' : (session.variant ? 'Branch' : 'Save');
    }
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
    const next = Variants.append(readVariants(session), child);
    const saved = Variants.findById(next, child.id) || next[0];
    session.catalog = {
        project: session.project,
        committed: session.catalog.committed,
        variants: next,
    };
    if (saved && !head) session.catalog = Variants.advanceHead(session.catalog, null, saved.id);
    await persistCatalog(session);
    session.variant = saved;
    session.discovery = false;
    if (saved && thumb) persistThumb(session, saved.id, thumb);
    Boot.writeStoredVariant(session.project, saved && saved.id);
    session.workingValues = Object.assign({}, incoming.body, incoming.values);
    session.workingRanges = s.ranges;
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


async function applySavedVariant(session, saved, nameInput) {
    session.variant = saved;
    session.workingParent = null;
    session.workingRanges = saved.ranges || null;
    session.projectModified = false;
    session.compareId = null;
    session.discovery = false;
    Boot.writeStoredVariant(session.project, saved.id);
    if (saved.thumb) persistThumb(session, saved.id, saved.thumb);
    if (nameInput) nameInput.value = '';
    syncContext(session);
    syncVariantsUI(session);
    renderProjectState(session);
    return saved;
}


async function saveWorkingVariant(session) {
    if (Projects.isFixture(session.project)) return session.variant;
    const nameInput = document.getElementById('variant-name');
    const name = typedVersionName();
    const head = session.variant;
    const branching = isBranching(session, name);
    if (!branching && !isWorkingDirty(session) && head) return head;
    const thumb = captureWorkingThumb(session);
    if (head && !branching) {
        const incoming = workingVariant(session, {
            name: name || head.name,
            thumb,
            parent: head.parent,
            id: head.id,
        });
        const next = Variants.update(readVariants(session), head.id, incoming);
        session.catalog = {
            project: session.project,
            committed: session.catalog.committed,
            variants: next,
        };
        await persistCatalog(session);
        const saved = Variants.findById(next, head.id);
        return applySavedVariant(session, saved, nameInput);
    }
    const parentId = head ? head.id : session.workingParent;
    const incoming = workingVariant(session, {name, thumb, parent: parentId});
    if (!incoming) return session.variant;
    const next = Variants.append(readVariants(session), incoming);
    const saved = Variants.findById(next, incoming.id) || next[0];
    session.catalog = {
        project: session.project,
        committed: session.catalog.committed,
        variants: next,
    };
    if (saved && !branching) {
        session.catalog = Variants.advanceHead(session.catalog, parentId, saved.id);
    }
    await persistCatalog(session);
    return applySavedVariant(session, saved, nameInput);
}


function openVariant(session, id) {
    const variant = Variants.findById(readVariants(session), id);
    if (!variant) return;
    if (session.searchSession) exitSearch(session);
    loadVariantState(session, variant);
    session.compareId = null;
    session.projectModified = false;
    Boot.writeStoredVariant(session.project, variant.id);
    applyPins(session, false);
    if (session.seed === variant.seed) {
        session.host.generateMesh();
        syncContext(session);
        syncVariantsUI(session);
        return;
    }
    commitSeed(session, variant.seed);
    syncVariantsUI(session);
}


function compareVariant(session, id) {
    if (!Variants.findById(readVariants(session), id)) return;
    session.compareId = session.compareId === id ? null : id;
    captureWorkingThumb(session);
    syncVariantsUI(session);
}


function commitVariant(session, id) {
    const variant = Variants.findById(readVariants(session), id || (session.variant && session.variant.id));
    if (!variant) return;
    session.catalog = Variants.commit(session.catalog, variant.id);
    persistCatalog(session);
    if (!session.variant || session.variant.id !== variant.id) openVariant(session, variant.id);
    else {
        renderProjectState(session);
        syncVariantsUI(session);
    }
}


async function ensureVariant(session) {
    if (Projects.isFixture(session.project)) return null;
    if (session.variant) return session.variant;
    return saveWorkingVariant(session);
}


function deleteVariant(session, id) {
    const next = Variants.removeId(readVariants(session), id);
    if (session.compareId === id) session.compareId = null;
    if (session.workingParent === id) session.workingParent = null;
    setCatalogVariants(session, next);
    if (session.variant && session.variant.id === id) {
        session.variant = null;
        Boot.writeStoredVariant(session.project, null);
        applyPins(session, true);
        syncContext(session);
    } else if (Boot.readStoredVariant(session.project) === id) {
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
}


function exitSearch(session) {
    session.searchRun++;
    session.searchSession = null;
    document.body.classList.remove('search-mode');
    const grid = document.getElementById('search-grid');
    if (grid) grid.textContent = '';
    renderSearchChrome(session);
}


function enterSearch(session) {
    if (session.searchSession || Projects.isFixture(session.project)) return;
    const pins = searchPins(session);
    const genes = Search.genesFor(pins);
    if (!genes.length) return;
    const gen = Search.initialPopulation({
        values: pins,
        ranges: session.variant && session.variant.ranges,
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
    renderProjectPage(session);
    applyPins(session, false);
    syncModeButtons(session);
    renderSearchChrome(session);
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
        } else if (action === 'shuffle-seed') {
            shuffleSeed(session);
        } else if (action === 'undo-seed') {
            undoSeed(session);
        } else if (action === 'redo-seed') {
            redoSeed(session);
        } else if (action === 'search-start') {
            enterSearch(session);
        } else if (action === 'search-next') {
            nextSearch(session);
        } else if (action === 'search-back') {
            backSearch(session);
        } else if (action === 'search-done') {
            doneSearch(session);
        } else if (action === 'back-to-projects') {
            showProjectPage(session);
        } else if (action === 'open-project') {
            openProject(session, el.dataset.project);
        } else if (action === 'toggle-pin') {
            toggleParamPin(session, el.dataset.param);
        } else if (action === 'bake-previews') {
            bakeProjectPreviews(session);
        } else if (action === 'toggle-like') {
            toggleSearchLike(session, el.dataset.index | 0);
        } else if (action === 'open-search') {
            openSearchTile(session, el.dataset.index | 0);
        } else if (action === 'toggle-variant') {
            toggleSearchVariant(session, el.dataset.index | 0);
        } else if (action === 'open-variant') {
            openVariant(session, el.dataset.id);
        } else if (action === 'compare-variant') {
            compareVariant(session, el.dataset.id);
        } else if (action === 'delete-variant') {
            deleteVariant(session, el.dataset.id);
        } else if (action === 'commit-variant') {
            commitVariant(session, el.dataset.id);
        } else if (action === 'view-toggle') {
            const next = session.host.getViewMode() === 'globe' ? 'equirect' : 'globe';
            session.host.setViewMode(next);
            syncModeButtons(session);
        }
    });

    root.addEventListener('input', event => {
        const el = closestAction(event);
        if (!el) return;
        const action = el.dataset.action;
        if (action === 'plate-vectors') session.host.setDrawPlateVectors(el.checked);
        else if (action === 'plate-boundaries') session.host.setDrawPlateBoundaries(el.checked);
        else if (action === 'td-crops') session.host.setTdCrops(el.checked);
        else if (action === 'simulate-tectonics') session.host.setProcess('simulateTectonics', el.checked);
        else if (action === 'detail-pass') session.host.setProcess('detailPass', el.checked);
        else if (action === 'merge-ocean-plates') session.host.setProcess('mergeOceanPlates', el.checked);
        else if (action === 'connect-oceans') session.host.setProcess('connectOceans', el.checked);
        else if (action === 'rotation') session.host.setRotation(el.valueAsNumber);
        else if (action === 'regions') {
            const n = Math.pow(10, el.valueAsNumber) | 0;
            const label = document.getElementById('regions-label');
            if (label) label.textContent = String(n);
            session.host.setN(n);
        } else if (action === 'jitter') {
            const label = document.getElementById('jitter-label');
            if (label) label.textContent = el.valueAsNumber.toFixed(2);
            session.host.setJitter(el.valueAsNumber);
        } else if (action === 'set-param' && el.type === 'range') {
            const readout = el.parentElement && el.parentElement.querySelector('.param-value');
            const meta = Params.all()[el.dataset.param];
            if (readout && meta) readout.textContent = formatValue(meta, el.valueAsNumber);
        }
    });

    root.addEventListener('change', event => {
        const el = closestAction(event);
        if (!el) return;
        const action = el.dataset.action;
        if (action === 'seed') setSeed(session, el.value);
        else if (action === 'set-param') {
            const name = el.dataset.param;
            if (el.type === 'checkbox') setParam(session, name, el.checked);
            else setParam(session, name, el.valueAsNumber);
        }
    });

    document.getElementById('seed-input')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') event.currentTarget.blur();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && document.documentElement.classList.contains('is-picker')) {
            if (session.planetReady) {
                event.preventDefault();
                showWorkspace(session);
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
            else undoSeed(session);
        } else if (key === 'y' && !event.shiftKey) {
            event.preventDefault();
            redoSeed(session);
        }
    });
}


function mount(session, host) {
    mountHudIcons();
    session.host = host;
    session.refreshPipeline = () => refreshPipeline(session);
    session.exitSearch = () => exitSearch(session);
    session.setParam = (name, value) => setParam(session, name, value);
    session.syncModeButtons = () => syncModeButtons(session);
    session.markProjectModified = () => markProjectModified(session);
    session.setPlanetReady = (value) => {
        session.planetReady = !!value;
        if (!value) return;
        captureWorkingThumb(session);
        const popover = document.getElementById('variants-popover');
        if (popover && popover.matches(':popover-open')) syncVariantsUI(session);
    };
    bind(session);
    setupVariants(session);
    session.generateValues = () => effectiveValues(session);
    session.ensureVariant = () => ensureVariant(session);
    applySeed(session, session.seed);
    syncSeedHistoryButtons(session);
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
