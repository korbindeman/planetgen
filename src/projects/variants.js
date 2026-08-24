/*
 * A variant is one saved candidate of a project.
 *
 * A variant stores its own seed, body, gene draws, body pins, ranges, and
 * parent. Likes never enter this. Only an explicit Save writes one.
 * Pins are body-only; a gene is constrained by ranges, not a pin.
 *
 * Browser-free, so `bun run check:projects` can hold the record without
 * opening the app. Artifacts key off the id; the recipe key is only
 * for dedup until hand-authoring can make two variants share a recipe.
 */
'use strict';

const Params = require('../params');

const NAME_MAX = 48;


function newId() {
    return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}


function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}


function pickGenes(values) {
    const out = {};
    for (const [name, value] of Object.entries(values || {})) {
        if (Params.isBody(name)) continue;
        if (!finiteNumber(value)) continue;
        out[name] = value;
    }
    return out;
}


function parsePins(raw) {
    const out = {};
    for (const [name, value] of Object.entries(raw || {})) {
        if (!Params.isBody(name) || !finiteNumber(value)) continue;
        out[name] = value;
    }
    return out;
}


function parseRanges(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [name, range] of Object.entries(raw)) {
        const vouched = Params.vouchedRange(name);
        if (!vouched || !Array.isArray(range) || range.length !== 2) continue;
        const lo = Number(range[0]);
        const hi = Number(range[1]);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) continue;
        const clipped = [Math.max(lo, vouched[0]), Math.min(hi, vouched[1])];
        if (clipped[0] <= clipped[1]) out[name] = clipped;
    }
    return out;
}


function parseParent(raw) {
    if (typeof raw !== 'string' || !/^v[a-z0-9]+$/i.test(raw)) return null;
    return raw;
}


function recipeKey(variant) {
    const body = (variant && variant.body) || {};
    const values = (variant && variant.values) || {};
    const names = Object.keys(Object.assign({}, body, values)).sort();
    const bag = Object.assign({}, body, values);
    return `${variant && variant.seed}|${names.map((n) => `${n}=${bag[n]}`).join(',')}`;
}


function parseVariant(item, adopted) {
    if (!item || typeof item !== 'object') return null;
    const seed = item.seed | 0;
    if (!(seed >= 1)) return null;
    if (typeof item.project !== 'string' || !item.project) return null;
    const fromFile = item.body && Object.keys(item.body).length ? item.body : item.values;
    const body = Params.pickBody(Object.assign({}, adopted, fromFile));
    const values = pickGenes(item.values);
    const pins = parsePins(item.pins != null ? item.pins : body);
    const variant = {
        project: item.project,
        seed,
        body,
        values,
        pins,
        ranges: parseRanges(item.ranges),
        parent: parseParent(item.parent),
    };
    if (typeof item.id === 'string' && /^v[a-z0-9]+$/i.test(item.id)) variant.id = item.id;
    else variant.id = newId();
    if (typeof item.name === 'string') {
        const name = item.name.trim().slice(0, NAME_MAX);
        if (name) variant.name = name;
    }
    if (typeof item.thumb === 'string') {
        if (item.thumb.startsWith('data:image/') || item.thumb.startsWith('/preview/')) {
            variant.thumb = item.thumb;
        }
    }
    return variant;
}


function reparent(list) {
    const ids = new Set(list.map((item) => item.id));
    for (const item of list) {
        if (item.parent && (item.parent === item.id || !ids.has(item.parent))) item.parent = null;
    }
    return list;
}


function parseVariants(raw, adopted) {
    if (!Array.isArray(raw)) return [];
    const seenId = new Set();
    const seenRecipe = new Set();
    const out = [];
    for (const item of raw) {
        const variant = parseVariant(item, adopted);
        if (!variant) continue;
        const key = recipeKey(variant);
        if (seenId.has(variant.id) || seenRecipe.has(key)) continue;
        seenId.add(variant.id);
        seenRecipe.add(key);
        out.push(variant);
    }
    return reparent(out);
}


function ofIndividual(ind, extra) {
    extra = extra || {};
    const pins = parsePins(extra.pins);
    const drawn = Object.assign({}, extra.body, ind.values);
    return parseVariant({
        id: extra.id,
        project: extra.project,
        parent: extra.parent,
        seed: ind.seed,
        body: Object.assign({}, Params.pickBody(drawn), pins),
        values: pickGenes(ind.values),
        pins,
        ranges: extra.ranges,
        name: extra.name,
        thumb: extra.thumb,
    });
}


