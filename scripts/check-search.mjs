#!/usr/bin/env bun
/**
 * Hold the range-search loop to its invariants.
 *
 *   bun run check:search
 *
 * Genes, sample bounds, fitted overlay ⊆ vouched, zero likes leave a
 * failed pocket, and Done writes ranges without pinning or touching
 * DEFAULTS.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Params = require(join(root, "src", "params.js"));
const Search = require(join(root, "src", "search.js"));
const Projects = require(join(root, "src", "projects"));
const Tectonics = require(join(root, "src", "tectonics.js"));
const World = require(join(root, "src", "world.js"));

const failures = [];
const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else { console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
};

const inside = (value, range) => value >= range[0] && value <= range[1];
const subset = (inner, outer) => inner[0] >= outer[0] && inner[1] <= outer[1];
const width = (range) => range[1] - range[0];

const savedOverlay = Params.getOverlay();

console.log("search");

/* 1. Genes are freeable minus the project's pins. */
{
    const thalos = Projects.byName("thalos").values;
    const genes = Search.genesFor(thalos);
    const expected = [
        "steps", "plates", "cratons", "continentFraction",
        "hotspots", "landFraction", "ageGyr",
    ].sort();
    check("thalos genes are the unpinned freeable set",
        genes.slice().sort().join() === expected.join(),
        `got ${genes.join(", ")}`);
    for (const name of Object.keys(thalos)) {
        check(`thalos pin ${name} is not a gene`, !genes.includes(name));
    }
    const earth = Search.genesFor(Projects.byName("earth").values);
    check("earth genes omit continentFraction and cratons",
        !earth.includes("continentFraction") && !earth.includes("cratons"));
}

/* 2. Gen 0 samples stay inside the current range. */
{
    const values = Projects.byName("thalos").values;
    const gen = Search.initialPopulation({values, count: 24, rng: 7});
    check("gen 0 has the asked count", gen.population.length === 24);
    let ok = true;
    for (const ind of gen.population) {
        if (!(ind.seed >= 1)) ok = false;
        for (const name of gen.genes) {
            if (!inside(ind.values[name], gen.ranges[name])) ok = false;
        }
    }
    check("gen 0 samples stay inside the current range", ok);
    const seeds = new Set(gen.population.map((ind) => ind.seed));
    check("each tile gets its own seed", seeds.size === gen.population.length);
}

/* 3. A liked generation tightens toward the likes and stays vouched. */
{
    const values = Projects.byName("thalos").values;
    const gen0 = Search.initialPopulation({values, count: 16, rng: 11});
    const liked = [0, 1, 2];
    const gen1 = Search.nextGeneration({
        ...gen0, liked, count: 16, rng: 13,
    });
    let samplesOk = true;
    let overlayOk = true;
    for (const name of gen1.genes) {
        if (!subset(gen1.ranges[name], gen1.vouched[name])) overlayOk = false;
        for (const ind of gen1.population) {
            if (!inside(ind.values[name], gen1.ranges[name])) samplesOk = false;
            if (!inside(ind.values[name], gen1.vouched[name])) samplesOk = false;
        }
    }
    check("fitted overlay is a subset of the vouched range", overlayOk);
    check("next-gen samples stay inside the fitted range", samplesOk);
    const nextSeeds = new Set(gen1.population.map((ind) => ind.seed));
    const prevSeeds = new Set(gen0.population.map((ind) => ind.seed));
    check("next generation replaces the sheet",
        ![...nextSeeds].some((s) => prevSeeds.has(s)));
}

/* 4. Zero likes inflate toward the vouched range, not stay in the pocket. */
{
    Params.setOverlay({continentFraction: [0.40, 0.44]});
    const values = Projects.byName("thalos").values;
    const gen0 = Search.initialPopulation({values, count: 8, rng: 3});
    const tight = gen0.ranges.continentFraction;
    const vouched = gen0.vouched.continentFraction;
    check("test overlay tightened continentFraction",
        width(tight) < width(vouched) - 0.05,
        `tight ${tight} vouched ${vouched}`);
    const gen1 = Search.nextGeneration({
        ...gen0, liked: [], count: 8, rng: 5,
    });
    check("zero likes inflates the failed pocket",
        width(gen1.ranges.continentFraction) > width(tight) + 1e-9,
        `was ${tight}, now ${gen1.ranges.continentFraction}`);
    check("inflated range stays inside vouched",
        subset(gen1.ranges.continentFraction, vouched));
    Params.setOverlay(savedOverlay);
}

