/*
 * Workspace chrome. Preact views over a mutable session. The canvases
 * and generator stay outside this tree.
 */
'use strict';

const {render} = require('preact');
const {useEffect, useLayoutEffect, useRef, useState} = require('preact/hooks');
const {html} = require('./html');
const Projects = require('../projects');
const Params = require('../params');
const Search = require('../search');
const TdOverlay = require('../td-overlay');

const Variants = Projects.Variants;
const {discoverStage} = require('./stage');

const MODULE_ORDER = ['world', 'tectonics', 'climate', 'detail'];
const GROUP_LABEL = {
    body: 'Body',
    history: 'History',
    continents: 'Continents',
    volcanism: 'Volcanism',
    polar: 'Poles',
    water: 'Water',
    warp: 'Warp',
    ridges: 'Ridges',
    fluvial: 'Erosion',
    glacial: 'Ice',
};
const GROUP_ORDER = Object.keys(GROUP_LABEL);
const INTEGER_UNITS = new Set(['count', 'step', 'index', 'km', 'm']);
const INTEGER_STEPS = new Set(['count', 'step', 'index']);
const UNIT_MARK = {
    deg: '°',
    km: 'km',
    m: 'm',
    Myr: 'Myr',
    Gyr: 'Gyr',
    h: 'h',
    rad: 'rad',
};


function unitMark(unit) {
    return UNIT_MARK[unit] || '';
}


function formatValue(meta, value) {
    if (value == null) return 'free';
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    if (INTEGER_UNITS.has(meta.unit)) return String(Math.round(value));
    if (meta.unit === 'frac' || meta.unit === '1') return value.toFixed(3);
    return String(Math.round(value * 10) / 10);
}


function parseParamInput(meta, raw) {
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) return null;
    let next = n;
    if (INTEGER_STEPS.has(meta.unit) || INTEGER_UNITS.has(meta.unit)) next = Math.round(next);
    if (meta.range) next = Math.min(meta.range[1], Math.max(meta.range[0], next));
    return next;
}


function rangeProgress(value, lo, hi) {
    if (!(hi > lo)) return 0;
    const v = value == null ? (lo + hi) / 2 : value;
    return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}


function progressStyle(value, lo, hi) {
    return '--param-t:' + rangeProgress(value, lo, hi);
}


function actionsOf(session) {
    return session.ui && session.ui.actions;
}


function isFixture(session) {
    return Projects.isFixture(session.project);
}


function thumbSrc(thumb) {
    const url = TdOverlay.previewUrl(thumb);
    if (url && /^https?:/.test(url)) {
        return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'w=1024';
    }
    return url;
}


function variantHasSketch(variant) {
    return !!(variant && variant.shaped);
}


function groupRank(group) {
    const i = GROUP_ORDER.indexOf(group);
    return i < 0 ? 99 : i;
}


function paramValue(session, name) {
    const meta = Params.all()[name];
    const fallback = Projects.PRISTINE[meta.module][name];
    if (isFixture(session)) {
        const bag = Object.assign({}, Projects.authored(session.project), session.workingValues || {});
        return name in bag ? bag[name] : fallback;
    }
    const bag = Object.assign({}, session.workingValues || {}, session.pins || {});
    return name in bag ? bag[name] : fallback;
}


function paramsForStage(stage) {
    const registry = Params.all();
    return Params.exposed().slice().filter((name) => {
        const phase = Params.phase(name);
        if (stage === 'shape') return phase === 'shape';
        return phase === 'body' || phase === 'layout';
    }).sort((a, b) => {
        const ma = MODULE_ORDER.indexOf(registry[a].module);
        const mb = MODULE_ORDER.indexOf(registry[b].module);
        const ga = groupRank(registry[a].group);
        const gb = groupRank(registry[b].group);
        return ma - mb || ga - gb;
    });
}


