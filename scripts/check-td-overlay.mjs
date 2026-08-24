#!/usr/bin/env bun
/**
 * Check that a TD overlay reply cannot land on the wrong planet.
 *
 *   bun run check:td
 *
 * The overlay used to key caches by crop name and treat a missing seed as
 * "any seed". A late fetch, a same-named tile from the last world, or a
 * colouring from the last mesh then sat on the current globe. This file
 * is the contract that forbids that: every cached DEM, every colouring
 * and every in-flight reply carries a world + planet identity, and is
 * dropped when that identity has moved on.
 *
 * Browser-free, so this runs alongside `check:projects` and `check:tiles`.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { listTdOverlays } from "./td-overlays.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Epoch = require(join(root, "src", "td-epoch.js"));
const Cube = require(join(root, "src", "cubesphere.js"));

const failures = [];
const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else { console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
};

console.log("td overlay identity");

const worldA = {project: "thalos", seed: 42, variant: null};
const worldB = {project: "thalos", seed: 99, variant: null};
const earth = {project: "earth", seed: "earth", variant: null};
const variant = {project: "thalos", seed: 42, variant: "vabc123"};
const tile = {face: 0, level: 4, i: 3, j: 5};

const cropA = {
    name: "f0l4x3y5",
    project: "thalos",
    seed: 42,
    variant: null,
    tile,
    elev: "/preview/thalos/crop-f0l4x3y5/output.elev",
    elevWidth: 64,
    elevHeight: 64,
    elevM: new Float32Array([1, 2, 3]),
    imageEl: {from: "A"},
    planetId: 1,
};

/* 1. Missing identity is not a wildcard. */
{
    check("a seedless crop does not belong to a seeded world",
        !Epoch.belongsTo({project: "thalos", seed: null, name: "f0l4x3y5"}, worldA));
    check("a matching crop belongs",
        Epoch.belongsTo({project: "thalos", seed: 42, name: "f0l4x3y5"}, worldA));
    check("another seed does not belong",
        !Epoch.belongsTo({project: "thalos", seed: 99, name: "f0l4x3y5"}, worldA));
    check("another project does not belong",
        !Epoch.belongsTo({project: "earth", seed: 42, name: "f0l4x3y5"}, worldA));
    check("a variant crop does not belong to a working planet",
        !Epoch.belongsTo({project: "thalos", seed: 42, variant: "vabc123"}, worldA));
    check("a working crop does not belong to a variant",
        !Epoch.belongsTo({project: "thalos", seed: 42}, variant));
    check("numeric and string seeds of the same value match",
        Epoch.belongsTo({project: "thalos", seed: "42"}, worldA));
}

/* 2. A late catalog / DEM / job for the previous world is dropped. */
{
    const epoch = Epoch.createEpoch();
    epoch.begin(worldA);
    const askedA = epoch.beginLoad();
    epoch.begin(worldB);
    const askedB = epoch.beginLoad();
    check("a fetch started for the last world is not current",
        !epoch.stillCurrent(askedA) && !epoch.stillSameWorld(askedA));
    check("a fetch started for this world is current",
        epoch.stillCurrent(askedB) && epoch.stillSameWorld(askedB));

    epoch.begin(worldA);
    const load1 = epoch.beginLoad();
    const load2 = epoch.beginLoad();
    check("an older load of the same world does not apply its catalog",
        !epoch.stillCurrent(load1) && epoch.stillCurrent(load2));
    check("an older load of the same world may still finish a DEM",
        epoch.stillSameWorld(load1) && epoch.stillSameWorld(load2));
}

/* 3. Colouring is bound to the mesh, not just the world. */
{
    const epoch = Epoch.createEpoch();
    epoch.begin(worldA);
    epoch.setPlanet(1);
    const asked = epoch.snapshot();
    epoch.setPlanet(2);
    check("a colouring from the last mesh is stale after regenerate",
        epoch.stillSameWorld(asked) && !epoch.stillSamePlanet(asked));
    check("the same planet id is not a change",
        epoch.setPlanet(2) === false);
}