/* 5. Done writes ranges and does not pin or change DEFAULTS. */
{
    const pinsBefore = Object.assign({}, Projects.byName("thalos").values);
    const tectonicsBefore = Object.assign({}, Tectonics.DEFAULTS);
    const worldBefore = Object.assign({}, World.DEFAULTS);
    const values = Projects.byName("thalos").values;
    const gen = Search.initialPopulation({values, count: 12, rng: 17});
    const done = Search.rangesFromLikes({
        ...gen, liked: [0, 1, 2, 3],
    });
    Params.setOverlay(done);
    check("Done overlay validates", Params.checkOverlay(done).length === 0,
        Params.checkOverlay(done).join("; "));

    const pinsAfter = Projects.byName("thalos").values;
    let pinsOk = true;
    for (const name of Object.keys(pinsBefore)) {
        if (pinsAfter[name] !== pinsBefore[name]) pinsOk = false;
    }
    check("Done does not add pins",
        Object.keys(pinsAfter).length === Object.keys(pinsBefore).length && pinsOk);

    let tectOk = true;
    for (const name of Object.keys(tectonicsBefore)) {
        if (Tectonics.DEFAULTS[name] !== tectonicsBefore[name]) tectOk = false;
    }
    let worldOk = true;
    for (const name of Object.keys(worldBefore)) {
        if (World.DEFAULTS[name] !== worldBefore[name]) worldOk = false;
    }
    check("Done does not change tectonics DEFAULTS", tectOk);
    check("Done does not change world DEFAULTS", worldOk);

    const resolved = Projects.resolve("thalos");
    check("thalos still does not pin continentFraction",
        !("continentFraction" in Projects.byName("thalos").values)
        && resolved.options.tectonics.continentFraction === Projects.PRISTINE.tectonics.continentFraction);

    Params.setOverlay(savedOverlay);
}

/* 6. A rejected overlay cannot leave the vouched interval. */
{
    const problems = Params.checkOverlay({continentFraction: [0.1, 0.9]});
    check("overlay outside vouched is rejected",
        problems.some((p) => p.includes("continentFraction")));
    const badName = Params.checkOverlay({notAParam: [0, 1]});
    check("unknown overlay keys are rejected", badName.length > 0);
}

/* 7. A search tile generate uses sampled values and does not pin. */
{
    const Planet = require(join(root, "src", "planet.js"));
    const values = Projects.byName("thalos").values;
    const gen = Search.initialPopulation({values, count: 1, rng: 19});
    const ind = gen.population[0];
    const pinsBefore = Object.assign({}, values);
    const platesBefore = Tectonics.DEFAULTS.plates;
    const planet = Planet.generatePlanet({
        seed: ind.seed,
        n: 4000,
        jitter: 0.75,
        detailPass: false,
        project: "thalos",
        values: Object.assign({}, values, ind.values),
        quiet: true,
    }, {});
    check("search tile produces a mesh",
        !!(planet && planet.mesh && planet.map && planet.mesh.numRegions > 0));
    const layers = Planet.rasterizeEquirect(planet.mesh, planet.map, 64, 32, 0);
    check("search tile rasterizes an equirect",
        !!(layers && layers.elev && layers.elev.length === 64 * 32));
    check("search generate does not pin the project file",
        Object.keys(Projects.byName("thalos").values).join() === Object.keys(pinsBefore).join()
        && Projects.byName("thalos").values.radiusKm === pinsBefore.radiusKm);
    check("search generate does not change DEFAULTS",
        Tectonics.DEFAULTS.plates === platesBefore);
}

Params.setOverlay(savedOverlay);

console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
