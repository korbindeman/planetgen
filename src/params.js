/*
 * The parameter registry.
 *
 * Every knob the generator has, in one table, with the metadata the values
 * themselves cannot carry: what unit it is in, what range of it produces a
 * plausible planet, and the pretty name the interface shows. A label is
 * what puts a knob in the default interface.
 *
 * This is deliberately a leaf. It reads DEFAULTS from each module and adds
 * a layer on top; no module requires it back. Values and their reasoning
 * stay where they are, next to the code that uses them. Nothing here can
 * change what the generator produces.
 *
 * Three invariants, all checked on load:
 *
 *   1. The registry's key set equals the module's DEFAULTS key set. Add a
 *      parameter without registering it and requiring this file throws, so
 *      the table cannot silently fall behind.
 *   2. A parameter with no calibrated `range` cannot be sampled. That is
 *      what makes "shuffle always looks good" structural rather than hoped
 *      for: the sampler can only reach values somebody has vouched for.
 *   3. Every exposed knob has a unique pretty name. The interface shows
 *      that, never the camelCase key.
 *
 * `range: null` therefore means "not calibrated yet", not "no limits". It
 * is the worklist, and it is most of the table today.
 */

const Tectonics = require('./tectonics');
const Climate = require('./climate');
const Detail = require('./detail');
const World = require('./world');
const EarthFixture = require('./earth-fixture');


/* Units. Anything ending in /step or /cell is a rate written against the
 * simulation's bookkeeping rather than against the world: /step means per
 * `stepMyr`, /cell means per mesh cell, whose size in km depends on both
 * the mesh resolution and the planet's radius. Those are the parameters
 * that silently change meaning when the history length, the mesh size or
 * the planet changes, so they have to be normalised before any range
 * written against them can be trusted. `needsNormalisation()` lists them.
 */
const UNITS = [
    '1',            // dimensionless gain or weight
    'frac',         // 0..1 share
    'count',
    'rad', 'deg',
    'km', 'm',
    'Myr', 'step', 'Gyr', 'h',
    'index',        // an iteration count
    'temp',         // the climate model's internal temperature axis
    'bool',
    '/step', 'km/step', 'm/step',
    '/cell',
];

/* p(unit, range, label) — range null means uncalibrated, so unshufflable.
 * A label puts the knob in the default interface. No label, not shown. */
function p(unit, range = null, label = null) {
    if (!UNITS.includes(unit)) throw new Error(`params: unknown unit "${unit}"`);
    if (range && !(range.length === 2 && range[0] < range[1])) {
        throw new Error(`params: bad range ${JSON.stringify(range)}`);
    }
    if (label != null && (typeof label !== 'string' || !label.trim())) {
        throw new Error(`params: label must be a non-empty string`);
    }
    const trimmed = label ? label.trim() : '';
    return {unit, range, exposed: !!trimmed, label: trimmed};
}


/* ---------------------------------------------------------------- tectonics */

