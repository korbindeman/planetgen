#!/usr/bin/env bun
/**
 * Check that presets resolve, and that loading one clears the last one.
 *
 *   bun run check:presets
 *
 * The interesting case is not that Earth's pins apply — it is that Thalos,
 * which pins nothing, comes back with the *default* nine-cratons-ago value
 * after Earth has been loaded. A preset names what is decided; everything it
 * omits has to return to its default, or switching presets yields a planet
 * that belongs to neither and cannot be reproduced from either file.
 *
 * Browser-free, so this runs alongside `stats` and `check:earth`.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Presets = require(join(root, "src", "presets"));
const Params = require(join(root, "src", "params.js"));

const failures = [];
const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else { console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
};

console.log("presets");

/* 1. Every preset resolves and validates. */
for (const preset of Presets.PRESETS) {
    let resolved = null, error = null;
    try { resolved = Presets.resolve(preset.name); } catch (e) { error = e; }
    check(`${preset.name} resolves`, !!resolved, error && error.message);
    if (resolved) {
        console.log(`        ${resolved.pins.length} pin(s), seed ${JSON.stringify(resolved.seed)}`);
    }
}

/* 2. Earth's pins actually land, in the right module. */
const earth = Presets.resolve("earth");
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
const pristineCratons = Presets.PRISTINE.tectonics.cratons;
const thalos = Presets.resolve("thalos");
check("thalos does not inherit earth's cratons",
    thalos.options.tectonics.cratons === pristineCratons,
    `got ${thalos.options.tectonics.cratons}, want the default ${pristineCratons}`);
check("thalos does not inherit earth's continentFraction",
    thalos.options.tectonics.continentFraction === Presets.PRISTINE.tectonics.continentFraction,
    `got ${thalos.options.tectonics.continentFraction}`);

/* 4. Resolving must not write through to the snapshot or the live defaults. */
const before = Presets.PRISTINE.tectonics.cratons;
Presets.resolve("earth").options.tectonics.cratons = 999;
check("resolving does not mutate the pristine snapshot",
    Presets.PRISTINE.tectonics.cratons === before,
    `snapshot is now ${Presets.PRISTINE.tectonics.cratons}`);

/* 5. The panel resolves every exposed parameter's default from the pristine
      snapshot, so a module missing from it would render "free" forever. */
for (const name of Params.exposed()) {
    const meta = Params.all()[name];
    const snapshot = Presets.PRISTINE[meta.module];
    check(`${name} has a pristine default (${meta.module})`,
        snapshot !== undefined && name in snapshot,
        snapshot === undefined ? `no snapshot for module ${meta.module}` : "missing key");
}

/* 6. The panel's own gesture: pin a value, then free it, and the value has
      to come back to the default rather than stick. */
{
    const pins = {cratons: 9};
    const pinned = Presets.resolve({name: "scratch", values: pins}).options.tectonics.cratons;
    delete pins.cratons;
    const freed = Presets.resolve({name: "scratch", values: pins}).options.tectonics.cratons;
    check("freeing a pinned parameter restores its default",
        pinned === 9 && freed === Presets.PRISTINE.tectonics.cratons,
        `pinned ${pinned}, freed ${freed}`);
}

/* 7. Derivations must survive a preset being applied, and applying one
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
    const config = Pipeline.freezeConfig({preset: "thalos"});
    const derived = config.derived;

    check("freezeConfig does not mutate World.DEFAULTS",
        World.DEFAULTS.radiusKm === beforeRadius,
        `live radius is now ${World.DEFAULTS.radiusKm}`);
    check("freezeConfig does not mutate Tectonics.DEFAULTS",
        Tectonics.DEFAULTS.plates === beforePlates,
        `live plates is now ${Tectonics.DEFAULTS.plates}`);
    check("radius still scales plate count after a preset is applied",
        derived.plates === 10, `got ${derived.plates}, want 10 at half Earth's radius`);
    check("radius still scales craton count after a preset is applied",
        derived.cratons === 3, `got ${derived.cratons}, want 3`);
    check("gravity still scales relief after a preset is applied",
        Math.abs(derived.orogenyReliefM - 2200 / 0.91) < 1,
        `got ${derived.orogenyReliefM}, want ${(2200 / 0.91).toFixed(0)}`);
    check("rotation still moves the dry belt after a preset is applied",
        Math.abs(derived.subsidenceCentre - 26 * Math.sqrt(21.3 / 24)) < 0.01,
        `got ${derived.subsidenceCentre}`);
}

/* 8. Every pin names a registered parameter (the registry check, per preset). */
for (const preset of Presets.PRESETS) {
    const problems = Params.checkPreset(preset);
    check(`${preset.name} validates against the registry`, problems.length === 0, problems.join("; "));
}

console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
