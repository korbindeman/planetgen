/*
 * Overlay baked terrain-diffusion tiles on the live globe / equirect, and
 * host the picker that chooses which ground to bake next.
 *
 * What goes on the map is the 90 m DEM itself — `output.elev`, raw float
 * metres — coloured here with the same surface look the globe uses. It is
 * deliberately not `output.png`: that was coloured once on the machine that
 * ran the bake, so it could never follow the map it sits on. The PNG is kept
 * only as a fallback for crops baked before the dump existed.
 *
 * Where a tile goes comes from its (face, level, i, j) on the cubesphere
 * grid, not from a lon/lat box. The box in the GeoTIFF is nominal.
 *
 * The catalog is the folders on disk for the current project. A reply
 * that left for a different project is dropped, not filtered after the
 * fact. Jobs are progress next to that list, never a second set of crops.
 * Colouring is a cache on the DEM, not a replacement for it.
 *
 * The catalog comes from the bake server, or from
 * src/.td-overlays/catalog.js when it is down.
 */
const {vec4} = require('gl-matrix');
const Look = require('./look');
const TdTile = require('./td-tile');
const Cube = require('./cubesphere');
const Epoch = require('./td-epoch');

const MAX_IMAGE = 4096;
const GLOBE_STEPS = 10;
const COLORS = (Look.CROP_COLORS_HEX || []).concat(['#c084fc', '#4ade80']);
const TD_API = 'http://127.0.0.1:3748';

/* Grid chrome. The hover ghost has to read as "this is what you would get"
 * without competing with the baked tiles underneath it. */
const GRID_LINE = 'rgba(255,255,255,0.30)';
const GRID_LINE_DARK = 'rgba(0,0,0,0.22)';
const HOVER_FILL = 'rgba(56,189,248,0.20)';
const HOVER_LINE = '#38bdf8';
const PICK_FILL = 'rgba(56,189,248,0.32)';
const PICK_LINE = '#0ea5e9';
/* Segments per tile edge. Fixed on purpose: derive it from apparent size and
 * the geometry changes as you zoom, which is its own kind of instability. */
const GRID_SEGMENTS_PER_TILE = 4;

let enabled = false;
let catalog = {seed: null, lon0: 0, project: null, crops: []};
let hidden = new Set();
let loadState = 'idle';
let apiUp = false;
let jobs = [];
let apiTries = 0;
/*
 * One epoch for every async path. A catalog fetch, a DEM, a colouring
 * and a job poll all carry a snapshot of this, and are dropped when the
 * world or the mesh has moved on. The previous loadGen token only
 * guarded the catalog JSON; late elevation writes and same-named tiles
 * from the last seed still landed on the globe.
 */
const epoch = Epoch.createEpoch();
/*
 * The picker's whole state. A tile is (face, level, i, j) — there is no
 * pixel position and no half-committed box here, which is what stops the
 * selection drifting away from the cursor.
 */
let grid = {level: 4, show: false, hover: null, picked: []};
const listeners = new Set();

function notify() {
    for (const fn of listeners) fn();
}

function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function isEnabled() {
    return enabled;
}

function setEnabled(on) {
    enabled = !!on;
    if (enabled) load();
    notify();
}

function setCropOn(name, on) {
    if (on) hidden.delete(name);
    else hidden.add(name);
    notify();
}

function cropOn(name) {
    return !hidden.has(name);
}

function getCatalog() {
    return catalog;
}

function belongsTo(crop, ctx) {
    return Epoch.belongsTo(crop, ctx || epoch.world());
}

function setContext(project, seed, variant) {
    const {changed} = epoch.begin({project, seed, variant});
    if (!changed) return;
    const world = epoch.world();
    jobs = [];
    /* Drop the last world's tiles immediately. Leaving them up until
     * the next fetch lands is how one world's crops sat on another. */
    const keep = catalog.crops.filter((c) => belongsTo(c, world));
    if (keep.length !== catalog.crops.length) {
        catalog = {seed: world.seed, lon0: catalog.lon0, project: world.project, variant: world.variant, crops: keep};
        notify();
    }
    load();
}

function setPlanet(id) {
    if (!epoch.setPlanet(id)) return;
    let any = false;
    for (const crop of catalog.crops) {
        if (crop.imageEl) {
            crop.imageEl = null;
            crop.planetId = null;
            any = true;
        }
    }
    if (any) notify();
}

function snapshot() {
    return epoch.snapshot();
}

function stillCurrent(asked) {
    return epoch.stillCurrent(asked);
}

function stillSameWorld(asked) {
    return epoch.stillSameWorld(asked);
}

function seedMatches(appSeed) {
    if (catalog.seed == null || catalog.seed === '') return true;
    return Epoch.sameSeed(catalog.seed, appSeed);
}

function shownCrops() {
    if (!enabled) return [];
    return catalog.crops.filter((c) => !hidden.has(c.name) && belongsTo(c, epoch.world()));
}

function visibleCrops() {
    return shownCrops().filter((c) => (
        (c.status === 'done' || !c.status) && (c.imageEl || c.elevM)
    ));
}

/*
 * Crops that have conditioning but no bake. They used to draw nothing at
 * all, so a tile you had exported and not yet baked was indistinguishable
 * from one that did not exist. They get an outline instead.
 */
function pendingCrops() {
    return shownCrops().filter((c) => (
        c.status && c.status !== 'done' && !c.imageEl && !c.elevM
    ));
}

function resolveImage(url) {
    if (!url) return url;
    if (/^(https?:|data:|blob:)/.test(url)) return url;
    if (apiUp && url.charAt(0) === '/') return TD_API + url;
    return url;
}