function ParamCapsule({meta, live, onCommit}) {
    const [draft, setDraft] = useState(null);
    const cancel = useRef(false);
    const mark = unitMark(meta.unit);
    const shown = draft != null ? draft : formatValue(meta, live);
    return html`
        <label class="param-capsule">
            <input type="text" class="param-num" inputmode="decimal"
                autocomplete="off" spellcheck=${false}
                aria-label="Value"
                value=${shown}
                onFocus=${() => setDraft(formatValue(meta, live))}
                onInput=${(e) => setDraft(e.currentTarget.value)}
                onBlur=${(e) => {
                    if (cancel.current) {
                        cancel.current = false;
                        setDraft(null);
                        return;
                    }
                    const next = parseParamInput(meta, e.currentTarget.value);
                    setDraft(null);
                    if (next != null && next !== live) onCommit(next);
                }}
                onKeyDown=${(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') {
                        cancel.current = true;
                        setDraft(null);
                        e.currentTarget.blur();
                    }
                }} />
            ${mark ? html`<span class="param-unit">${mark}</span>` : null}
        </label>
    `;
}


function ParamRow({session, name}) {
    const meta = Params.all()[name];
    const pinned = name in session.pins;
    const value = paramValue(session, name);
    const probing = !pinned && name in (session.workingValues || {});
    const [live, setLive] = useState(value);
    useEffect(() => { setLive(value); }, [value]);
    const act = actionsOf(session);
    const canPin = !isFixture(session) && Params.isBody(name);
    const lo = meta.range && meta.range[0];
    const hi = meta.range && meta.range[1];

    return html`
        <div class=${pinned ? 'param' : probing ? 'param free is-probe' : 'param free'}>
            <div class="param-head">
                ${canPin && html`
                    <button type="button" class="param-pin"
                        aria-pressed=${String(pinned)}
                        title=${pinned
                            ? `${Params.label(name)} is pinned on this variant — click to free it`
                            : `${Params.label(name)} is free — click to pin it at its current value`}
                        onClick=${() => act.togglePin(name)}>
                        ${pinned ? '◉' : '○'}
                    </button>
                `}
                <span class="param-name" title=${name}>${Params.label(name)}</span>
            </div>
            ${meta.unit === 'bool' ? html`
                <div class="param-seg" role="group" aria-label=${Params.label(name)}>
                    <button type="button" aria-pressed=${String(!!live)}
                        onClick=${() => act.setParam(name, true)}>On</button>
                    <button type="button" aria-pressed=${String(!live)}
                        onClick=${() => act.setParam(name, false)}>Off</button>
                </div>
            ` : meta.range ? html`
                <${ParamCapsule} meta=${meta} live=${live}
                    onCommit=${(next) => act.setParam(name, next)} />
                <input type="range" min=${lo} max=${hi}
                    step=${INTEGER_STEPS.has(meta.unit) ? '1' : String((hi - lo) / 200)}
                    value=${live == null ? (lo + hi) / 2 : live}
                    style=${progressStyle(live, lo, hi)}
                    onInput=${(event) => setLive(event.currentTarget.valueAsNumber)}
                    onChange=${(event) => act.setParam(name, event.currentTarget.valueAsNumber)} />
            ` : null}
        </div>
    `;
}


function ParamList({session, stage}) {
    const names = paramsForStage(stage);
    const registry = Params.all();
    let lastGroup = null;
    const rows = [];
    for (const name of names) {
        const group = registry[name].group;
        if (group !== lastGroup) {
            lastGroup = group;
            rows.push(html`<div class="param-group" key=${'g-' + group}>${GROUP_LABEL[group] || group}</div>`);
        }
        rows.push(html`<${ParamRow} key=${name} session=${session} name=${name} />`);
    }
    return html`<div id="param-list">${rows}</div>`;
}


