/*
 * A variant is one saved snapshot of a project.
 *
 * The list is keyed by **name**, not by seed, parent, or recipe. Save with
 * the same name and the snapshot is the next head of that variant. Save
 * with a new name and it is another variant, not a child of the one that
 * was open. Each snapshot's id is a UTC unix time (`v` + milliseconds).
 *
 * A catalog write never drops an id unless it is in `drop`. Delete
 * sets `deleted` on the snapshot. The record stays. The list hides it.
 *
 * Browser-free, so `bun run check:projects` can hold the record without
 * opening the app. Artifacts key off the id. Explore writes ranges through
 * to head as likes reshape the box.
 */
'use strict';

const Params = require('../params');

const NAME_MAX = 48;


let lastIdMs = 0;


function newId(list) {
    let ms = Date.now();
    if (ms <= lastIdMs) ms = lastIdMs + 1;
    let id = `v${ms}`;
    while (list && findById(list, id)) {
        ms += 1;
        id = `v${ms}`;
    }
    lastIdMs = ms;
    return id;
}


function idTime(id) {
    const match = String(id || '').match(/^v(\d{12,})$/i);
    return match ? Number(match[1]) : 0;
}


function normalizeName(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, NAME_MAX);
}


function lineageKey(variant) {
    if (!variant) return null;
    const name = normalizeName(variant.name);
    if (name) return `n:${name}`;
    return variant.id ? `i:${variant.id}` : null;
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
    const layout = variant && variant.seed;
    const shape = effectiveShapeSeed(variant);
    return `${layout}|s${shape}|${names.map((n) => `${n}=${bag[n]}`).join(',')}`;
}


function effectiveShapeSeed(variant) {
    const n = variant && variant.shapeSeed | 0;
    if (n >= 1) return n;
    return (variant && variant.seed | 0) || 1;
}


function parseVariant(item, adopted, known) {
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
        shapeSeed: (item.shapeSeed | 0) >= 1 ? (item.shapeSeed | 0) : seed,
        body,
        values,
        pins,
        ranges: parseRanges(item.ranges),
        parent: parseParent(item.parent),
    };
    if (typeof item.id === 'string' && /^v[a-z0-9]+$/i.test(item.id)) variant.id = item.id;
    else variant.id = newId(known);
    if (typeof item.name === 'string') {
        const name = item.name.trim().slice(0, NAME_MAX);
        if (name) variant.name = name;
    }
    const generation = item.generation | 0;
    variant.generation = generation >= 1 ? generation : 1;
    if (typeof item.thumb === 'string') {
        if (item.thumb.startsWith('data:image/') || item.thumb.startsWith('/preview/')) {
            variant.thumb = item.thumb;
        }
    }
    if (item.shaped) variant.shaped = true;
    variant.deleted = !!item.deleted;
    if (typeof item.lineage === 'string' && /^v[a-z0-9]+$/i.test(item.lineage)) {
        variant.lineage = item.lineage;
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
    const out = [];
    for (const item of raw) {
        const variant = parseVariant(item, adopted, out);
        if (!variant) continue;
        if (seenId.has(variant.id)) continue;
        seenId.add(variant.id);
        out.push(variant);
    }
    return out;
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
        shapeSeed: extra.shapeSeed,
        body: Object.assign({}, Params.pickBody(drawn), pins),
        values: pickGenes(ind.values),
        pins,
        ranges: extra.ranges,
        name: extra.name,
        thumb: extra.thumb,
        lineage: extra.lineage,
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
        shapeSeed: input.shapeSeed,
        body: Object.assign({}, Params.pickBody(drawn), pins),
        values: pickGenes(input.values),
        pins,
        ranges: input.ranges,
        name: input.name,
        thumb: input.thumb,
        lineage: input.lineage,
        shaped: input.shaped,
    });
}


function isLive(item) {
    return !!(item && !item.deleted);
}


function live(list) {
    return (list || []).filter(isLive);
}


function findByRecipe(list, variant) {
    if (!variant) return null;
    const key = recipeKey(variant);
    return live(list).find((item) => recipeKey(item) === key) || null;
}


function sameRecipe(a, b) {
    return !!(a && b && recipeKey(a) === recipeKey(b));
}


function dirty(working, head) {
    if (!working) return false;
    if (!head) return true;
    return recipeKey(working) !== recipeKey(head);
}


function isTip(list, id) {
    return !!id && childrenOf(list, id).length === 0;
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
        return next;
    }
    return [incoming, ...list];
}


function append(list, incoming) {
    if (!incoming) return list || [];
    const keepId = incoming.id && !findById(list, incoming.id);
    const item = Object.assign({}, incoming, {
        id: keepId ? incoming.id : newId(list),
        generation: incoming.generation >= 1 ? incoming.generation : 1,
    });
    return [item, ...(list || [])];
}


/* Same planet: same layout seed. Shape iteration stays on this planet. */
function samePlanet(a, b) {
    if (!a || !b) return false;
    return (a.seed | 0) === (b.seed | 0);
}


/* A new layout seed or an explore draw is a different planet. A name is
 * not. Same-planet saves are still new tree nodes. */