function applyCatalog(data, asked) {
    if (!epoch.stillCurrent(asked)) return Promise.resolve();
    const world = asked.world;
    const incoming = data && Array.isArray(data.crops)
        ? data.crops.map(normalizeCrop).filter((c) => belongsTo(c, world))
        : [];
    Epoch.adoptCaches(incoming, catalog.crops, world, epoch.planetId());
    catalog = {
        seed: data && data.seed != null ? data.seed : world.seed,
        lon0: data && Number.isFinite(data.lon0) ? data.lon0 : 0,
        project: world.project,
        variant: world.variant || null,
        crops: incoming,
    };
    jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
    loadState = catalog.crops.length || grid.picked.length ? 'ready' : 'empty';
    notify();
    return Promise.all(catalog.crops.filter((c) => !c.imageEl && !c.elevM).map((c) => loadCropData(c, asked))).then(() => {
        if (!epoch.stillSameWorld(asked)) return;
        notify();
    });
}

function loadFromCatalogFile(asked) {
    try {
        return applyCatalog(require('./.td-overlays/catalog.js'), asked);
    } catch {
        return applyCatalog({seed: null, lon0: 0, project: null, variant: null, crops: []}, asked);
    }
}

function load() {
    const asked = epoch.beginLoad();
    const world = asked.world;
    loadState = 'loading';
    const q = new URLSearchParams();
    if (world.project) q.set('project', world.project);
    if (world.seed != null && world.seed !== '') q.set('seed', String(world.seed));
    if (world.variant) q.set('variant', world.variant);
    const qs = q.toString();
    fetch(`${TD_API}/overlays.json${qs ? `?${qs}` : ''}`, {cache: 'no-store'})
        .then((res) => {
            if (!res.ok) throw new Error(String(res.status));
            apiUp = true;
            return res.json();
        })
        .then((data) => {
            if (!epoch.stillCurrent(asked)) return;
            apiTries = 0;
            return applyCatalog(data, asked);
        })
        .catch(() => {
            if (!epoch.stillCurrent(asked)) return;
            apiUp = false;
            const fallback = loadFromCatalogFile(asked);
            if (apiTries < 8) {
                apiTries += 1;
                setTimeout(() => {
                    if (!epoch.stillCurrent(asked) || apiUp) return;
                    loadState = 'idle';
                    load();
                }, 400);
            }
            return fallback;
        });
    return loadState;
}

function reload() {
    return load();
}

function normalizeCrop(raw) {
    const name = String(raw.name || '');
    /* A tile crop knows its own (face, level, i, j) and is drawn from that.
     * Crops baked before the grid existed have no tile and stay lon/lat
     * boxes — both shapes go on the map, neither pretends to be the other. */
    const tile = normalizeTile(raw.tile) || Cube.parseTileName(name);
    return {
        name,
        dir: raw.dir,
        project: raw.project || null,
        tile,
        west: Number(raw.west),
        south: Number(raw.south),
        east: Number(raw.east),
        north: Number(raw.north),
        image: resolveImage(raw.image),
        elev: resolveImage(raw.elev),
        elevWidth: raw.elevWidth | 0,
        elevHeight: raw.elevHeight | 0,
        elevM: null,
        planetId: null,
        loadError: null,
        status: raw.status || (raw.image && String(raw.image).includes('output.png') ? 'done' : null),
        seed: raw.seed,
        imageEl: null,
    };
}

function normalizeTile(raw) {
    if (!raw) return null;
    const {face, level, i, j} = raw;
    if (![face, level, i, j].every((v) => Number.isInteger(v))) return null;
    if (face < 0 || face > 5 || level < Cube.MIN_LEVEL || level > Cube.MAX_LEVEL) return null;
    const n = 1 << level;
    if (i < 0 || j < 0 || i >= n || j >= n) return null;
    return {face, level, i, j};
}

/*
 * Prefer the baked DEM in raw metres over the baked PNG.
 *
 * output.png was coloured once, on the machine that ran the bake, with
 * whatever the look was at that moment — so a tile could never follow the
 * map it sits on. The float dump carries elevation and nothing else, and the
 * app colours it with the same surface look the globe uses, every frame it
 * needs to. The PNG stays as the fallback for crops baked before the dump
 * existed.
 */
function liveCrop(name) {
    return catalog.crops.find((c) => c.name === name) || null;
}

function loadCropData(crop, asked) {
    if (crop.elev) return loadCropElev(crop, asked);
    if (crop.image) return loadCropImage(crop, asked);
    return Promise.resolve();
}

function loadCropElev(crop, asked) {
    const want = crop.elevWidth * crop.elevHeight * 4;
    const name = crop.name;
    const elev = crop.elev;
    const width = crop.elevWidth;
    const height = crop.elevHeight;
    const image = crop.image;
    return fetch(elev)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(String(res.status)))))
        .then((buf) => {
            if (!epoch.stillSameWorld(asked)) return;
            const live = liveCrop(name);
            if (!live || !Epoch.sameElev(live, {elev, elevWidth: width, elevHeight: height})) return;
            if (buf.byteLength < want) throw new Error(`elev dump is ${buf.byteLength} of ${want} bytes`);
            live.elevM = new Float32Array(buf, 0, width * height);
            live.loadError = null;
        })
        .catch((err) => {
            if (!epoch.stillSameWorld(asked)) return;
            const live = liveCrop(name);
            if (!live || !Epoch.sameElev(live, {elev, elevWidth: width, elevHeight: height})) return;
            live.loadError = String(err.message || err);
            /* A tile whose elevation will not load still has a picture. */
            return image ? loadCropImage(live, asked) : undefined;
        });
}