function CropListHost({session}) {
    const ref = useRef(null);
    useLayoutEffect(() => {
        const host = document.createElement('div');
        host.id = 'td-crop-list';
        ref.current.appendChild(host);
        if (session.host && session.host.refreshTdCropList) session.host.refreshTdCropList();
        return () => {
            host.remove();
        };
    }, []);
    return html`<div ref=${ref}></div>`;
}


function StageHead({title, forward}) {
    return html`
        <div class="stage-head">
            <h2>${title}</h2>
            ${forward || null}
        </div>
    `;
}


function StageTabs({session}) {
    const act = actionsOf(session);
    const stage = discoverStage(session);
    const shaping = session.pipelineShapeBusy;
    return html`
        <div class="stage-tabs" role="tablist" aria-label="Discover stage">
            <button type="button" role="tab" class="stage-tab"
                aria-selected=${String(stage === 'layout')}
                onClick=${() => { if (stage !== 'layout') act.goLayout(); }}>
                Layout
            </button>
            <button type="button" role="tab" class="stage-tab"
                aria-selected=${String(stage === 'shape')}
                disabled=${shaping}
                onClick=${() => { if (stage !== 'shape') act.goShape(); }}>
                ${shaping ? 'Shaping…' : 'Shape'}
            </button>
        </div>
    `;
}


function SeedField({label, value, onChange, onShuffle, shuffleTitle}) {
    return html`
        <div class="combo seed-field">
            <span class="combo-label">Seed</span>
            <input type="text" autocomplete="off" spellcheck=${false}
                aria-label=${label} title=${label} value=${String(value)}
                onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                onChange=${(e) => onChange(e.currentTarget.value)} />
            <button type="button" class="seed-shuffle" title=${shuffleTitle}
                onClick=${onShuffle}>Shuffle</button>
        </div>
    `;
}


function AdvancedParam({label, extraClass, meta, value, sliderMin, sliderMax, sliderStep, sliderValue, onSlide, onCommit}) {
    const [live, setLive] = useState(value);
    const [thumb, setThumb] = useState(sliderValue != null ? sliderValue : value);
    useEffect(() => {
        setLive(value);
        setThumb(sliderValue != null ? sliderValue : value);
    }, [value, sliderValue]);
    const commit = (next) => {
        if (next == null) return;
        setLive(next);
        if (sliderValue == null) setThumb(next);
        onCommit(next);
    };
    return html`
        <div class=${extraClass ? extraClass + ' param' : 'param'}>
            <div class="param-head"><span class="param-name">${label}</span></div>
            <${ParamCapsule} meta=${meta} live=${live} onCommit=${commit} />
            <input type="range" min=${sliderMin} max=${sliderMax} step=${sliderStep}
                value=${thumb}
                style=${progressStyle(thumb, sliderMin, sliderMax)}
                onInput=${(e) => {
                    const raw = e.currentTarget.valueAsNumber;
                    setThumb(raw);
                    const next = onSlide(raw);
                    if (next != null) setLive(next);
                }}
                onChange=${(e) => onCommit(onSlide(e.currentTarget.valueAsNumber))} />
        </div>
    `;
}