/* 4. Same tile name on another world must not reuse the DEM or the paint. */
{
    const incomingB = {
        name: cropA.name,
        project: "thalos",
        seed: 99,
        variant: null,
        tile,
        elev: cropA.elev,
        elevWidth: 64,
        elevHeight: 64,
    };
    check("same tile name on another seed does not reuse the DEM",
        !Epoch.canReuseElev(cropA, incomingB, worldB));
    check("same tile name on another seed does not reuse the colouring",
        !Epoch.canReuseColor(cropA, incomingB, worldB, 1));

    const incomingA = Object.assign({}, incomingB, {seed: 42});
    check("the same world and the same elev may reuse the DEM",
        Epoch.canReuseElev(cropA, incomingA, worldA));
    check("colouring reuse also needs this planet id",
        Epoch.canReuseColor(cropA, incomingA, worldA, 1)
        && !Epoch.canReuseColor(cropA, incomingA, worldA, 2));

    const incomingNewBake = Object.assign({}, incomingA, {elevWidth: 128, elevHeight: 128});
    check("a new bake size does not keep the last DEM",
        !Epoch.canReuseElev(cropA, incomingNewBake, worldA));
}

/* 5. adoptCaches is the only way a catalog reload keeps a DEM. */
{
    const incoming = [{
        name: cropA.name,
        project: "thalos",
        seed: 99,
        variant: null,
        tile,
        elev: cropA.elev,
        elevWidth: 64,
        elevHeight: 64,
        elevM: null,
        imageEl: null,
    }];
    Epoch.adoptCaches(incoming, [cropA], worldB, 1);
    check("adoptCaches will not copy the last world's DEM onto this one",
        incoming[0].elevM == null && incoming[0].imageEl == null);

    const keep = [{
        name: cropA.name,
        project: "thalos",
        seed: 42,
        variant: null,
        tile,
        elev: "http://127.0.0.1:3748" + cropA.elev,
        elevWidth: 64,
        elevHeight: 64,
        elevM: null,
        imageEl: null,
    }];
    Epoch.adoptCaches(keep, [cropA], worldA, 1);
    check("adoptCaches keeps a DEM across a host-only URL change",
        keep[0].elevM === cropA.elevM && keep[0].imageEl === cropA.imageEl);
}

/* 6. The listing itself is strict: a seedless folder is not every seed. */
{
    const tmp = join(tmpdir(), `planetgen-td-epoch-${process.pid}`);
    const folder = join(tmp, "preview", "thalos", "crop-f0l4x3y5");
    await mkdir(folder, {recursive: true});
    await writeFile(join(folder, "output.elev"), new Uint8Array(16));
    await writeFile(join(folder, "output.elev.json"), JSON.stringify({width: 2, height: 2}));
    await writeFile(join(folder, "tile.json"), JSON.stringify({
        face: 0, level: 4, i: 3, j: 5, project: "thalos", seed: 42,
    }));
    const other = join(tmp, "preview", "thalos", "crop-f1l4x0y0");
    await mkdir(other, {recursive: true});
    await writeFile(join(other, "output.elev"), new Uint8Array(16));
    await writeFile(join(other, "output.elev.json"), JSON.stringify({width: 2, height: 2}));
    await writeFile(join(other, "tile.json"), JSON.stringify({face: 1, level: 4, i: 0, j: 0}));
    try {
        const bySeed = await listTdOverlays(tmp, {project: "thalos", seed: 42});
        const names = bySeed.crops.map((c) => c.name).sort();
        check("a seeded listing reads seed from tile.json",
            bySeed.crops.length === 1 && bySeed.crops[0].seed === 42,
            JSON.stringify(bySeed.crops.map((c) => ({name: c.name, seed: c.seed}))));
        check("a seeded listing drops a seedless folder",
            names.join() === "f0l4x3y5",
            names.join());
        const all = await listTdOverlays(tmp, {project: "thalos"});
        check("a listing without a seed still sees every folder",
            all.crops.length === 2);
    } finally {
        await rm(tmp, {recursive: true, force: true});
    }
}

/* 7. Overlay placement is the inverse of the tile raster, so a bake cannot
 * land next door to the grid cell it was picked from. */
{
    let bad = 0;
    let seed = 20260823;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let k = 0; k < 4000; k++) {
        const level = 1 + Math.floor(rnd() * 5);
        const n = 1 << level;
        const t = {
            face: Math.floor(rnd() * 6),
            level,
            i: Math.floor(rnd() * n),
            j: Math.floor(rnd() * n),
        };
        const s = rnd();
        const u = rnd();
        const ll = Cube.tileLonLat(t, s, u);
        const px = Cube.tilePixel(t, ll.lon, ll.lat, 256, 256);
        if (!px || Math.abs(px.x - s * 256) > 1e-4 || Math.abs(px.y - u * 256) > 1e-4) bad++;
    }
    check("tileLonLat is the inverse of tilePixel", bad === 0, `${bad} misplaced`);
}

check("earth's token is a seed, not a wildcard",
    Epoch.belongsTo({project: "earth", seed: "Earth"}, earth)
    && !Epoch.belongsTo({project: "earth", seed: 1003}, earth));

console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