function ofWorking(input) {
    const pins = parsePins(input.pins);
    const drawn = Object.assign({}, input.body, input.values);
    return parseVariant({
        id: input.id,
        project: input.project,
        parent: input.parent,
        seed: input.seed,
        body: Object.assign({}, Params.pickBody(drawn), pins),
        values: pickGenes(input.values),
        pins,
        ranges: input.ranges,
        name: input.name,
        thumb: input.thumb,
    });
}


function findByRecipe(list, variant) {
    if (!variant) return null;
    const key = recipeKey(variant);
    return (list || []).find((item) => recipeKey(item) === key) || null;
}


function findById(list, id) {
    return (list || []).find((item) => item.id === id) || null;
}


function hasRecipe(list, ind, extra) {
    extra = extra || {};
    const incoming = extra.project
        ? ofIndividual(ind, extra)
        : {seed: ind.seed, body: {}, values: pickGenes(ind.values)};
    return !!findByRecipe(list, incoming);
}


function toggleRecipe(list, incoming) {
    if (!incoming) return list || [];
    const key = recipeKey(incoming);
    const found = (list || []).findIndex((item) => recipeKey(item) === key);
    if (found >= 0) return list.filter((_, i) => i !== found);
    return [incoming, ...list];
}


function upsert(list, incoming) {
    if (!incoming) return list || [];
    const key = recipeKey(incoming);
    const found = (list || []).findIndex((item) => item.id === incoming.id || recipeKey(item) === key);
    if (found >= 0) {
        const next = list.slice();
        next[found] = Object.assign({}, list[found], incoming, {id: list[found].id});
        return reparent(next);
    }
    return reparent([incoming, ...list]);
}


function removeId(list, id) {
    const doomed = findById(list, id);
    const parent = doomed && doomed.parent ? doomed.parent : null;
    return reparent((list || []).filter((item) => item.id !== id).map((item) => {
        if (item.parent !== id) return item;
        return Object.assign({}, item, {parent});
    }));
}


function stampThumb(list, variant, thumb) {
    if (!thumb || !variant) return list || [];
    const key = recipeKey(variant);
    let changed = false;
    const next = (list || []).map((item) => {
        if (recipeKey(item) !== key || item.thumb) return item;
        changed = true;
        return Object.assign({}, item, {thumb});
    });
    return changed ? next : (list || []);
}


function valuesOf(variant) {
    return variant ? Object.assign({}, variant.values) : {};
}


function inheritedPins(list, variant) {
    if (!variant) return {};
    const chain = [];
    const seen = new Set();
    let cur = variant;
    while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        chain.push(cur);
        cur = cur.parent ? findById(list, cur.parent) : null;
    }
    chain.reverse();
    const pins = {};
    for (const node of chain) Object.assign(pins, node.pins);
    return pins;
}


function childrenOf(list, id) {
    return (list || []).filter((item) => item.parent === id);
}


function shortParam(name) {
    const names = {
        radiusKm: 'radius',
        gravityG: 'gravity',
        rotationHours: 'day',
        axialTiltDeg: 'tilt',
        ageGyr: 'age',
        continentFraction: 'crust',
        plates: 'plates',
        cratons: 'cratons',
        steps: 'steps',
        hotspots: 'hotspots',
    };
    return names[name] || name;
}


function rangeWidth(range) {
    return range && range.length === 2 ? range[1] - range[0] : 0;
}


function edgeNotes(parent, child) {
    const notes = [];
    const seen = new Set();
    const parentPins = (parent && parent.pins) || {};
    const childPins = (child && child.pins) || {};
    for (const name of Object.keys(childPins)) {
        if (parentPins[name] === childPins[name]) continue;
        notes.push(parentPins[name] == null ? `pinned ${shortParam(name)}` : `repinned ${shortParam(name)}`);
        seen.add(name);
    }
    const parentRanges = (parent && parent.ranges) || {};
    const childRanges = (child && child.ranges) || {};
    for (const name of Object.keys(childRanges)) {
        if (seen.has(name)) continue;
        const next = childRanges[name];
        const prev = parentRanges[name] || Params.vouchedRange(name);
        if (!prev || rangeWidth(next) >= rangeWidth(prev) - 1e-9) continue;
        notes.push(`narrowed ${shortParam(name)}`);
        seen.add(name);
        if (notes.length >= 3) break;
    }
    return notes;
}