function loadCropImage(crop, asked) {
    const name = crop.name;
    const src = crop.image;
    return new Promise((resolve) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => {
            if (epoch.stillSameWorld(asked)) {
                const live = liveCrop(name);
                if (live && live.image === src) {
                    live.imageEl = downsample(img, MAX_IMAGE);
                    live.loadError = null;
                }
            }
            resolve();
        };
        img.onerror = () => {
            if (epoch.stillSameWorld(asked)) {
                const live = liveCrop(name);
                if (live && live.image === src) live.loadError = 'image failed to load';
            }
            resolve();
        };
        img.src = src;
    });
}

/*
 * Elevation to pixels. The app owns this, because colouring needs the same
 * `Look` the globe uses and the same climate fields underneath the tile.
 */
let surfacePainter = null;

function setSurfacePainter(fn) {
    surfacePainter = fn;
}

/* Drop every colouring so the next paint rebuilds it — after a look change,
 * a colormap change, or anything else that moves what the map looks like. */
function repaintSurfaces() {
    let any = false;
    for (const crop of catalog.crops) {
        if (crop.elevM && crop.imageEl) {
            crop.imageEl = null;
            any = true;
        }
    }
    if (any) notify();
}

/* imageEl is a paint cache. elevM is the DEM. Colouring must not write
 * the DEM — a throw here used to null elevM and the tile stayed blank. */
function surfaceFor(crop) {
    if (!belongsTo(crop, epoch.world())) return null;
    if (crop.imageEl && crop.planetId === epoch.planetId()) return crop.imageEl;
    if (!crop.elevM || !surfacePainter) return crop.imageEl || null;
    try {
        crop.imageEl = surfacePainter(crop);
        crop.planetId = epoch.planetId();
    } catch (err) {
        crop.loadError = String(err.message || err);
    }
    return crop.imageEl;
}

function downsample(img, max) {
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    if (scale >= 1) return img;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
}

function overlayCanvas() {
    let el = document.getElementById('td-overlay');
    if (el) return el;
    const src = document.getElementById('output');
    if (!src || !src.parentElement) return null;
    el = document.createElement('canvas');
    el.id = 'td-overlay';
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.pointerEvents = 'none';
    const parent = src.parentElement;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const plates = document.getElementById('plate-overlay');
    if (plates) plates.insertAdjacentElement('beforebegin', el);
    else src.insertAdjacentElement('afterend', el);
    return el;
}

function clipToCanvas(clip, width, height) {
    return {
        x: (clip.x * 0.5 + 0.5) * width,
        y: (-clip.y * 0.5 + 0.5) * height,
        front: clip.front,
        z: clip.z,
    };
}