const TECTONICS = {
    history: {
        steps:   p('step', [10, 60], 'Steps'),
        plates:  p('count', [5, 40], 'Plates'),
        stepMyr: p('Myr'),
    },

    plates: {
        nucleusSeparation:   p('rad'),
        sitesPerPlate:       p('count'),
        boundaryWarp:        p('1'),
        speckCells:          p('count'),
        microplateElongation: p('1'),
        microplateSpin:      p('1'),
        microplateSeparation: p('rad'),
        boundaryWarpScale:   p('1'),
        marginToll:          p('1'),
        siteToll:            p('rad'),
        continentalDrag:     p('1'),
        continentPlateMin:   p('frac'),
        plateGrowth:         p('/step'),
        plateReversion:      p('/step'),
        plateRetireArea:     p('frac'),
        weldContact:         p('frac'),
        contactDecay:        p('/step'),
        backArcChance:       p('/step'),
        riftChance:          p('/step'),
        riftMinArea:         p('frac'),
        healPasses:          p('count'),
        minFragment:         p('frac'),
    },

    continents: {
        cratons:            p('count', [3, 10], 'Cratons'),
        cratonSigma:        p('1'),
        cratonWarp:         p('1'),
        cratonElongation:   p('1'),
        cratonTaper:        p('1'),
        continentBlocks:    p('1'),
        blockSpread:        p('1'),
        sutures:            p('1'),
        sutureWidth:        p('1'),
        sutureBeltKm:       p('km'),
        sutureSagKm:        p('km'),
        oceanGap:           p('rad'),
        blockFacets:        p('1'),
        cratonClustering:   p('frac'),
        cratonMinSeparation: p('rad'),
        crustSmoothing:     p('count'),
        /* The share of the surface born as continental crust. Rifting eats
         * some of it over the run and only `emergentFraction` of what is
         * left stands above water, so this is not the land fraction you see.
         * Earth is ~0.41; the range spans that with room either side. */
        continentFraction:  p('frac', [0.30, 0.60], 'Continent fraction'),
    },

    coast: {
        facetCalm:      p('1'),
        gulfCut:        p('1'),
        bayCut:         p('1'),
        coastGrain:     p('1'),
        coastOctave:    p('rad'),
        shelfVary:      p('1'),
        cratonShatter:  p('1'),
        coastContrast:  p('1'),
        coastBlend:     p('count'),
        detailNoise:    p('1'),
    },

    water: {
        /* How full the ocean basin is. Dry share is an output. Initialize
         * as buckets (dry, Earth seas, ocean world); this number is the
         * dial those buckets clamp. */
        seaLevelThicknessKm: p('km', [24, 34], 'Water'),
    },

    crust: {
        crustReferenceKm:    p('km'),
        crustOceanKm:        p('km'),
        crustMinKm:          p('km'),
        crustShelfKm:        p('km'),
        crustTypeKm:         p('km'),
        crustMaxKm:          p('km'),
        coastalPlain:        p('frac'),
        shelfThinningKm:     p('km/step'),
        collisionThickenKm:  p('km/step'),
        collisionThrust:     p('frac'),
        riftThinKm:          p('km/step'),
        riftIntactShare:     p('frac'),
        riftCratonShare:     p('frac'),
        emergentFraction:    p('frac'),
    },

    relief: {
        orogenyDecay:     p('/step'),
        orogenyReliefM:   p('m'),
        rootRelax:        p('/step'),
        orogenyAndean:    p('1'),
        orogenyCollision: p('1'),
    },

    volcanism: {
        arcUpliftM:          p('m'),
        arcOceanic:          p('1'),
        arcContinental:      p('1'),
        arcCrestM:           p('m'),
        arcEmergeThreshold:  p('1'),
        /* Earth carries roughly ten major plumes. Zero is a legitimate
         * planet, not a degenerate one: no plumes means no island chains. */
        hotspots:            p('count', [0, 8], 'Hotspots'),
        hotspotRadius:       p('rad'),
        hotspotStrength:     p('/step'),
        hotspotDecay:        p('/step'),
        hotspotUpliftM:      p('m'),
        arcRibbonM:          p('m'),
        ridgePlateauM:       p('m'),
        arcRemnantMyr:       p('Myr'),
    },

    polar: {
        polarStraits:       p('bool', null, 'Polar straits'),
        polarCapLat:        p('deg'),
        polarCapLand:       p('frac'),
        polarStraitLat:     p('deg'),
        polarStraitBand:    p('deg'),
        polarStraitM:       p('m'),
        polarStraitMaxFrac: p('frac'),
        polarStraitOnPole:  p('bool'),
    },
};


/* ------------------------------------------------------------------ climate */

const CLIMATE = {
    rainBelts: {
        itczStrength:       p('1'),
        itczWidth:          p('deg'),
        stormStrength:      p('1'),
        stormCentre:        p('deg'),
        stormWidth:         p('deg'),
        subsidenceStrength: p('1'),
        subsidenceCentre:   p('deg'),
        subsidenceWidth:    p('deg'),
        rainBase:           p('1'),
    },

    moisture: {
        orographicGain:  p('1'),
        /* Both of these are written per mesh cell. A cell is ~226 km at
         * Earth's radius and N=10k and half that at half the radius, so
         * they mean twice the rate per km on a smaller planet. */
        rainEfficiency:  p('/cell'),
        recycling:       p('/cell'),
        evaporation:     p('1'),
        evaporationWarm: p('1'),
        moistureGain:    p('1'),
    },

    season: {
        seasonShift:     p('deg'),
        windSeasonShift: p('deg'),
        seasonBias:      p('1'),
        windTilt:        p('1'),
    },

    solver: {
        iterations: p('count'),
        smoothing:  p('count'),
    },

    temperature: {
        lapse:            p('1'),
        temperatureNoise: p('1'),
    },
};