function treeRows(list) {
    const items = list || [];
    const out = [];
    const walk = (parentId, depth) => {
        const kids = parentId == null
            ? items.filter((item) => !item.parent)
            : childrenOf(items, parentId);
        for (const variant of kids) {
            const parent = parentId ? findById(items, parentId) : null;
            out.push({
                variant,
                depth,
                parent,
                notes: parent ? edgeNotes(parent, variant) : [],
            });
            walk(variant.id, depth + 1);
        }
    };
    walk(null, 0);
    return out;
}


function emptyCatalog(project) {
    return {project: project || '', committed: null, variants: []};
}


function parseCatalog(raw, project, adopted) {
    if (Array.isArray(raw)) {
        return {
            project: project || '',
            committed: null,
            variants: parseVariants(raw.map((item) => Object.assign({project}, item)), adopted),
        };
    }
    if (!raw || typeof raw !== 'object') return emptyCatalog(project);
    const name = typeof raw.project === 'string' && raw.project ? raw.project : (project || '');
    const variants = parseVariants((raw.variants || []).map((item) => Object.assign({project: name}, item)), adopted);
    const committed = typeof raw.committed === 'string' && findById(variants, raw.committed)
        ? raw.committed
        : null;
    return {project: name, committed, variants};
}


function serializeCatalog(catalog) {
    const project = catalog && catalog.project ? catalog.project : '';
    const variants = parseVariants(catalog && catalog.variants);
    const committed = catalog && findById(variants, catalog.committed)
        ? catalog.committed
        : null;
    return {
        project,
        committed,
        variants: variants.map((item) => {
            const out = {
                id: item.id,
                seed: item.seed,
                body: item.body,
                values: item.values,
                pins: item.pins,
                ranges: item.ranges,
            };
            if (item.parent) out.parent = item.parent;
            if (item.name) out.name = item.name;
            return out;
        }),
    };
}


function commit(catalog, id) {
    const next = parseCatalog(catalog, catalog && catalog.project);
    if (!findById(next.variants, id)) return next;
    next.committed = id;
    return next;
}


function migrate(legacyKeeps, legacySeeds, project, adopted) {
    const body = Params.pickBody(adopted);
    const out = [];
    if (Array.isArray(legacyKeeps)) {
        for (const item of legacyKeeps) {
            const variant = parseVariant(Object.assign({}, item, {
                project: (item && item.project) || project,
                body: (item && item.body) || body,
                pins: (item && item.pins) || body,
            }));
            if (variant) out.push(variant);
        }
    }
    if (Array.isArray(legacySeeds) && project) {
        for (const item of legacySeeds) {
            const variant = parseVariant({
                project,
                seed: item && item.seed,
                body,
                values: {},
                pins: body,
                name: item && item.name,
            });
            if (variant && !findByRecipe(out, variant)) out.push(variant);
        }
    }
    return parseVariants(out);
}


/* Tightness vs vouched: 1 is a point, 0 is the full vouched box.
 * Unranged genes do not count. A variant with no ranges is 0. */
function refinement(variant) {
    const ranges = (variant && variant.ranges) || {};
    const names = Object.keys(ranges);
    if (!names.length) return 0;
    let sum = 0;
    let n = 0;
    for (const name of names) {
        const vouched = Params.vouchedRange(name);
        const range = ranges[name];
        if (!vouched || !range) continue;
        const wide = vouched[1] - vouched[0];
        if (!(wide > 0)) continue;
        const tight = Math.max(0, range[1] - range[0]);
        sum += 1 - tight / wide;
        n += 1;
    }
    return n ? sum / n : 0;
}


module.exports = {
    NAME_MAX,
    newId,
    pickGenes,
    parsePins,
    parseRanges,
    recipeKey,
    parseVariant,
    parseVariants,
    ofIndividual,
    ofWorking,
    findByRecipe,
    findById,
    hasRecipe,
    toggleRecipe,
    upsert,
    removeId,
    stampThumb,
    valuesOf,
    inheritedPins,
    childrenOf,
    shortParam,
    edgeNotes,
    treeRows,
    emptyCatalog,
    parseCatalog,
    serializeCatalog,
    commit,
    migrate,
    refinement,
};