function lonLatToXyz(lonDeg, latDeg) {
    const lon = lonDeg * Math.PI / 180;
    const lat = latDeg * Math.PI / 180;
    const cl = Math.cos(lat);
    return [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
}

function projectGlobe(xyz, projection) {
    const p = vec4.transformMat4([], [xyz[0], xyz[1], xyz[2], 1], projection);
    const w = p[3] || 1;
    return {x: p[0] / w, y: p[1] / w, z: p[2] / w, front: p[2] / w <= 0.02};
}

function lonLatToEquirectClip(lonDeg, latDeg, view, xshift) {
    const lonRad = lonDeg * Math.PI / 180 + xshift * Math.PI;
    const latRad = latDeg * Math.PI / 180;
    return {
        x: ((lonRad / Math.PI) + view.equirectPanX) * view.equirectZoom,
        y: ((2 * latRad / Math.PI) + view.equirectPanY) * view.equirectZoom,
        front: true,
    };
}

function splitBoxes(crop) {
    const {west, south, east, north} = crop;
    if (east >= west) return [{west, south, east, north}];
    return [
        {west, south, east: 180, north},
        {west: -180, south, east, north},
    ];
}

function colorFor(name) {
    const i = catalog.crops.findIndex((c) => c.name === name);
    return COLORS[((i >= 0 ? i : 0) % COLORS.length)];
}

function paint(view) {
    const el = overlayCanvas();
    const src = document.getElementById('output');
    if (!el || !src) return;
    if (!enabled) {
        if (el.width !== 1 || el.height !== 1) {
            el.width = 1;
            el.height = 1;
        }
        el.style.display = 'none';
        return;
    }
    const crops = visibleCrops();
    const pending = pendingCrops();
    const chrome = grid.show || grid.picked.length > 0;
    if (!crops.length && !pending.length && !chrome) {
        if (el.width !== 1 || el.height !== 1) {
            el.width = 1;
            el.height = 1;
        }
        el.style.display = 'none';
        return;
    }
    el.style.display = 'block';
    if (el.width !== src.width) el.width = src.width;
    if (el.height !== src.height) el.height = src.height;
    const ctx = el.getContext('2d');
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (view.viewMode === 'equirect') {
        for (const shift of [-2, 0, 2]) {
            for (const crop of crops) paintEquirectCrop(ctx, crop, view, el.width, el.height, shift);
            /* Dashed: conditioning written, bake not run. */
            for (const crop of pending) paintEquirectCrop(ctx, crop, view, el.width, el.height, shift, true);
        }
    } else {
        for (const crop of crops) paintGlobeCrop(ctx, crop, view, el.width, el.height);
        for (const crop of pending) paintGlobeCrop(ctx, crop, view, el.width, el.height);
    }
    if (chrome) paintGridChrome(ctx, view, el.width, el.height);
}

/*
 * One projector for both views, so the grid, the ghost and the selection are
 * drawn by the same code on the globe and on the equirect. `front` is what
 * the globe uses to drop the far hemisphere; the equirect is always front.
 */
function projector(view, width, height, xshift) {
    let project;
    if (view.viewMode === 'equirect') {
        project = (lon, lat) => clipToCanvas(lonLatToEquirectClip(lon, lat, view, xshift || 0), width, height);
    } else {
        const projection = view.globeProjection;
        project = (lon, lat) => clipToCanvas(projectGlobe(lonLatToXyz(lon, lat), projection), width, height);
    }
    /* Whether this view has an antimeridian seam a path has to be cut at.
     * The globe does not; the equirect does. */
    project.wraps = view.viewMode === 'equirect';
    return project;
}

/* Shifts to draw at: the equirect repeats east and west, the globe does not. */
/*
 * Which wrapped copies can actually reach the screen. The equirect repeats
 * every 2 clip units; a copy is worth drawing when its longitude span still
 * overlaps the view. Exact interval arithmetic, so this never flickers — it
 * only ever drops copies that are provably off screen.
 */
function paintShifts(view) {
    if (view.viewMode !== 'equirect') return [0];
    const zoom = view.equirectZoom || 1;
    const panX = view.equirectPanX || 0;
    const half = 1 / zoom;
    const out = [];
    for (const shift of [-2, 0, 2]) {
        const lo = -half - panX - shift;
        const hi = half - panX - shift;
        if (hi >= -1 && lo <= 1) out.push(shift);
    }
    return out.length ? out : [0];
}

/*
 * Stroke a lon/lat polyline, breaking it where it leaves the visible globe
 * or jumps the antimeridian. Without the break a wrapping tile edge draws as
 * a stripe straight across the map.
 */
function strokeLonLatPath(ctx, project, pts) {
    let started = false;
    let prevLon = null;
    for (const p of pts) {
        /*
         * Break only where the path really crosses the antimeridian, which is
         * a jump in *longitude* and nothing to do with how far apart the two
         * points land on screen. This used to compare pixels against half the
         * canvas width, and at high zoom that is smaller than one ordinary
         * segment — so zooming in silently chopped the grid to pieces, worse
         * the further in you went. Longitude does not change with the view,
         * so this cuts the same places at every zoom.
         *
         * Only the equirect has a seam. On the globe the same step is a
         * perfectly continuous path and must not be cut.
         */
        const wrapped = project.wraps && prevLon !== null && Math.abs(p.lon - prevLon) > 180;
        prevLon = p.lon;
        const q = project(p.lon, p.lat);
        if (q.front === false || wrapped) {
            started = false;
            continue;
        }
        if (!started) {
            ctx.moveTo(q.x, q.y);
            started = true;
        } else {
            ctx.lineTo(q.x, q.y);
        }
    }
}

function tilePath(ctx, project, tile, steps) {
    strokeLonLatPath(ctx, project, Cube.tileOutline(tile, steps));
}

/* Roughly how many pixels a tile covers, for culling and for deciding how
 * finely to sample its curved edges. Negative means it is off-screen. */
function tileScreenSize(project, tile, width, height) {
    const [nw, ne, se, sw] = Cube.tileCorners(tile);
    const a = project(nw.lon, nw.lat);
    const b = project(ne.lon, ne.lat);
    const c = project(se.lon, se.lat);
    const d = project(sw.lon, sw.lat);
    if ([a, b, c, d].every((p) => p.front === false)) return -1;
    /* All four corners, and an overlap test rather than a containment one —
     * a tile zoomed in past the edges of the view encloses it, and must not
     * read as off-screen. */
    const xs = [a.x, b.x, c.x, d.x];
    const ys = [a.y, b.y, c.y, d.y];
    if (Math.max(...xs) < -32 || Math.min(...xs) > width + 32) return -1;
    if (Math.max(...ys) < -32 || Math.min(...ys) > height + 32) return -1;
    return Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - b.x, c.y - b.y));
}

/*
 * The grid, the hover ghost and the picked tiles.
 *
 * The grid is drawn as one lattice of lines per face rather than as a rect
 * per tile: same picture, a fraction of the path work, and no doubled stroke
 * on shared edges.
 */
function paintGridChrome(ctx, view, width, height) {
    ctx.save();
    for (const shift of paintShifts(view)) {
        const project = projector(view, width, height, shift);
        if (grid.show) paintGridLines(ctx, project, view, width, height);
        for (const tile of grid.picked) paintTileFill(ctx, project, tile, width, height, PICK_FILL, PICK_LINE);
        if (grid.hover && !isPicked(grid.hover)) {
            paintTileFill(ctx, project, grid.hover, width, height, HOVER_FILL, HOVER_LINE);
        }
    }
    ctx.restore();
}

/*
 * The grid, drawn whole: every face, every line, at every viewpoint.
 *
 * There is deliberately no visibility probe and no minimum-cell-size test
 * here. Both were tried and both made the grid flicker, for the same reason:
 * they turn a smoothly varying measurement — a probe tile's pixel size,
 * whether a sampled point lands on a face — into a binary draw/skip, so the
 * lines pop in and out as the view moves. A grid you cannot trust to be
 * there is worse than one that costs a few thousand extra projections.
 *
 * What culls is exact and per-point: the globe's own back-face test drops
 * the far hemisphere, the seam test breaks wrapping lines, and the canvas
 * clips the rest. None of those depend on where the view happens to sit.
 */