/* ------------------------------------------------------------------- detail */

const DETAIL = {
    mesh: {
        /* Sketch grain in km. Shipped, not a gene. n is derived from this
         * and radius so Thalos and Earth share one spacing. */
        shapeSpacingKm: p('km'),
        /* Fallback cell count when a caller passes detailN. Not exposed. */
        n: p('count'),
    },

    warp: {
        /* World Orogen Terrain Warp. 0 leaves coasts as the sim drew
         * them; past ~1 the lookup starts dissolving the layout. */
        warpStrength:          p('1', [0, 1.2], 'Warp strength'),
        warpFreq:              p('1'),
        warpOctaves:           p('count'),
        warpMaxAmp:            p('rad'),
        warpBiasBase:          p('1'),
        warpBiasStrengthScale: p('1'),
        warpHotspotDampen:     p('1'),
        warpCoastKeep:         p('1'),
        /* Octave 0 of the island-crest noise. Shorter breaks chains
         * into speckle at this grain; longer makes a wall. */
        islandWavelengthKm:    p('km', [300, 2000], 'Island wavelength'),
    },

    ridges: {
        ridgeKernels:      p('count'),
        ridgeWavelengthKm: p('km'),
        ridgeBandwidthKm:  p('km'),
        ridgeJitter:       p('rad'),
        /* Extra metres of phasor grain on collision belts. */
        ridgeAmpM:         p('m', [0, 1800], 'Ridge amplitude'),
        ridgeBias:         p('1'),
        ridgeOrogenyMin:   p('1'),
        ridgeElevRampM:    p('m'),
        ridgeSmoothKm:     p('km'),
        ridgeWarpFreq:     p('1'),
        ridgeWarpAmp:      p('rad'),
        ridgeWarpOctaves:  p('count'),
    },

    fluvial: {
        /* How many fluvial passes the sketch runs. 0 is no drain tree
         * and no valley ramps. This grain cannot hold a real river
         * network. */
        hydraulicIters: p('index', [0, 12], 'Erosion steps'),
        streamK:        p('1'),
        streamM:        p('1'),
        streamDt:       p('1'),
        streamCap:      p('1'),
        depositFrac:    p('frac'),
        depositSlope:   p('1'),
        lakeFillCapM:   p('m'),
        inciseCapM:     p('m'),
        inciseScaleM:   p('m'),
        moisturePower:  p('1'),
    },

    thermal: {
        thermalIters: p('index'),
        talusSlope:   p('1'),
        thermalK:     p('1'),
        thermalShare: p('frac'),
    },

    glacial: {
        glacialIters:        p('index'),
        /* Ice-carve gain on the sketch. 0 is no U-valleys or drowned
         * high-latitude coasts. */
        glacialStrength:     p('1', [0, 1], 'Ice carve'),
        iceTemp:             p('temp'),
        iceRamp:             p('temp'),
        paleoIceTemp:        p('temp'),
        paleoIceRamp:        p('temp'),
        iceSheetFluvial:     p('frac'),
        iceSheetCarveScale:  p('1'),
        iceSheetFjordScale:  p('1'),
        iceSheetFjordLat0:   p('deg'),
        iceSheetFjordLat1:   p('deg'),
        iceWarpDamp:         p('1'),
        glacialCarveM:       p('m'),
        glacialConvergeM:    p('m'),
        glacialDepositM:     p('m'),
        glacialFjordM:       p('m'),
        glacialFlowMin:      p('1'),
        glacialFjordMin:     p('1'),
        glacialFlowCap:      p('1'),
        glacialWiden:        p('1'),
        glacialTerminus:     p('1'),
        glacialFjordIceMin:  p('1'),
        glacialSmooth:       p('1'),
        fjordFloorM:         p('m'),
    },

    flood: {
        floodCarve:       p('1'),
        floodMidFrac:     p('frac'),
        floodMidCarve:    p('1'),
        floodEpsM:        p('m'),
        floodNoiseM:      p('m'),
        floodCarveRadius: p('1'),
    },

    creep: {
        creepIters:    p('index'),
        creepStrength: p('1'),
    },

    noise: {
        noiseBaseM:        p('m'),
        noiseActivityM:    p('m'),
        noiseOctaves:      p('count'),
        noiseWavelengthKm: p('km'),
    },

    coast: {
        /* Shallow continental crust that can emerge as a 2-cell island.
         * Not a second shelf pass: this is the drowned-margin body. */
        shelfLoM:          p('m'),
        shelfHiM:          p('m'),
        shelfIslandM:      p('m'),
        shelfNoiseThresh:  p('1'),
        shelfWavelengthKm: p('km'),
        shelfMaxBodyCells: p('count'),
        straitMinBasin:    p('count'),
        straitMaxLandHops: p('count'),
        straitMaxM:        p('m'),
        straitFloorM:      p('m'),
        straitMinSplit:    p('count'),
    },
};


