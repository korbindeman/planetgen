/*
 * Identity for everything the terrain-diffusion overlay does.
 *
 * A tile on the globe is (world, planet, crop). The world is project + seed
 * + variant. The planet is the mesh currently on screen. The crop is a
 * named folder. Every async reply, every cached DEM and every colouring
 * carries that identity, and is ignored when it no longer matches. Missing
 * fields are not wildcards — that is how a seedless tile sat on every
 * planet, and how a late fetch painted the last world's DEM on this one.
 *
 * Browser-free, so `bun run check:td` and the overlay share one definition.
 */
'use strict';


function worldOf(raw) {
    const src = raw || {};
    return {
        project: src.project || null,
        seed: src.seed != null && src.seed !== '' ? src.seed : null,
        variant: src.variant || null,
    };
}


function sameSeed(a, b) {
    if (a == null || a === '' || b == null || b === '') return false;
    return String(a).toLowerCase() === String(b).toLowerCase();
}


function sameWorld(a, b) {
    if (!a || !b) return false;
    const emptyA = a.seed == null || a.seed === '';
    const emptyB = b.seed == null || b.seed === '';
    const seeds = emptyA && emptyB ? true : sameSeed(a.seed, b.seed);
    return (a.project || null) === (b.project || null)
        && seeds
        && (a.variant || null) === (b.variant || null);
}


function sameTile(a, b) {
    return !!a && !!b
        && a.face === b.face && a.level === b.level && a.i === b.i && a.j === b.j;
}


/*
 * A crop belongs to a world only when every identity the world has is
 * present and equal on the crop. An unset field does not match a set one.
 */
function belongsTo(crop, world) {
    if (!crop || !world) return false;
    if ((crop.project || null) !== (world.project || null)) return false;
    if ((crop.variant || null) !== (world.variant || null)) return false;
    if (world.seed == null) return crop.seed == null || crop.seed === '';
    return sameSeed(crop.seed, world.seed);
}


function elevPath(url) {
    return String(url || '').replace(/^https?:\/\/[^/]+/i, '');
}


function sameElev(a, b) {
    if (!a || !b) return false;
    if ((a.elevWidth | 0) !== (b.elevWidth | 0) || (a.elevHeight | 0) !== (b.elevHeight | 0)) {
        return false;
    }
    return elevPath(a.elev) === elevPath(b.elev);
}


function canReuseElev(old, incoming, world) {
    if (!old || !incoming || !old.elevM) return false;
    if (!belongsTo(old, world) || !belongsTo(incoming, world)) return false;
    if (old.name !== incoming.name) return false;
    if (incoming.tile || old.tile) {
        if (!sameTile(old.tile, incoming.tile)) return false;
    }
    return sameElev(old, incoming);
}


function canReuseColor(old, incoming, world, planetId) {
    if (!canReuseElev(old, incoming, world)) return false;
    if (!old.imageEl) return false;
    if (old.planetId !== planetId) return false;
    return true;
}


function adoptCaches(incoming, previous, world, planetId) {
    const prev = previous instanceof Map
        ? previous
        : new Map((previous || []).map((c) => [c.name, c]));
    for (const crop of incoming) {
        const old = prev.get(crop.name);
        if (!canReuseElev(old, crop, world)) continue;
        crop.elevM = old.elevM;
        if (canReuseColor(old, crop, world, planetId)) {
            crop.imageEl = old.imageEl;
            crop.planetId = old.planetId;
        }
    }
    return incoming;
}


function createEpoch() {
    let world = worldOf(null);
    let worldToken = 0;
    let loadToken = 0;
    let planetId = 0;

    function snapshot() {
        return {
            world: worldOf(world),
            worldToken,
            loadToken,
            planetId,
        };
    }

    return {
        world: () => world,
        planetId: () => planetId,
        snapshot,
        begin(next) {
            const n = worldOf(next);
            if (sameWorld(n, world)) return {changed: false, ...snapshot()};
            world = n;
            worldToken += 1;
            loadToken += 1;
            return {changed: true, ...snapshot()};
        },
        beginLoad() {
            loadToken += 1;
            return snapshot();
        },
        setPlanet(id) {
            const next = id | 0;
            if (next === planetId) return false;
            planetId = next;
            return true;
        },
        stillCurrent(asked) {
            return !!asked
                && asked.loadToken === loadToken
                && asked.worldToken === worldToken
                && sameWorld(asked.world, world);
        },
        stillSameWorld(asked) {
            return !!asked
                && asked.worldToken === worldToken
                && sameWorld(asked.world, world);
        },
        stillSamePlanet(asked) {
            return this.stillSameWorld(asked) && asked.planetId === planetId;
        },
    };
}


module.exports = {
    worldOf,
    sameSeed,
    sameWorld,
    sameTile,
    belongsTo,
    elevPath,
    sameElev,
    canReuseElev,
    canReuseColor,
    adoptCaches,
    createEpoch,
};