function paintGridLines(ctx, project, view, width, height) {
    const n = 1 << grid.level;
    const steps = GRID_SEGMENTS_PER_TILE * n;
    /* Build the path once and stroke it twice. The canvas keeps the current
     * path across stroke(), and projecting every point again for the second
     * colour was half the cost of the whole overlay. */
    ctx.beginPath();
    for (let face = 0; face < 6; face++) {
        for (let k = 0; k <= n; k++) {
            const t = -1 + 2 * k / n;
            strokeLonLatPath(ctx, project, faceLine(face, t, null, -1, 1, steps));
            strokeLonLatPath(ctx, project, faceLine(face, null, t, -1, 1, steps));
        }
    }
    /* Dark under, light over: the grid has to stay legible over ocean and
     * over snow, and neither colour alone manages both. */
    ctx.strokeStyle = GRID_LINE_DARK;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.stroke();
}

/* One grid line across part of a face: a fixed and b running from t0 to t1,
 * or the other way round. */
function faceLine(face, a, b, t0, t1, steps) {
    const pts = [];
    const count = Math.max(1, Math.min(512, steps));
    for (let k = 0; k <= count; k++) {
        const t = t0 + (t1 - t0) * (k / count);
        pts.push(Cube.xyzToLonLat(Cube.faceDirection(face, a == null ? t : a, b == null ? t : b)));
    }
    return pts;
}

function paintTileFill(ctx, project, tile, width, height, fill, stroke) {
    if (tileScreenSize(project, tile, width, height) < 0) return;
    /* The same subdivision the grid uses, so a picked tile's border lies
     * exactly on the grid line under it instead of drifting off it as the
     * view changes. */
    ctx.beginPath();
    tilePath(ctx, project, tile, GRID_SEGMENTS_PER_TILE);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
}

function paintEquirectCrop(ctx, crop, view, width, height, xshift, dashed) {
    /* A tile is a square in face space, so its edges are curves here, not a
     * rectangle. Only the legacy lon/lat crops can take the cheap blit. */
    if (crop.tile) {
        paintTileCrop(ctx, crop, projector(view, width, height, xshift), width, height, dashed);
        return;
    }
    const img = surfaceFor(crop);
    const stroke = colorFor(crop.name);
    const chrome = dashed || !img;
    for (const box of splitBoxes(crop)) {
        const nw = clipToCanvas(lonLatToEquirectClip(box.west, box.north, view, xshift), width, height);
        const se = clipToCanvas(lonLatToEquirectClip(box.east, box.south, view, xshift), width, height);
        const w = se.x - nw.x;
        const h = se.y - nw.y;
        if (!(w > 1 && h > 1)) continue;
        if (se.x < -8 || nw.x > width + 8 || se.y < -8 || nw.y > height + 8) continue;
        if (img && crop.east !== crop.west) {
            const sx = ((box.west - crop.west) / (crop.east - crop.west)) * img.width;
            const sw = ((box.east - box.west) / (crop.east - crop.west)) * img.width;
            ctx.drawImage(img, sx, 0, sw, img.height, nw.x, nw.y, w, h);
        }
        if (!chrome) continue;
        ctx.save();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        if (dashed) ctx.setLineDash([6, 4]);
        ctx.strokeRect(nw.x + 0.5, nw.y + 0.5, w - 1, h - 1);
        ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.fillStyle = stroke;
        const label = crop.name;
        const lx = nw.x + 5;
        const ly = nw.y - 3;
        ctx.strokeText(label, lx, ly);
        ctx.fillText(label, lx, ly);
        ctx.restore();
    }
}

/*
 * A baked tile, drawn through its own face mapping. Same treatment on the
 * globe and the equirect — the projector is the only difference — because
 * the image is a square in face space in both, and stretching it into a
 * lon/lat rectangle is exactly the mis-registration the grid exists to end.
 */
function paintTileCrop(ctx, crop, project, width, height, dashed) {
    const px = tileScreenSize(project, crop.tile, width, height);
    if (px < 0) return;
    /* Colour only what is on screen — a tile is a few megabytes of float. */
    const img = surfaceFor(crop);
    const stroke = colorFor(crop.name);
    const chrome = dashed || !img;
    const n = Math.max(2, Math.min(24, Math.round(px / 24)));
    if (img) {
        const at = (s, t) => Cube.tileLonLat(crop.tile, s, t);
        for (let iy = 0; iy < n; iy++) {
            const t0 = iy / n;
            const t1 = (iy + 1) / n;
            for (let ix = 0; ix < n; ix++) {
                const s0 = ix / n;
                const s1 = (ix + 1) / n;
                const p0 = at(s0, t0);
                const p1 = at(s1, t0);
                const p2 = at(s1, t1);
                const p3 = at(s0, t1);
                const a = project(p0.lon, p0.lat);
                const b = project(p1.lon, p1.lat);
                const c = project(p2.lon, p2.lat);
                const d = project(p3.lon, p3.lat);
                if (a.front === false || b.front === false || c.front === false || d.front === false) continue;
                /* A cell straddling the seam would smear across the map; the
                 * shifted copies draw it properly on their own pass. */
                if (Math.max(a.x, b.x, c.x, d.x) - Math.min(a.x, b.x, c.x, d.x) > width / 2) continue;
                const ua = {x: s0 * img.width, y: t0 * img.height};
                const ub = {x: s1 * img.width, y: t0 * img.height};
                const uc = {x: s1 * img.width, y: t1 * img.height};
                const ud = {x: s0 * img.width, y: t1 * img.height};
                drawMappedTriangle(ctx, img, a, b, d, ua, ub, ud);
                drawMappedTriangle(ctx, img, b, c, d, ub, uc, ud);
            }
        }
    }
    if (!chrome) return;
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    tilePath(ctx, project, crop.tile, GRID_SEGMENTS_PER_TILE);
    ctx.closePath();
    ctx.stroke();
    const [nw] = Cube.tileCorners(crop.tile);
    const label = project(nw.lon, nw.lat);
    if (label.front !== false) {
        ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.fillStyle = stroke;
        ctx.strokeText(crop.name, label.x + 4, label.y - 3);
        ctx.fillText(crop.name, label.x + 4, label.y - 3);
    }
    ctx.restore();
}