function Advanced({session}) {
    const host = session.host;
    if (!host) return null;
    const process = host.getProcess();
    const n = host.getN();
    const jitter = host.getJitter();
    const spacing = host.getShapeSpacing();
    const rotation = host.getRotation();
    const drawMode = host.getDrawMode();
    return html`
        <details class="panel">
            <summary>Advanced</summary>
            <label class="check">
                <input type="checkbox" checked=${process.simulateTectonics}
                    onChange=${(e) => host.setProcess('simulateTectonics', e.currentTarget.checked)} />
                <span>Live tectonics</span>
            </label>
            <label class="check">
                <input type="checkbox" checked=${process.mergeOceanPlates}
                    onChange=${(e) => host.setProcess('mergeOceanPlates', e.currentTarget.checked)} />
                <span>Merge ocean plates</span>
            </label>
            <label class="check">
                <input type="checkbox" checked=${process.connectOceans}
                    onChange=${(e) => host.setProcess('connectOceans', e.currentTarget.checked)} />
                <span>One world ocean</span>
            </label>
            <div class="row">
                <button type="button" aria-pressed=${String(drawMode === 'centroid')}
                    onClick=${() => { host.setDrawMode('centroid'); session.ui.actions.syncLook(); }}>
                    Flat cells
                </button>
            </div>
            <${AdvancedParam} label="Spin" extraClass="globe-only"
                meta=${{unit: '1', range: [-5, 5]}} value=${rotation}
                sliderMin=${-5} sliderMax=${5} sliderStep=${0.001}
                onSlide=${(v) => { host.setRotation(v); return v; }}
                onCommit=${(v) => host.setRotation(v)} />
            <${AdvancedParam} label="Layout mesh"
                meta=${{unit: 'count', range: [100, 100000]}} value=${n}
                sliderMin=${2} sliderMax=${5} sliderStep=${0.001}
                sliderValue=${Math.log10(n)}
                onSlide=${(log) => Math.pow(10, log) | 0}
                onCommit=${(next) => { host.setN(next | 0); session.redraw(); }} />
            <${AdvancedParam} label="Shape spacing"
                meta=${{unit: 'km', range: [10, 50]}} value=${spacing}
                sliderMin=${10} sliderMax=${50} sliderStep=${1}
                onSlide=${(v) => v | 0}
                onCommit=${(next) => { host.setShapeSpacing(next | 0); session.redraw(); }} />
            <${AdvancedParam} label="Mesh jitter"
                meta=${{unit: '1', range: [0, 1]}} value=${jitter}
                sliderMin=${0} sliderMax=${1} sliderStep=${0.001}
                onSlide=${(v) => v}
                onCommit=${(next) => { host.setJitter(next); session.redraw(); }} />
        </details>
    `;
}


function LayoutPanel({session}) {
    const act = actionsOf(session);
    const exploring = !!session.searchSession;
    const genes = Search.genesFor(isFixture(session) ? {} : (session.variant
        ? Variants.inheritedPins(session.catalog.variants, session.variant)
        : session.pins));
    const exploreBlocked = genes.length === 0;
    if (exploring) {
        const s = session.searchSession;
        const n = s.population.length;
        const ready = s.canvases.filter(Boolean).length;
        const saved = Variants.live(session.catalog.variants).length;
        const status = s.busy
            ? `Sheet ${s.generation + 1} · ${ready} / ${n}`
            : `Sheet ${s.generation + 1} · ${s.liked.size} liked${saved ? ` · ${saved} variants` : ''}`;
        return html`
            <div class="stage-panel">
                <${StageHead} title="Explore" forward=${html`
                    <button type="button" class="stage-forward" onClick=${() => act.searchDone()}
                        disabled=${s.busy}>Done</button>
                `} />
                <div class="stage-tools">
                    <div class="tool-row">
                        <button type="button" onClick=${() => act.searchNext()} disabled=${s.busy}>Next sheet</button>
                        <button type="button" onClick=${() => act.searchBack()}
                            disabled=${s.busy || !s.history.length}>Back</button>
                    </div>
                    <p class="muted">${status}</p>
                    <div id="search-ranges">
                        ${s.genes.map((name) => html`
                            <div class="search-range" key=${name} title=${name}>${Params.label(name)}  ${Search.formatRange(name, s.ranges[name])}</div>
                        `)}
                    </div>
                </div>
            </div>
        `;
    }
    return html`
        <div class="stage-panel">
            <${StageTabs} session=${session} />
            <div class="stage-tools">
                <${SeedField} label="Layout seed" value=${session.seed}
                    onChange=${act.setSeed} onShuffle=${act.shuffleSeed}
                    shuffleTitle="Shuffle the layout seed — a different planet" />
                <div class="tool-row">
                    <button type="button" disabled=${session.seedHistoryIndex <= 0}
                        title="Undo layout seed (⌘Z)" onClick=${() => act.undoSeed()}>Undo</button>
                    <button type="button" disabled=${session.seedHistoryIndex >= session.seedHistory.length - 1}
                        title="Redo layout seed (⌘⇧Z)" onClick=${() => act.redoSeed()}>Redo</button>
                    ${!isFixture(session) && html`
                        <button type="button" class="tool-push" disabled=${exploreBlocked}
                            title=${exploreBlocked
                                ? 'No freeable ranges to sample'
                                : 'Sample freeable ranges and pick the planets you like'}
                            onClick=${() => act.enterSearch()}>Explore</button>
                    `}
                </div>
                <div class="tool-row">
                    <button type="button" disabled=${!!session.pipelineLayoutBusy}
                        title="Rerun Layout and replace the cached plates"
                        onClick=${() => act.regenerateLayout()}>Regenerate</button>
                </div>
            </div>
            <${ParamList} session=${session} stage="layout" />
            <${Advanced} session=${session} />
        </div>
    `;
}


