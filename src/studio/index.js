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
    TdOverlay.setContext(session.project, session.seed, session.variant && session.variant.id);
    Boot.syncAddressBar(session.project, session.seed, session.variant && session.variant.id);
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
    if (Projects.isFixture(session.project)) bits.push('fixture');
    else bits.push(`${Object.keys(session.pins).length} pinned`);
    if (session.projectModified) bits.push('edited');
    if (session.variant && session.catalog.committed === session.variant.id) bits.push('committed');
    else if (session.variant) bits.push('variant');
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

    const heading = document.createElement('div');
    heading.className = 'param-group';
    heading.textContent = 'Pipeline';
    hostEl.append(heading);

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
            bake.textContent = session.pipelineBakeBusy ? 'Baking…' : 'Bake previews';
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
        window.alert(`Bake previews failed: ${err.message || err}`);
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
    dropVariant(session);
    commitSeed(session, parsed);
}


function shuffleSeed(session) {
    let next;
    do { next = (Math.random() * 0x7fffffff) | 0; } while (next === session.seed);
    dropVariant(session);
    commitSeed(session, next);
}


function undoSeed(session) {
    if (session.seedHistoryIndex <= 0) return;
    session.seedHistoryIndex--;
    dropVariant(session);
    applySeed(session, session.seedHistory[session.seedHistoryIndex]);
    session.host.generateMesh();
    syncSeedHistoryButtons(session);
    syncContext(session);
}


function redoSeed(session) {
    if (session.seedHistoryIndex >= session.seedHistory.length - 1) return;
    session.seedHistoryIndex++;
    dropVariant(session);
    applySeed(session, session.seedHistory[session.seedHistoryIndex]);
    session.host.generateMesh();
    syncSeedHistoryButtons(session);
    syncContext(session);
}


function dropVariant(session) {
    if (!session.variant) return;
    session.variant = null;
    applyPins(session, false);
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
        return canvas.toDataURL('image/jpeg', 0.72);
    } catch (_) {
        return '';
    }
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


function matchingVariant(session, items) {
    const selected = selectedVariant(session, items);
    if (selected) return selected;
    return Variants.findByRecipe(items, workingVariant(session));
}


function renderVariantsList(session, items) {
    const list = document.getElementById('variants-list');
    if (!list) return;
    list.replaceChildren();
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'variants-empty';
        empty.textContent = 'No variants yet';
        list.append(empty);
        return;
    }
    const current = selectedVariant(session, items);
    for (const rowInfo of Variants.treeRows(items)) {
        const variant = rowInfo.variant;
        const committed = session.catalog.committed === variant.id;
        const score = Variants.refinement(variant);

        if (rowInfo.notes.length) {
            const edge = document.createElement('div');
            edge.className = 'variant-edge';
            edge.style.paddingLeft = `${10 + rowInfo.depth * 12}px`;
            edge.textContent = rowInfo.notes.join(' · ');
            list.append(edge);
        }

        const row = document.createElement('div');
        row.className = 'variant-row'
            + (current && current.id === variant.id ? ' is-current' : '')
            + (committed ? ' is-committed' : '');
        row.style.paddingLeft = `${rowInfo.depth * 12}px`;

        const load = document.createElement('button');
        load.type = 'button';
        load.className = 'variant-item';
        load.dataset.action = 'open-variant';
        load.dataset.id = variant.id;
        const refinePct = Math.round(score * 100);
        load.title = variant.name
            ? `${variant.name} (seed ${variant.seed}, ${refinePct}% refined)`
            : `Open variant seed ${variant.seed} · ${refinePct}% refined`;

        if (variant.thumb) {
            const img = document.createElement('img');
            img.className = 'variant-thumb';
            img.src = variant.thumb;
            img.alt = '';
            load.append(img);
        }

        const meta = document.createElement('span');
        meta.className = 'variant-meta';

        const text = document.createElement('span');
        text.className = 'variant-text';
        const label = document.createElement('span');
        label.className = 'variant-name';
        label.textContent = variant.name || String(variant.seed);
        text.append(label);
        if (variant.name) {
            const num = document.createElement('span');
            num.className = 'variant-seed';
            num.textContent = String(variant.seed);
            text.append(num);
        }
        meta.append(text);

        const track = document.createElement('span');
        track.className = 'variant-refine';
        track.setAttribute('aria-hidden', 'true');
        const fill = document.createElement('span');
        fill.className = 'variant-refine-fill';
        fill.style.width = `${Math.max(0, Math.min(100, refinePct))}%`;
        track.append(fill);
        meta.append(track);
        load.append(meta);

        if (committed) {
            const mark = document.createElement('span');
            mark.className = 'variant-committed';
            mark.title = 'Committed — expensive stages use this variant';
            mark.textContent = 'in';
            row.append(load, mark);
        } else {
            const commit = document.createElement('button');
            commit.type = 'button';
            commit.className = 'variant-commit';
            commit.dataset.action = 'commit-variant';
            commit.dataset.id = variant.id;
            commit.title = 'Commit this variant';
            commit.textContent = 'Commit';
            row.append(load, commit);
        }

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'variant-delete';
        del.dataset.action = 'delete-variant';
        del.dataset.id = variant.id;
        del.setAttribute('aria-label', `Remove ${variant.name || variant.seed}`);
        del.textContent = '×';

        row.append(del);
        list.append(row);
    }
}