/* -------------------------------------------------------------------- world */

/* The body itself: properties of the planet rather than knobs on a model.
 * These are the ones a person actually authors, so they are the exposed set.
 * Ranges are wide on purpose — they bound what the generator can be asked
 * for, not what looks good, and narrowing them is the calibration work. */
const WORLD = {
    body: {
        radiusKm:      p('km',   [1000, 20000], 'Radius'),
        gravityG:      p('1',    [0.1, 3], 'Gravity'),
        /* Not a parameter. Dry share is an output of crust and water.
         * The solver still accepts a number if a test asks; default null
         * leaves sea level where the crust puts it. */
        landFraction:  p('frac'),
        rotationHours: p('h',    [4, 200], 'Day length'),
        axialTiltDeg:  p('deg',  [0, 90], 'Tilt'),
        ageGyr:        p('Gyr',  [0.5, 10], 'Age'),
    },
};


/* ------------------------------------------------------------------ fixture */

/* Parameters belonging to the frozen Earth fixture rather than to the
 * simulation. Its kinematic paint is one shot, so it has no step loop to
 * accumulate over and needs these two of its own. Never sampled: the
 * fixture is a fixed snapshot of a real planet, not a world to explore. */
const FIXTURE = {
    paint: {
        paintPasses:       p('count'),
        seafloorAgeCapMyr: p('Myr'),
    },
};


/* -------------------------------------------------------------------------- */

const MODULES = {
    tectonics: {groups: TECTONICS, defaults: Tectonics.DEFAULTS},
    climate:   {groups: CLIMATE,   defaults: Climate.DEFAULTS},
    world:     {groups: WORLD,     defaults: World.DEFAULTS},
    detail:    {groups: DETAIL,    defaults: Detail.DEFAULTS},
    fixture:   {groups: FIXTURE,   defaults: EarthFixture.DEFAULTS},
};


/* Every parameter of a module as {name: {...meta, group, module, default}}. */
function flatten(moduleName) {
    const module = MODULES[moduleName];
    if (!module) throw new Error(`params: unknown module "${moduleName}"`);
    const out = {};
    for (const [group, members] of Object.entries(module.groups)) {
        for (const [name, meta] of Object.entries(members)) {
            out[name] = Object.assign({}, meta, {
                group, module: moduleName, default: module.defaults[name],
            });
        }
    }
    return out;
}


/* Every parameter of every module, flattened. Names are unique across
 * modules today, and the load-time check keeps it that way. */
function all() {
    const out = {};
    for (const name of Object.keys(MODULES)) Object.assign(out, flatten(name));
    return out;
}


/* Working ranges from a search session, laid over the vouched `p()`
 * intervals. Never wider than the table: a search cannot walk off the map. */
let overlay = {};
try {
    const loaded = require('./params-ranges.json');
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) overlay = loaded;
} catch (_) {
    overlay = {};
}


function vouchedRange(name) {
    const meta = all()[name];
    return meta && meta.range ? meta.range.slice() : null;
}


function intersectRange(a, b) {
    const lo = Math.max(a[0], b[0]);
    const hi = Math.min(a[1], b[1]);
    if (lo <= hi) return [lo, hi];
    return b.slice();
}


/* The interval a sampler draws from: the overlay if one exists, else the
 * vouched range. Always a subset of the vouched interval. */
function rangeOf(name) {
    const vouched = vouchedRange(name);
    if (!vouched) return null;
    const over = overlay[name];
    return over ? intersectRange(over, vouched) : vouched.slice();
}