function paintGlobeCrop(ctx, crop, view, width, height) {
    if (crop.tile) {
        paintTileCrop(ctx, crop, projector(view, width, height, 0), width, height, false);
        return;
    }
    const img = surfaceFor(crop);
    const projection = view.globeProjection;
    const stroke = colorFor(crop.name);
    const zoom = view.zoom || 1;
    const nx = Math.min(48, Math.max(GLOBE_STEPS, Math.round(6 * Math.sqrt(zoom))));
    const ny = Math.max(4, Math.round(nx * (crop.north - crop.south) / Math.max(0.2, crop.east - crop.west)));

    const project = (lon, lat) => clipToCanvas(
        projectGlobe(lonLatToXyz(lon, lat), projection),
        width, height,
    );

    ctx.save();
    if (img) for (let iy = 0; iy < ny; iy++) {
        const t0 = iy / ny;
        const t1 = (iy + 1) / ny;
        const lat0 = crop.north + (crop.south - crop.north) * t0;
        const lat1 = crop.north + (crop.south - crop.north) * t1;
        for (let ix = 0; ix < nx; ix++) {
            const s0 = ix / nx;
            const s1 = (ix + 1) / nx;
            const lon0 = crop.west + (crop.east - crop.west) * s0;
            const lon1 = crop.west + (crop.east - crop.west) * s1;
            const a = project(lon0, lat0);
            const b = project(lon1, lat0);
            const c = project(lon1, lat1);
            const d = project(lon0, lat1);
            if (!a.front && !b.front && !c.front && !d.front) continue;
            const ua = {x: s0 * img.width, y: t0 * img.height};
            const ub = {x: s1 * img.width, y: t0 * img.height};
            const uc = {x: s1 * img.width, y: t1 * img.height};
            const ud = {x: s0 * img.width, y: t1 * img.height};
            drawMappedTriangle(ctx, img, a, b, d, ua, ub, ud);
            drawMappedTriangle(ctx, img, b, c, d, ub, uc, ud);
        }
    }
    ctx.restore();

    if (img) return;

    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    const edge = edgePoints(crop, 24);
    for (const p of edge) {
        const q = project(p.lon, p.lat);
        if (!q.front) {
            started = false;
            continue;
        }
        if (!started) {
            ctx.moveTo(q.x, q.y);
            started = true;
        } else {
            ctx.lineTo(q.x, q.y);
        }
    }
    ctx.stroke();
    const labelAt = project((crop.west + crop.east) / 2, crop.north);
    if (labelAt.front) {
        ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.fillStyle = stroke;
        ctx.strokeText(crop.name, labelAt.x, labelAt.y - 4);
        ctx.fillText(crop.name, labelAt.x, labelAt.y - 4);
    }
    ctx.restore();
}

function edgePoints(crop, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push({lon: crop.west + (crop.east - crop.west) * (i / n), lat: crop.north});
    for (let i = 1; i <= n; i++) pts.push({lon: crop.east, lat: crop.north + (crop.south - crop.north) * (i / n)});
    for (let i = 1; i <= n; i++) pts.push({lon: crop.east + (crop.west - crop.east) * (i / n), lat: crop.south});
    for (let i = 1; i <= n; i++) pts.push({lon: crop.west, lat: crop.south + (crop.north - crop.south) * (i / n)});
    return pts;
}

/* Affine map of a source triangle onto a dest triangle, then clip. */
function drawMappedTriangle(ctx, img, d0, d1, d2, s0, s1, s2) {
    const denom = s0.x * (s1.y - s2.y) - s1.x * (s0.y - s2.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(denom) < 1e-6) return;
    const x0 = d0.x, y0 = d0.y, x1 = d1.x, y1 = d1.y, x2 = d2.x, y2 = d2.y;
    const u0 = s0.x, v0 = s0.y, u1 = s1.x, v1 = s1.y, u2 = s2.x, v2 = s2.y;
    const m11 = -(v0 * (x2 - x1) - v1 * x2 + v2 * x1 + (v1 - v2) * x0) / denom;
    const m12 = (v1 * y2 + v0 * (y1 - y2) - v2 * y1 + (v2 - v1) * y0) / denom;
    const m21 = (u0 * (x2 - x1) - u1 * x2 + u2 * x1 + (u1 - u2) * x0) / denom;
    const m22 = -(u1 * y2 + u0 * (y1 - y2) - u2 * y1 + (u2 - u1) * y0) / denom;
    const dx = (u0 * (v2 * x1 - v1 * x2) + v0 * (u1 * x2 - u2 * x1) + (u2 * v1 - u1 * v2) * x0) / denom;
    const dy = (u0 * (v2 * y1 - v1 * y2) + v0 * (u1 * y2 - u2 * y1) + (u2 * v1 - u1 * v2) * y0) / denom;
    if (![m11, m12, m21, m22, dx, dy].every(Number.isFinite)) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.closePath();
    ctx.clip();
    ctx.transform(m11, m12, m21, m22, dx, dy);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
}