function differentPlanet(head, input) {
    if (!head) return false;
    if (typeof input !== 'object' || input == null) input = {};
    if (input.discover) return true;
    if (input.seed != null && (input.seed | 0) !== (head.seed | 0)) return true;
    return false;
}


/* Same name continues that variant. A new name is another variant.
 * Ids are UTC unix time. Parent and recipe do not group the list. */
function save(list, head, incoming) {
    if (!incoming) return list || [];
    const typed = normalizeName(incoming.name);
    const name = typed || (head && normalizeName(head.name)) || undefined;
    const members = name
        ? (list || []).filter((item) => normalizeName(item.name) === name)
        : [];
    const payload = Object.assign({}, incoming, {
        id: newId(list),
        generation: members.length + 1,
        shapeSeed: effectiveShapeSeed(incoming),
    });
    delete payload.parent;
    delete payload.lineage;
    if (name) payload.name = name;
    else delete payload.name;
    const incomingRanges = payload.ranges || {};
    if (!Object.keys(incomingRanges).length && head && head.ranges) {
        payload.ranges = head.ranges;
    }
    return append(list, payload);
}


function setRanges(list, id, ranges) {
    if (!id) return list || [];
    const found = (list || []).findIndex((item) => item.id === id);
    if (found < 0) return list || [];
    const parsed = parseRanges(ranges);
    const prev = list[found].ranges || {};
    const names = new Set([...Object.keys(prev), ...Object.keys(parsed)]);
    let same = true;
    for (const name of names) {
        const a = prev[name];
        const b = parsed[name];
        if (!a || !b || a[0] !== b[0] || a[1] !== b[1]) {
            same = false;
            break;
        }
    }
    if (same) return list;
    const next = list.slice();
    next[found] = Object.assign({}, list[found], {ranges: parsed});
    return next;
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


function putThumb(list, id, thumb, replace) {
    if (!thumb || !id) return list || [];
    let changed = false;
    const next = (list || []).map((item) => {
        if (item.id !== id) return item;
        if (!replace && item.thumb) return item;
        if (item.thumb === thumb) return item;
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


function samePlanetChildren(list, id) {
    const node = findById(list, id);
    if (!node) return [];
    return childrenOf(list, id).filter((child) => samePlanet(node, child));
}


function sortByTime(items) {
    return (items || []).slice().sort((a, b) => idTime(a.id) - idTime(b.id));
}


function lineageMembers(list, variant) {
    const key = lineageKey(variant);
    if (!key) return [];
    return (list || []).filter((item) => lineageKey(item) === key);
}


function pickHead(members) {
    const sorted = sortByTime(members);
    return sorted.length ? sorted[sorted.length - 1] : null;
}


function isLineageTip(list, variant) {
    if (!variant) return false;
    const head = pickHead(lineageMembers(list, variant));
    return !!(head && head.id === variant.id);
}


function lineageHistory(list, variant) {
    return sortByTime(lineageMembers(list, variant));
}


function lineageName(list, variant) {
    if (!variant) return 'working planet';
    if (variant.name) return variant.name;
    const head = pickHead(lineageMembers(list, variant));
    if (head && head.name) return head.name;
    return String(variant.seed);
}


function lineageRoot(list, variant) {
    if (!variant) return null;
    const members = lineageMembers(list, variant);
    if (!members.length) return variant;
    return sortByTime(members)[0] || variant;
}


function lineageUnique(list, tip) {
    if (!tip) return [];
    return lineageMembers(list, tip);
}


/* One card per name. Unnamed snapshots are each their own card.
 * A checkout that is not in the catalog still gets a row. */
function lineageRows(list, checkout) {
    const items = list || [];
    const seen = new Set();
    const rows = [];
    for (const item of items) {
        if (!isLive(item)) continue;
        const key = lineageKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const members = live(lineageMembers(items, item));
        if (!members.length) continue;
        const head = pickHead(members) || item;
        rows.push({
            variant: head,
            history: sortByTime(members),
            depth: 0,
            parent: null,
            notes: [],
            name: head.name || String(head.seed),
            fork: false,
        });
    }
    rows.sort((a, b) => idTime(b.variant.id) - idTime(a.variant.id));
    if (checkout && checkout.id && isLive(checkout) && !findById(live(items), checkout.id)) {
        const key = lineageKey(checkout);
        if (!key || !seen.has(key)) {
            rows.unshift({
                variant: checkout,
                history: [checkout],
                depth: 0,
                parent: null,
                notes: [],
                name: checkout.name || String(checkout.seed),
                fork: false,
            });
        }
    }
    return rows;
}


function removeLineage(list, tipId) {
    const tip = findById(list, tipId);
    if (!tip) return list || [];
    const ids = new Set(lineageMembers(list, tip).map((item) => item.id));
    return (list || []).filter((item) => !ids.has(item.id));
}


function markDeleted(list, ids, deleted) {
    const set = ids instanceof Set ? ids : new Set(ids || []);
    if (!set.size) return list || [];
    let changed = false;
    const flag = !!deleted;
    const next = (list || []).map((item) => {
        if (!set.has(item.id)) return item;
        if (!!item.deleted === flag) return item;
        changed = true;
        return Object.assign({}, item, {deleted: flag});
    });
    return changed ? next : (list || []);
}


function markLineage(list, tipId, deleted) {
    const tip = findById(list, tipId);
    if (!tip) return list || [];
    return markDeleted(list, lineageMembers(list, tip).map((item) => item.id), deleted);
}


function preferVariant(kept, incoming) {
    return Object.assign({}, kept, incoming, {
        id: kept.id,
        name: incoming.name || kept.name,
        shaped: !!(kept.shaped || incoming.shaped),
        thumb: incoming.thumb || kept.thumb,
        generation: Math.max(kept.generation || 1, incoming.generation || 1),
    });
}


/* Incoming order wins. Ids only in `existing` are appended, never dropped. */
function mergeVariants(incoming, existing) {
    const fromExisting = new Map();
    for (const item of existing || []) {
        if (item && item.id) fromExisting.set(item.id, item);
    }
    const out = [];
    const seen = new Set();
    for (const item of incoming || []) {
        if (!item || !item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(fromExisting.has(item.id) ? preferVariant(fromExisting.get(item.id), item) : item);
    }
    for (const item of existing || []) {
        if (!item || !item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
    }
    return out;
}


function mergeCatalogs(incoming, existing) {
    const project = (incoming && incoming.project) || (existing && existing.project) || '';
    const variants = mergeVariants(incoming && incoming.variants, existing && existing.variants);
    const committed = [incoming && incoming.committed, existing && existing.committed]
        .find((id) => findById(variants, id)) || null;
    return {project, committed, variants};
}


function parseDrop(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter((id) => typeof id === 'string' && /^v[a-z0-9]+$/i.test(id));
}


function applyDrop(catalog, drop) {
    const ids = new Set(parseDrop(drop));
    if (!ids.size) return catalog;
    const variants = (catalog.variants || []).filter((item) => !ids.has(item.id));
    const committed = catalog.committed && ids.has(catalog.committed) ? null : catalog.committed;
    return {project: catalog.project || '', committed, variants};
}


function remember(list, incoming) {
    if (!incoming) return list || [];
    if (findById(list, incoming.id)) return list || [];
    return [incoming, ...(list || [])];
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
            if (item.shapeSeed && item.shapeSeed !== item.seed) out.shapeSeed = item.shapeSeed;
            if (item.name) out.name = item.name;
            if (item.generation > 1) out.generation = item.generation;
            if (item.shaped) out.shaped = true;
            if (item.deleted) out.deleted = true;
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


/* Save moves head to the new child. The project's committed pointer
 * follows only when the save is on that line — a different planet leaves it. */
function advanceHead(catalog, fromId, toId) {
    const next = parseCatalog(catalog, catalog && catalog.project);
    if (!findById(next.variants, toId)) return next;
    if (!next.committed || next.committed === fromId) next.committed = toId;
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


/* Which saved variant a project should open.
 * A deep link wins, then the last one this project had selected.
 * A leftover catalog `committed` id is ignored. A seed in the query with
 * no variant id is a working planet, not a catalog checkout — but the
 * address bar always writes both, so a variant in the query still wins.
 * A missing id is returned by wantedId so the studio can put it back. */
function wantedId(input) {
    if (input && input.fixture) return null;
    const pending = input && input.pendingId;
    if (typeof pending === 'string' && /^v[a-z0-9]+$/i.test(pending)) return pending;
    const last = input && input.lastId;
    const lastOk = typeof last === 'string' && /^v[a-z0-9]+$/i.test(last) ? last : null;
    if (input && input.seedFromQuery && !pending) {
        if (!lastOk) return null;
        const found = (input.variants || []).find((item) => item && item.id === lastOk);
        const querySeed = input.querySeed;
        if (found && querySeed != null && (found.seed | 0) !== (querySeed | 0)) return null;
        return lastOk;
    }
    return lastOk;
}


function resumeId(input) {
    const id = wantedId(input);
    if (!id) return null;
    const found = (input && input.variants || []).find((item) => item && item.id === id);
    return found && isLive(found) ? id : null;
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
    effectiveShapeSeed,
    parseVariant,
    parseVariants,
    ofIndividual,
    ofWorking,
    isLive,
    live,
    findByRecipe,
    sameRecipe,
    dirty,
    isTip,
    findById,
    hasRecipe,
    toggleRecipe,
    upsert,
    append,
    samePlanet,
    differentPlanet,
    save,
    setRanges,
    removeId,
    stampThumb,
    putThumb,
    valuesOf,
    inheritedPins,
    childrenOf,
    shortParam,
    edgeNotes,
    treeRows,
    samePlanetChildren,
    isLineageTip,
    lineageHistory,
    lineageName,
    lineageRoot,
    lineageUnique,
    lineageRows,
    removeLineage,
    markDeleted,
    markLineage,
    lineageKey,
    mergeVariants,
    mergeCatalogs,
    applyDrop,
    parseDrop,
    remember,
    emptyCatalog,
    parseCatalog,
    serializeCatalog,
    commit,
    advanceHead,
    migrate,
    wantedId,
    resumeId,
    refinement,
};