function getOverlay() {
    return Object.assign({}, overlay);
}


function setOverlay(next) {
    const problems = checkOverlay(next);
    if (problems.length) throw new Error('params overlay:\n  ' + problems.join('\n  '));
    overlay = Object.assign({}, next);
}


function checkOverlay(next) {
    const problems = [];
    if (next == null) return problems;
    if (typeof next !== 'object' || Array.isArray(next)) return ['overlay is not an object'];
    const registry = all();
    for (const [name, range] of Object.entries(next)) {
        const meta = registry[name];
        if (!meta) {
            problems.push(`${name}: is not a registered parameter`);
            continue;
        }
        if (!meta.range) {
            problems.push(`${name}: has no vouched range`);
            continue;
        }
        if (!Array.isArray(range) || range.length !== 2
            || !Number.isFinite(range[0]) || !Number.isFinite(range[1])
            || range[0] > range[1]) {
            problems.push(`${name}: bad range ${JSON.stringify(range)}`);
            continue;
        }
        const [lo, hi] = meta.range;
        if (range[0] < lo || range[1] > hi) {
            problems.push(`${name}: [${range[0]}, ${range[1]}] leaves vouched [${lo}, ${hi}]`);
        }
        if (meta.unit === 'frac' && (range[0] < 0 || range[1] > 1)) {
            problems.push(`${name}: fraction range [${range[0]}, ${range[1]}] leaves 0..1`);
        }
    }
    return problems;
}


/* The parameters a sampler is allowed to vary: the ones somebody has
 * vouched for a range on. Everything else stays pinned. */
function freeable() {
    return Object.entries(all())
        .filter(([, meta]) => meta.range)
        .map(([name]) => name);
}


/* The parameters shown in the default interface. */
function exposed() {
    return Object.entries(all())
        .filter(([, meta]) => meta.exposed)
        .map(([name]) => name);
}


/* Pretty name for the interface. The key stays the identifier. */
function label(name) {
    const meta = all()[name];
    return (meta && meta.label) || name;
}


/* Rates written per simulation step or per mesh cell rather than per Myr
 * or per km. These change meaning when the history length, the mesh size
 * or the planet's radius changes, so a range written against one of them
 * only holds for the configuration it was calibrated at. */
function needsNormalisation() {
    return Object.entries(all())
        .filter(([, meta]) => meta.unit.includes('/step') || meta.unit.includes('/cell'))
        .map(([name, meta]) => ({name, module: meta.module, unit: meta.unit}));
}


/* Invariant 1: the table and the code agree on what parameters exist. */
function checkKeys() {
    const problems = [];
    for (const [moduleName, module] of Object.entries(MODULES)) {
        const registered = new Set(Object.keys(flatten(moduleName)));
        const actual = new Set(Object.keys(module.defaults));
        for (const name of actual) {
            if (!registered.has(name)) problems.push(`${moduleName}.${name} is in DEFAULTS but not registered`);
        }
        for (const name of registered) {
            if (!actual.has(name)) problems.push(`${moduleName}.${name} is registered but not in DEFAULTS`);
        }
    }
    const seen = new Map();
    for (const moduleName of Object.keys(MODULES)) {
        for (const name of Object.keys(flatten(moduleName))) {
            if (seen.has(name)) problems.push(`${name} is registered by both ${seen.get(name)} and ${moduleName}`);
            seen.set(name, moduleName);
        }
    }
    return problems;
}


/* An exposed knob must have a unique pretty name. That is what the
 * interface shows; the key stays the identifier. */
function checkLabels() {
    const problems = [];
    const seen = new Map();
    for (const [name, meta] of Object.entries(all())) {
        if (!meta.exposed) continue;
        if (!meta.label) {
            problems.push(`${name}: exposed with no label`);
            continue;
        }
        if (seen.has(meta.label)) {
            problems.push(`${name}: label "${meta.label}" already used by ${seen.get(meta.label)}`);
        } else {
            seen.set(meta.label, name);
        }
    }
    return problems;
}


/* Invariant 2: nothing the sampler can reach is uncalibrated. Enforced by
 * construction — `freeable()` filters on `range` — so this only catches a
 * range that is present but nonsense for its unit. */