function renderCropList(host, {onToggle, onFrame, onBake, onClearDraft, onLevel, seed, radiusKm, scaleKm, minCells, maxCells}) {
    if (!host) return;
    host.replaceChildren();
    host.append(note('Hold shift to see the tile grid. Click a tile, or drag across several.'));
    if (!apiUp) {
        host.append(note('Bake server is off. Use bun run dev so jobs can run.'));
    }
    host.append(levelRow(onLevel, radiusKm, scaleKm, minCells, maxCells));
    if (grid.picked.length) {
        const cells = Cube.tileCells(grid.level, radiusKm, scaleKm);
        const edge = Cube.tileEdgeKm(grid.level, radiusKm);
        const already = grid.picked.filter((t) => bakedTile(t)).length;
        host.append(note(
            `${grid.picked.length} tile${grid.picked.length === 1 ? '' : 's'} · `
            + `${cells}×${cells} cells each · ${Math.round(edge)} km across`,
        ));
        if (already) host.append(note(`${already} already baked — baking again replaces them.`));
        const bake = document.createElement('button');
        bake.type = 'button';
        bake.textContent = grid.picked.length === 1 ? 'Bake tile' : `Bake ${grid.picked.length} tiles`;
        bake.disabled = !apiUp;
        bake.addEventListener('click', () => onBake && onBake());
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.textContent = 'Clear';
        clear.addEventListener('click', () => onClearDraft && onClearDraft());
        const actions = document.createElement('div');
        actions.className = 'row';
        actions.append(bake, clear);
        host.append(actions);
    }
    /* What the bake is actually doing, per tile. Without this a multi-minute
     * job looks identical to a job that never started. Progress ticks go
     * through syncJobRows so the bar can move without rebuilding the list. */
    const jobBox = document.createElement('div');
    jobBox.className = 'td-jobs';
    host.append(jobBox);
    syncJobRows(host);
    if (loadState === 'idle' || loadState === 'loading') {
        if (!grid.picked.length) host.append(note('Looking for baked crops…'));
        return;
    }
    if (!catalog.crops.length && !grid.picked.length) {
        host.append(note('No baked crops yet.'));
        return;
    }
    const world = epoch.world();
    const wrongProject = catalog.crops.some((c) => c.project && world.project && c.project !== world.project);
    if (wrongProject) {
        host.append(note('These tiles belong to another project.'));
    } else if (catalog.seed && !seedMatches(seed)) {
        host.append(note(`Baked for ${catalog.seed} — shuffle back to place them.`));
    } else if (catalog.seed) {
        host.append(note(`Baked for ${catalog.seed}`));
    }
    for (const crop of catalog.crops) {
        const row = document.createElement('label');
        row.className = 'check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !hidden.has(crop.name);
        box.addEventListener('input', () => onToggle(crop.name, box.checked));
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'td-frame';
        /* Say what the crop *is*, not an internal status word. "conditioned"
         * means the model's inputs are written but the bake has not run. */
        const suffix = crop.status === 'done' ? '' : ' — not baked';
        go.textContent = `${crop.name}${suffix}`;
        go.title = crop.status === 'done'
            ? 'Frame this tile on the equirect'
            : 'Conditioning is written, but this tile has not been baked yet';
        go.addEventListener('click', () => onFrame(crop));
        row.append(box, go);
        host.append(row);
        /* A crop that cannot draw has to say why, instead of just not
         * appearing on the map. */
        if (crop.loadError) host.append(note(`${crop.name}: ${crop.loadError}`));
    }
}

function note(text) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = text;
    return span;
}

const JOB_STAGE = {
    exporting: 'writing conditioning',
    queued: 'queued',
    baking: 'baking',
    preview: 'building preview',
    error: 'failed',
};

function jobId(job) {
    return job.id || job.name;
}

function jobLabel(job) {
    const stage = JOB_STAGE[job.status] || job.status;
    const pct = Number.isFinite(job.progress) ? ` ${job.progress}%` : '';
    return `${job.name} · ${stage}${pct}${job.error ? ` — ${job.error}` : ''}`;
}

function jobRow(job) {
    const row = document.createElement('div');
    row.className = 'td-job';
    row.dataset.job = jobId(job);
    row.append(note(jobLabel(job)));
    updateJobBar(row, job);
    return row;
}

function updateJobBar(row, job) {
    let track = row.querySelector('.td-bar');
    /* A bar, because a percentage that only ticks every few seconds reads as
     * frozen while a bar visibly holds its ground. Keep the same fill node so
     * the width transition can run. */
    if (job.status === 'baking' && Number.isFinite(job.progress)) {
        if (!track) {
            track = document.createElement('div');
            track.className = 'td-bar';
            track.append(document.createElement('div'));
            row.append(track);
        }
        track.firstElementChild.style.width = `${Math.max(2, Math.min(100, job.progress))}%`;
    } else if (track) {
        track.remove();
    }
}

function syncJobRows(host) {
    if (!host) return;
    let box = host.querySelector('.td-jobs');
    if (!box) {
        box = document.createElement('div');
        box.className = 'td-jobs';
        host.append(box);
    }
    const active = jobs.filter((j) => j.status !== 'done');
    const keep = new Set(active.map(jobId));
    for (const el of [...box.children]) {
        if (!keep.has(el.dataset.job)) el.remove();
    }
    for (const job of active) {
        const id = jobId(job);
        let row = null;
        for (const el of box.children) {
            if (el.dataset.job === id) {
                row = el;
                break;
            }
        }
        if (!row) {
            box.append(jobRow(job));
            continue;
        }
        const label = row.querySelector('.muted');
        if (label) label.textContent = jobLabel(job);
        updateJobBar(row, job);
    }
}

