#!/usr/bin/env bun
/**
 * Check that projects resolve, and that loading one clears the last one.
 *
 *   bun run check:projects
 *
 * The interesting case is not that Earth's pins apply — it is that Thalos,
 * which does not pin cratons, comes back with the default after Earth has
 * been loaded. A project names what is decided; everything it omits has to
 * return to its default, or switching projects yields a planet that belongs
 * to neither and cannot be reproduced from either file.
 *
 * Browser-free, so this runs alongside `stats` and `check:earth`.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Projects = require(join(root, "src", "projects"));
const Params = require(join(root, "src", "params.js"));

const failures = [];
const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else { console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
};

console.log("projects");

check("default project is thalos", Projects.DEFAULT === "thalos");

/* 1. Every project resolves and validates. */
for (const project of Projects.PROJECTS) {
    let resolved = null, error = null;
    try { resolved = Projects.resolve(project.name); } catch (e) { error = e; }
    check(`${project.name} resolves`, !!resolved, error && error.message);
    if (resolved) {
        console.log(`        ${resolved.pins.length} pin(s), seed ${JSON.stringify(resolved.seed)}`);
    }
}

/* 2. Earth's pins actually land, in the right module. */
const earth = Projects.resolve("earth");
check("earth pins continentFraction into tectonics",
    earth.options.tectonics.continentFraction === 0.41,
    `got ${earth.options.tectonics.continentFraction}`);
check("earth pins cratons into tectonics",
    earth.options.tectonics.cratons === 9,
    `got ${earth.options.tectonics.cratons}`);
check("earth keeps its fixture params out of the module options",
    !("paintPasses" in earth.options.tectonics)
    && !("paintPasses" in earth.options.detail)
    && !("paintPasses" in earth.options.climate));
check("earth pins fixture paintPasses into fixture",
    earth.options.fixture.paintPasses === 6,
    `got ${earth.options.fixture && earth.options.fixture.paintPasses}`);

/* 3. The one that matters: an unpinned parameter comes back. */
const pristineCratons = Projects.PRISTINE.tectonics.cratons;
const thalos = Projects.resolve("thalos");
check("thalos does not inherit earth's cratons",
    thalos.options.tectonics.cratons === pristineCratons,
    `got ${thalos.options.tectonics.cratons}, want the default ${pristineCratons}`);
check("thalos does not inherit earth's continentFraction",
    thalos.options.tectonics.continentFraction === Projects.PRISTINE.tectonics.continentFraction,
    `got ${thalos.options.tectonics.continentFraction}`);

/* 4. Resolving must not write through to the snapshot or the live defaults. */
const before = Projects.PRISTINE.tectonics.cratons;
Projects.resolve("earth").options.tectonics.cratons = 999;
check("resolving does not mutate the pristine snapshot",
    Projects.PRISTINE.tectonics.cratons === before,
    `snapshot is now ${Projects.PRISTINE.tectonics.cratons}`);

/* 5. The panel resolves every exposed parameter's default from the pristine
      snapshot, so a module missing from it would render "free" forever. */
for (const name of Params.exposed()) {
    const meta = Params.all()[name];
    const snapshot = Projects.PRISTINE[meta.module];
    check(`${name} has a pristine default (${meta.module})`,
        snapshot !== undefined && name in snapshot,
        snapshot === undefined ? `no snapshot for module ${meta.module}` : "missing key");
}

/* 6. The panel's own gesture: pin a value, then free it, and the value has
      to come back to the default rather than stick. */
{
    const pins = {cratons: 9};
    const pinned = Projects.resolve({name: "scratch", values: pins}).options.tectonics.cratons;
    delete pins.cratons;
    const freed = Projects.resolve({name: "scratch", values: pins}).options.tectonics.cratons;
    check("freeing a pinned parameter restores its default",
        pinned === 9 && freed === Projects.PRISTINE.tectonics.cratons,
        `pinned ${pinned}, freed ${freed}`);
}

/* 7. Derivations must survive a project being applied, and applying one
 *    must not write through to the live DEFAULTS. The runner freezes a
 *    snapshot; World.derive still measures itself against the frozen EARTH
 *    constant, not against those defaults.
 */
{
    const World = require(join(root, "src", "world.js"));
    const Tectonics = require(join(root, "src", "tectonics.js"));
    const Pipeline = require(join(root, "packages/pipeline"));
    const beforeRadius = World.DEFAULTS.radiusKm;
    const beforePlates = Tectonics.DEFAULTS.plates;
    const implicit = Pipeline.freezeConfig({});
    const config = Pipeline.freezeConfig({project: "thalos"});
    const derived = config.derived;

    check("no project defaults to thalos",
        implicit.project === "thalos" && implicit.seed === 1003,
        `project ${implicit.project}, seed ${implicit.seed}`);
    check("earth seed selects the earth project",
        Pipeline.freezeConfig({seed: "earth"}).project === "earth"
        && Pipeline.freezeConfig({seed: "earth"}).options.world.radiusKm === 6371);
    check("freezeConfig does not mutate World.DEFAULTS",
        World.DEFAULTS.radiusKm === beforeRadius,
        `live radius is now ${World.DEFAULTS.radiusKm}`);
    check("freezeConfig does not mutate Tectonics.DEFAULTS",
        Tectonics.DEFAULTS.plates === beforePlates,
        `live plates is now ${Tectonics.DEFAULTS.plates}`);
    check("radius still scales plate count after a project is applied",
        derived.plates === 10, `got ${derived.plates}, want 10 at half Earth's radius`);
    check("radius still scales craton count after a project is applied",
        derived.cratons === 3, `got ${derived.cratons}, want 3`);
    check("gravity still scales relief after a project is applied",
        Math.abs(derived.orogenyReliefM - 2200 / 0.91) < 1,
        `got ${derived.orogenyReliefM}, want ${(2200 / 0.91).toFixed(0)}`);
    check("rotation still moves the dry belt after a project is applied",
        Math.abs(derived.subsidenceCentre - 26 * Math.sqrt(21.3 / 24)) < 0.01,
        `got ${derived.subsidenceCentre}`);
}

/* 8. Every pin names a registered parameter (the registry check, per project). */
for (const project of Projects.PROJECTS) {
    const problems = Params.checkProject(project);
    check(`${project.name} validates against the registry`, problems.length === 0, problems.join("; "));
}

/* 9. Pipeline status is authored per project against the shared stage list. */
{
    const ids = Projects.STAGES.map(s => s.id);
    check("pipeline stages are unique", new Set(ids).size === ids.length);
    for (const project of Projects.PROJECTS) {
        const problems = Projects.checkPipeline(project);
        check(`${project.name} pipeline validates`, problems.length === 0, problems.join("; "));
    }
    check("thalos has started the base",
        Projects.byName("thalos").pipeline.base === "in play");
    check("earth base is the locked fixture",
        Projects.byName("earth").pipeline.base === "fixture locked");
    check("a project's artifacts live under preview/<name>",
        Projects.dir("thalos") === "preview/thalos"
        && Projects.bakeDir("earth") === "preview/earth");
    check("sameSeed treats earth tokens as equal",
        Projects.sameSeed("earth", "Earth") && !Projects.sameSeed("earth", 1003));
}

console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