function checkRanges() {
    const problems = [];
    for (const [name, meta] of Object.entries(all())) {
        if (!meta.range) continue;
        /* A null default means unset — the model leaves that property alone
         * until something asks for it — so there is no value to bracket. */
        if (meta.default == null) continue;
        const [lo, hi] = meta.range;
        if (!(meta.default >= lo && meta.default <= hi)) {
            problems.push(`${name}: default ${meta.default} is outside its range [${lo}, ${hi}]`);
        }
        if (meta.unit === 'frac' && (lo < 0 || hi > 1)) {
            problems.push(`${name}: fraction range [${lo}, ${hi}] leaves 0..1`);
        }
    }
    return problems;
}


/* Catalogue body. landFraction is not among these. Water is the basin
 * fill dial (`seaLevelThicknessKm`). */
const BODY_NAMES = [
    'radiusKm', 'gravityG', 'rotationHours', 'axialTiltDeg', 'ageGyr',
    'seaLevelThicknessKm',
];


function isBody(name) {
    return BODY_NAMES.includes(name);
}


/* Layout vs Shape. Search draws layout (and unpinned body). Shape genes
 * are the detail module — sliders on the globe, not a second sheet. */
function phase(name) {
    if (isBody(name)) return 'body';
    const meta = all()[name];
    if (!meta) return null;
    if (meta.module === 'detail') return 'shape';
    if (meta.module === 'fixture') return 'fixture';
    return 'layout';
}


function bodyNames() {
    return BODY_NAMES.slice();
}


function pickBody(values) {
    const out = {};
    for (const name of BODY_NAMES) {
        const value = values && values[name];
        if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
    }
    return out;
}


function checkValue(label, name, value) {
    const meta = all()[name];
    if (!meta) return `${label}: "${name}" is not a registered parameter`;
    if (meta.default != null && typeof value !== typeof meta.default) {
        return `${label}.${name}: ${typeof value} where the default is ${typeof meta.default}`;
    }
    if (meta.unit === 'frac' && typeof value === 'number' && (value < 0 || value > 1)) {
        return `${label}.${name}: fraction ${value} leaves 0..1`;
    }
    return null;
}


/* A project file holds a body. A fixture may also hold authored knobs
 * and a seed token. Caller overlays (studio, a variant recipe) are
 * checked with checkValues, not this. */
function checkProject(project) {
    const problems = [];
    if (!project || typeof project !== 'object') return ['project is not an object'];
    if (!project.name) problems.push('project has no name');
    const label = project.name || 'project';
    if (project.fixture) {
        if (project.seed == null || project.seed === '') {
            problems.push(`${label}: fixture has no seed token`);
        }
    } else {
        if (project.seed != null) problems.push(`${label}: a project must not hold a seed`);
        if (project.values && Object.keys(project.values).length) {
            problems.push(`${label}: a project must not hold a values bag`);
        }
    }
    for (const [name, value] of Object.entries(project.body || {})) {
        if (!isBody(name)) problems.push(`${label}.${name}: is not a body parameter`);
        const problem = checkValue(label, name, value);
        if (problem) problems.push(problem);
    }
    if (project.fixture) {
        for (const [name, value] of Object.entries(project.values || {})) {
            const problem = checkValue(label, name, value);
            if (problem) problems.push(problem);
        }
    }
    return problems;
}


function checkValues(label, values) {
    const problems = [];
    if (values == null) return problems;
    if (typeof values !== 'object' || Array.isArray(values)) return [`${label}: values is not an object`];
    for (const [name, value] of Object.entries(values)) {
        const problem = checkValue(label, name, value);
        if (problem) problems.push(problem);
    }
    return problems;
}


const problems = checkKeys().concat(checkRanges()).concat(checkOverlay(overlay)).concat(checkLabels());
if (problems.length) {
    throw new Error('params registry is out of date:\n  ' + problems.join('\n  '));
}


module.exports = {
    UNITS,
    MODULES,
    flatten,
    all,
    vouchedRange,
    rangeOf,
    getOverlay,
    setOverlay,
    checkOverlay,
    BODY_NAMES,
    isBody,
    phase,
    bodyNames,
    pickBody,
    freeable,
    exposed,
    label,
    needsNormalisation,
    checkKeys,
    checkRanges,
    checkLabels,
    checkValue,
    checkProject,
    checkValues,
};