function jobsChanged(next) {
    if (next.length !== jobs.length) return true;
    const prev = new Map(jobs.map((j) => [jobId(j), j]));
    return next.some((j) => {
        const old = prev.get(jobId(j));
        return !old
            || old.status !== j.status
            || old.progress !== j.progress
            || old.error !== j.error
            || old.name !== j.name;
    });
}

function applyJobs(next) {
    const list = Array.isArray(next) ? next : [];
    if (!jobsChanged(list)) return jobs;
    jobs = list;
    notify({jobs: true});
    return jobs;
}

function pollJobs() {
    const asked = epoch.snapshot();
    const world = asked.world;
    const q = new URLSearchParams();
    if (world.project) q.set('project', world.project);
    if (world.variant) q.set('variant', world.variant);
    const qs = q.toString();
    return fetch(`${TD_API}/jobs${qs ? `?${qs}` : ''}`, {cache: 'no-store'})
        .then((res) => {
            if (!res.ok) throw new Error(String(res.status));
            apiUp = true;
            return res.json();
        })
        .then((data) => {
            if (!epoch.stillSameWorld(asked)) return jobs;
            return applyJobs(data && data.jobs);
        });
}

/*
 * Only the levels that make a sane bake are offered: fewer cells than the
 * model can condition on is a waste of a job, more than the server's cap is
 * not a preview any more. Want a bigger area — pick more tiles.
 */
function levelRow(onLevel, radiusKm, scaleKm, minCells, maxCells) {
    const row = document.createElement('div');
    row.className = 'row';
    const levels = Cube.usableLevels(radiusKm, scaleKm, minCells, maxCells);
    const label = note(`Tile ${Math.round(Cube.tileEdgeKm(grid.level, radiusKm))} km`);
    for (const [text, delta, title] of [['−', -1, 'Bigger tiles'], ['+', 1, 'Smaller tiles']]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = text;
        btn.title = title;
        btn.disabled = !levels.includes(grid.level + delta);
        btn.addEventListener('click', () => onLevel && onLevel(grid.level + delta));
        row.append(btn);
    }
    row.append(label);
    return row;
}

function frameView(crop) {
    const midLon = (crop.west + crop.east) / 2;
    const midLat = (crop.south + crop.north) / 2;
    const spanX = Math.max(0.02, (crop.east - crop.west) / 180);
    const spanY = Math.max(0.02, (crop.north - crop.south) / 90);
    return {
        viewMode: 'equirect',
        equirectPanX: -midLon / 180,
        equirectPanY: -2 * midLat / 180,
        equirectZoom: Math.min(TdTile.ZOOM_MAX, 0.92 / Math.max(spanX, spanY)),
    };
}

/*
 * The picker. Every one of these is a whole-state assignment rather than a
 * nudge, so a redraw can never catch the selection halfway between two
 * meanings — which is how the old drag ended up trailing the cursor.
 */
function setGridLevel(level) {
    const next = Cube.clampLevel(level);
    if (next === grid.level) return;
    /* Keep what is picked pointing at the same ground, at the new level. */
    grid.level = next;
    grid.picked = [];
    grid.hover = null;
    notify();
}

function getGridLevel() {
    return grid.level;
}

/*
 * These two report whether anything changed and deliberately do not notify:
 * they run on pointer move, and rebuilding the panel's DOM every time the
 * cursor crosses a tile would churn it for no reason. The caller redraws the
 * canvas, which is the only thing a hover affects.
 */
function setGridShown(on) {
    const next = !!on;
    if (next === grid.show) return false;
    grid.show = next;
    if (!next) grid.hover = null;
    return true;
}

function isGridShown() {
    return grid.show;
}

function setHoverTile(tile) {
    if (tile ? Cube.sameTile(tile, grid.hover) : !grid.hover) return false;
    grid.hover = tile || null;
    return true;
}

function getHoverTile() {
    return grid.hover;
}

function setPicked(tiles) {
    grid.picked = (tiles || []).filter(Boolean);
    notify();
}

function getPicked() {
    return grid.picked;
}

function togglePicked(tile) {
    if (!tile) return;
    const without = grid.picked.filter((t) => !Cube.sameTile(t, tile));
    grid.picked = without.length === grid.picked.length ? grid.picked.concat([tile]) : without;
    notify();
}

function isPicked(tile) {
    return grid.picked.some((t) => Cube.sameTile(t, tile));
}

function clearPicked() {
    if (!grid.picked.length) return;
    grid.picked = [];
    notify();
}

/* A tile already on disk for this project, if any — so the picker can say
 * "baked" rather than silently queueing the same ground twice. */
function bakedTile(tile) {
    const name = Cube.tileName(tile);
    return catalog.crops.find((c) => c.name === name && belongsTo(c, epoch.world())) || null;
}

function getJobs() {
    return jobs;
}

function isApiUp() {
    return apiUp;
}

module.exports = {
    TD_API,
    load,
    reload,
    setContext,
    setPlanet,
    snapshot,
    stillCurrent,
    stillSameWorld,
    paint,
    isEnabled,
    setEnabled,
    setCropOn,
    cropOn,
    getCatalog,
    onChange,
    renderCropList,
    frameView,
    setGridLevel,
    getGridLevel,
    setGridShown,
    isGridShown,
    setHoverTile,
    getHoverTile,
    setPicked,
    getPicked,
    togglePicked,
    isPicked,
    clearPicked,
    bakedTile,
    setSurfacePainter,
    repaintSurfaces,
    getJobs,
    applyJobs,
    pollJobs,
    syncJobRows,
    isApiUp,
};