function ShapePanel({session}) {
    const act = actionsOf(session);
    return html`
        <div class="stage-panel">
            <${StageTabs} session=${session} />
            <div class="stage-tools">
                <${SeedField} label="Shape seed" value=${session.shapeSeed || session.seed}
                    onChange=${act.setShapeSeed} onShuffle=${act.shuffleShapeSeed}
                    shuffleTitle="Shuffle the shape seed — same planet" />
                <div class="tool-row">
                    <button type="button" disabled=${!!session.pipelineShapeBusy}
                        title="Rerun Shape and replace the cached sketch"
                        onClick=${() => act.regenerateShape()}>Regenerate</button>
                </div>
            </div>
            <${ParamList} session=${session} stage="shape" />
            <section class="preview-tiles">
                <h3>Preview tiles</h3>
                <${CropListHost} session=${session} />
            </section>
        </div>
    `;
}


function Shell({session}) {
    const act = actionsOf(session);
    const fixture = isFixture(session);
    const dirty = !fixture && Variants.dirty(
        session.ui.workingSnapshot,
        session.variant,
    );
    const items = session.catalog.variants || [];
    const selected = session.variant;
    const lineages = Variants.lineageRows(items, selected);
    const name = (session.ui.saveName || '').trim();
    const current = selected ? Variants.lineageName(items, selected) : '';
    const renamed = !!(name && name !== current);
    const different = session.ui.differentPlanet;
    const saveLabel = (selected && !dirty && !different && !renamed) ? 'Saved' : 'Save';
    const saveDisabled = fixture || (!!selected && !different && !dirty && !renamed);

    return html`
        <div class="studio-shell">
            <div class="app-nav">
                <button type="button" class="back-projects" onClick=${() => act.backToProjects()}>Projects</button>
                <span class="project-title">${session.ui.projectLabel}</span>
            </div>
            ${!fixture && html`
                <form class="combo save-row" onSubmit=${(e) => { e.preventDefault(); act.save(); }}>
                    <span class="combo-label">Name</span>
                    <input type="text" maxlength="48"
                        autocomplete="off" spellcheck=${false} aria-label="Variant name"
                        value=${session.ui.saveName}
                        onInput=${(e) => act.setSaveName(e.currentTarget.value)} />
                    <button type="submit" class="stage-forward" disabled=${saveDisabled}
                        title="Save (⌘S)">${saveLabel}</button>
                </form>
                ${session.ui.saveHint ? html`<p class="versions-hint">${session.ui.saveHint}</p>` : null}
                <button type="button"
                    class=${'shell-variants' + (dirty ? ' is-dirty' : '')}
                    onClick=${() => act.openVariants()}>
                    <span>Variants</span>
                    ${lineages.length ? html`<span class="shell-count">${lineages.length}</span>` : null}
                </button>
            `}
        </div>
    `;
}