function syncVariantsUI(session) {
    const items = readVariants(session);
    const selected = selectedVariant(session, items);
    const matching = matchingVariant(session, items);
    const nameInput = document.getElementById('variant-name');
    if (nameInput && document.activeElement !== nameInput) {
        nameInput.value = selected && selected.name ? selected.name : '';
    }
    const saveBtn = document.querySelector('#variants-form button[type="submit"]');
    if (saveBtn) saveBtn.textContent = matching ? 'Update' : 'Save';
    const button = document.getElementById('variants-btn');
    if (button) {
        const blocked = Projects.isFixture(session.project);
        button.hidden = blocked;
        button.disabled = blocked;
        button.textContent = items.length ? `Variants ${items.length}` : 'Variants';
    }
    renderVariantsList(session, items);
}


function positionVariantsPopover() {
    const button = document.getElementById('variants-btn');
    const popover = document.getElementById('variants-popover');
    if (!button || !popover) return;
    const rect = button.getBoundingClientRect();
    const gap = 8;
    const width = Math.min(320, window.innerWidth - 16);
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
            syncVariantsUI(session);
            positionVariantsPopover();
            document.getElementById('variant-name')?.focus();
        });
        window.addEventListener('resize', () => {
            if (popover.matches(':popover-open')) positionVariantsPopover();
        });
    }
    syncVariantsUI(session);
}


function syncModeButtons(session) {
    const viewMode = session.host.getViewMode();
    const drawMode = session.host.getDrawMode();
    for (const b of document.querySelectorAll('#view-mode button')) {
        b.setAttribute('aria-pressed', String(b.dataset.view === viewMode));
    }
    for (const b of document.querySelectorAll('#draw-mode button')) {
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
            ? 'Earth is the fixture — search does not run there'
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
        const savedBit = saved ? ` · ${saved} variants` : '';
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
        open.title = 'Open in the main viewer without saving as a variant';
        open.textContent = 'Open';

        const keep = document.createElement('button');
        keep.type = 'button';
        keep.className = 'search-tile-keep';
        keep.dataset.action = 'toggle-variant';
        keep.dataset.index = String(i);
        keep.setAttribute('aria-pressed', String(kept));
        keep.setAttribute('aria-label', kept ? 'Remove variant' : 'Save as variant');
        keep.textContent = kept ? 'Saved' : 'Save';

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
    renderSearchChrome(session);
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
        button.setAttribute('aria-label', kept ? 'Remove variant' : 'Save as variant');
        button.textContent = kept ? 'Saved' : 'Save';
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
    const parent = s.parentId || (session.variant && session.variant.id) || null;
    const ranges = s.ranges;
    exitSearch(session);
    session.variant = null;
    session.pins = pins;
    session.workingValues = Object.assign({}, incoming.body, incoming.values);
    session.workingParent = parent;
    session.workingRanges = ranges;
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


function toggleSearchVariant(session, i) {
    const s = session.searchSession;
    if (!s) return;
    const ind = s.population[i];
    if (!ind) return;
    const extra = searchExtra(session);
    const thumb = variantThumbOf(s.canvases[i]);
    if (thumb) extra.thumb = thumb;
    const incoming = Variants.ofIndividual(ind, extra);
    const next = Variants.toggleRecipe(readVariants(session), incoming);
    setCatalogVariants(session, next);
    const saved = Variants.findByRecipe(next, incoming);
    if (saved && extra.thumb) persistThumb(session, saved.id, extra.thumb);
    syncSearchVariantTile(session, i, Variants.hasRecipe(next, ind, extra));
    renderSearchChrome(session);
    syncVariantsUI(session);
}


async function saveWorkingVariant(session) {
    if (Projects.isFixture(session.project)) return session.variant;
    const nameInput = document.getElementById('variant-name');
    const name = nameInput ? nameInput.value.trim().slice(0, Variants.NAME_MAX) : '';
    const incoming = workingVariant(session, {name});
    if (!incoming) return session.variant;
    const next = Variants.upsert(readVariants(session), incoming);
    await setCatalogVariants(session, next);
    const saved = Variants.findByRecipe(next, incoming) || Variants.findById(next, incoming.id);
    if (saved) {
        session.variant = saved;
        Boot.writeStoredVariant(session.project, saved.id);
    }
    syncContext(session);
    syncVariantsUI(session);
    renderProjectState(session);
    return saved;
}


function openVariant(session, id) {
    const variant = Variants.findById(readVariants(session), id);
    if (!variant) return;
    document.getElementById('variants-popover')?.hidePopover?.();
    if (session.searchSession) exitSearch(session);
    loadVariantState(session, variant);
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
    s.population = next.population;
    s.liked = new Set();
    s.generation += 1;
    s.canvases = [];
    fillSearchSheet(session);
}


function backSearch(session) {
    const s = session.searchSession;
    if (!s || s.busy || !s.history.length) return;
    session.searchRun++;
    const prev = s.history.pop();
    s.ranges = prev.ranges;
    s.population = prev.population;
    s.liked = prev.liked;
    s.generation = prev.generation;
    s.canvases = prev.canvases || [];
    s.busy = false;
    mountSearchTiles(session);
    renderSearchChrome(session);
}


function doneSearch(session) {
    const s = session.searchSession;
    if (!s || s.busy) return;
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
    session.host = host;
    session.refreshPipeline = () => refreshPipeline(session);
    session.exitSearch = () => exitSearch(session);
    session.setParam = (name, value) => setParam(session, name, value);
    session.syncModeButtons = () => syncModeButtons(session);
    session.markProjectModified = () => markProjectModified(session);
    session.setPlanetReady = (value) => { session.planetReady = !!value; };
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