function Picker({session}) {
    const act = actionsOf(session);
    const picker = typeof document !== 'undefined'
        && document.documentElement.classList.contains('is-picker');
    const creating = session.ui.pickerView === 'create';
    const draft = session.ui.createDraft || Object.assign({name: ''}, Projects.Init.DEFAULTS);
    const Init = Projects.Init;
    useEffect(() => {
        if (!picker) return;
        if (creating) {
            const input = document.querySelector('.project-create-name');
            if (input) input.focus();
            return;
        }
        const current = document.querySelector('.project-card.is-current')
            || document.querySelector('.project-card');
        current && current.focus();
    }, [picker, creating, session.project, session.planetReady]);
    if (!picker) return null;
    if (creating) {
        return html`
            <div class="project-page-inner">
                <h1>New project</h1>
                <p class="project-page-lead">Name the project. Pick size, age, day, and water.</p>
                <form class="project-create" onSubmit=${(e) => { e.preventDefault(); act.createProject(); }}>
                    <label class="project-create-field">
                        <span>Name</span>
                        <input type="text" class="project-create-name" maxlength=${Init.NAME_MAX}
                            autocomplete="off" spellcheck=${false}
                            value=${draft.name}
                            onInput=${(e) => act.setCreateDraft({name: e.currentTarget.value})} />
                    </label>
                    ${Object.keys(Init.AXES).map((axis) => {
                        const spec = Init.AXES[axis];
                        return html`
                            <div class="bucket-axis" key=${axis}>
                                <div class="bucket-label">${spec.label}</div>
                                <div class="bucket-list" role="radiogroup" aria-label=${spec.label}>
                                    ${spec.options.map((opt) => html`
                                        <button type="button" key=${opt.id}
                                            class=${'bucket' + (draft[axis] === opt.id ? ' is-on' : '')}
                                            role="radio"
                                            aria-checked=${String(draft[axis] === opt.id)}
                                            title=${opt.hint}
                                            onClick=${() => act.setCreateDraft({[axis]: opt.id})}>
                                            <span>${opt.label}</span>
                                            <span class="bucket-hint">${opt.hint}</span>
                                        </button>
                                    `)}
                                </div>
                            </div>
                        `;
                    })}
                    ${session.ui.createError ? html`<p class="project-create-error">${session.ui.createError}</p>` : null}
                    <div class="project-create-actions">
                        <button type="button" onClick=${() => act.cancelCreateProject()}>Back</button>
                        <button type="submit" class="stage-forward"
                            disabled=${session.ui.createBusy}>Create</button>
                    </div>
                </form>
            </div>
        `;
    }
    return html`
        <div class="project-page-inner">
            <h1>Projects</h1>
            <p class="project-page-lead">Open a project, or start one.</p>
            <div class="project-list">
                ${Projects.list().map((project) => {
                    const current = project.name === session.project && session.planetReady;
                    return html`
                        <button type="button" key=${project.name}
                            class=${'project-card' + (current ? ' is-current' : '')}
                            aria-current=${current ? 'page' : undefined}
                            onClick=${() => act.openProject(project.name)}>
                            ${project.label || project.name}
                        </button>
                    `;
                })}
                <button type="button" class="project-card is-new"
                    onClick=${() => act.beginCreateProject()}>
                    New project
                </button>
            </div>
        </div>
    `;
}


function SearchFace({canvas, liked, index, onToggle}) {
    const ref = useRef(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || !canvas) return;
        if (canvas.parentNode !== el) el.replaceChildren(canvas);
    }, [canvas]);
    return html`
        <button type="button" class="search-tile-face" ref=${ref}
            aria-pressed=${String(liked)}
            aria-label=${liked ? 'Unlike this planet' : 'Like this planet'}
            onClick=${() => onToggle(index)} />
    `;
}


function ExploreLayer({session}) {
    const s = session.searchSession;
    if (!s) return null;
    const act = actionsOf(session);
    const extras = session.ui.searchExtra;
    const saved = Variants.live(session.catalog.variants);
    return html`
        <div id="search-sheet">
            <div id="search-grid">
                ${s.population.map((ind, i) => {
                    const liked = s.liked.has(i);
                    const kept = Variants.hasRecipe(saved, ind, extras);
                    const pending = !s.canvases[i];
                    return html`
                        <div class=${'search-tile'
                            + (pending ? ' is-pending' : '')
                            + (liked ? ' is-liked' : '')
                            + (kept ? ' is-kept' : '')}
                            key=${i}>
                            <${SearchFace} canvas=${s.canvases[i]} liked=${liked} index=${i}
                                onToggle=${act.toggleLike} />
                            <div class="search-tile-actions">
                                <button type="button" class="search-tile-open"
                                    title="Open as uncommitted work — Save writes a new planet"
                                    onClick=${() => act.openSearchTile(i)}>Open</button>
                                <button type="button" class="search-tile-keep"
                                    aria-pressed=${String(kept)}
                                    title=${kept ? 'This planet is already a variant'
                                        : (session.variant ? 'Save a child of Active' : 'Save the first variant')}
                                    onClick=${() => act.toggleSearchVariant(i)}>
                                    ${kept ? 'Saved' : 'Save'}
                                </button>
                            </div>
                        </div>
                    `;
                })}
            </div>
        </div>
    `;
}


function variantStatus(session, row) {
    const tip = row.variant;
    const history = row.history || [tip];
    const activeHere = session.variant && history.some((node) => node.id === session.variant.id);
    const bits = [];
    if (activeHere) bits.push('Active');
    bits.push(variantHasSketch(tip) ? 'Shape' : 'Layout');
    return bits;
}


function historyLabel(node) {
    return variantHasSketch(node) ? 'Shape' : 'Layout';
}


function variantCols(count) {
    if (count <= 1) return 1;
    if (count === 2) return 2;
    if (count === 3) return 3;
    if (count === 4) return 2;
    return 3;
}


function UndoBadge({session}) {
    const undo = session.ui && session.ui.undo;
    if (!undo) return null;
    const act = actionsOf(session);
    return html`
        <div class=${'undo-badge' + (undo.leaving ? ' is-leaving' : '')} role="status">
            <span class="undo-badge-msg">${undo.message}</span>
            ${undo.run ? html`
                <button type="button" onClick=${() => act.runUndo()}>Undo</button>
            ` : null}
        </div>
    `;
}


function VariantsModal({session}) {
    const act = actionsOf(session);
    const items = session.catalog.variants || [];
    const rows = Variants.lineageRows(items, session.variant);
    const cols = variantCols(rows.length);
    useEffect(() => {
        const onKey = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                act.closeVariants();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);
    return html`
        <div class="studio-modal-backdrop" onMouseDown=${(e) => {
            if (e.target === e.currentTarget) act.closeVariants();
        }}>
            <div class="studio-modal is-variants" role="dialog" aria-labelledby="variants-title"
                data-cols=${cols} style=${'--variant-cols:' + cols}>
                <div class="versions-head">
                    <div id="variants-title" class="variants-title">Variants</div>
                    <button type="button" class="modal-close" aria-label="Close"
                        onClick=${() => act.closeVariants()}>×</button>
                </div>
                ${!rows.length ? html`
                    <div class="variants-empty">No variants yet. Save this planet.</div>
                ` : html`
                    <div class="variant-tree">
                        ${rows.map((row) => {
                            const variant = row.variant;
                            const history = row.history || [variant];
                            const label = row.name;
                            const activeId = session.variant && session.variant.id;
                            const activeHere = history.some((node) => node.id === activeId);
                            const status = variantStatus(session, row);
                            return html`
                                <div class="variant-branch" key=${variant.id}>
                                    <div class=${'variant-node' + (activeHere ? ' is-active' : '')}>
                                        <button type="button" class="variant-item"
                                            title=${activeHere ? 'Active' : `Open ${label}`}
                                            onClick=${() => {
                                                if (activeId === variant.id) act.closeVariants();
                                                else act.openVariant(variant.id);
                                            }}>
                                            ${variant.thumb
                                                ? html`<span class="variant-thumb-frame"><img class="variant-thumb" src=${thumbSrc(variant.thumb)} alt="" /></span>`
                                                : html`<span class="variant-thumb-frame variant-thumb-empty">${
                                                    session.thumbPending && session.thumbPending.has(variant.id)
                                                        ? 'The thumbnail is not ready' : 'No thumbnail'
                                                }</span>`}
                                            <span class="variant-meta">
                                                <span class="variant-name">${label}</span>
                                                <span class="variant-status">${status.join(' · ')}</span>
                                            </span>
                                        </button>
                                        ${history.length > 1 ? html`
                                            <div class="variant-history" role="group"
                                                aria-label=${`Lineage of ${label}`}>
                                                ${history.map((node) => {
                                                    const current = node.id === activeId;
                                                    const past = historyLabel(node);
                                                    return html`
                                                        <button type="button"
                                                            class=${'variant-history-item'
                                                                + (current ? ' is-current' : '')}
                                                            title=${current
                                                                ? `${past} — this save`
                                                                : `Open the ${past} save`}
                                                            onClick=${() => {
                                                                if (current) return;
                                                                act.openVariant(node.id, {keepOpen: true});
                                                            }}>
                                                            ${node.thumb
                                                                ? html`<img src=${thumbSrc(node.thumb)} alt="" />`
                                                                : html`<span>${past}</span>`}
                                                        </button>
                                                    `;
                                                })}
                                            </div>
                                        ` : null}
                                        <div class="variant-actions">
                                            <button type="button" class="variant-delete"
                                                aria-label=${`Remove ${label}`}
                                                onClick=${() => act.deleteVariant(variant.id)}>×</button>
                                        </div>
                                    </div>
                                </div>
                            `;
                        })}
                    </div>
                `}
            </div>
        </div>
    `;
}


function WorkspaceChrome({session}) {
    const stage = discoverStage(session);
    return html`
        <div class="sidebar-chrome">
            <${Shell} session=${session} />
            ${stage === 'shape'
                ? html`<${ShapePanel} session=${session} />`
                : html`<${LayoutPanel} session=${session} />`}
        </div>
    `;
}


function snapshotForUi(session, extras) {
    extras = extras || {};
    session.ui.projectLabel = extras.projectLabel;
    session.ui.workingSnapshot = extras.workingSnapshot;
    session.ui.differentPlanet = extras.differentPlanet;
    session.ui.saveHint = extras.saveHint;
    session.ui.searchExtra = extras.searchExtra;
}


function redraw(session) {
    const picker = document.getElementById('project-page');
    const studio = document.getElementById('studio-root');
    const explore = document.getElementById('explore-root');
    const modals = document.getElementById('modal-root');
    if (picker) render(html`<${Picker} session=${session} />`, picker);
    if (studio) render(html`<${WorkspaceChrome} session=${session} />`, studio);
    if (explore) render(html`<${ExploreLayer} session=${session} />`, explore);
    if (modals) {
        const bits = [];
        if (session.ui.variantsOpen && !isFixture(session)) {
            bits.push(html`<${VariantsModal} session=${session} />`);
        }
        bits.push(html`<${UndoBadge} session=${session} />`);
        render(html`<div>${bits}</div>`, modals);
    }
}


function mount(session, extrasFn, bound) {
    session.ui.actions = bound;
    session.redraw = () => {
        snapshotForUi(session, extrasFn());
        redraw(session);
    };
    session.redraw();
}


module.exports = {
    mount,
    redraw,
    discoverStage,
    variantHasSketch,
};
