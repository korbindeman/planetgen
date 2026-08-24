#!/usr/bin/env bun
/**
 * Check the pipeline contract: frozen config, Planet document, named stages.
 *
 *   bun run check:pipeline
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Pipeline = require(join(root, "packages/pipeline"));
const Planet = require(join(root, "src", "planet.js"));
const SphereMesh = require(join(root, "src", "sphere-mesh.js"));
const World = require(join(root, "src", "world.js"));
const Tectonics = require(join(root, "src", "tectonics.js"));
const Bake = require(join(root, "packages/bake"));
const Hydrology = require(join(root, "packages/hydrology"));
const {makeRandFloat} = require("@redblobgames/prng");

const failures = [];
const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else { console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
};

console.log("pipeline");

check("stage order is tectonics → climate → detail → erosion → seaLevel → geometry",
    Pipeline.STAGE_ORDER.join(",") === "tectonics,climate,detail,erosion,seaLevel,geometry",
    Pipeline.STAGE_ORDER.join(","));

const beforeRadius = World.DEFAULTS.radiusKm;
const beforePlates = Tectonics.DEFAULTS.plates;
const config = Pipeline.freezeConfig({project: "thalos", n: 4000, simSteps: 2, quiet: true});
check("config is frozen", Object.isFrozen(config) && Object.isFrozen(config.options.world));
check("body comes from the world bag",
    config.options.world.radiusKm === 3186,
    `got ${config.options.world.radiusKm}`);
check("DEFAULTS stay pristine after freezeConfig",
    World.DEFAULTS.radiusKm === beforeRadius && Tectonics.DEFAULTS.plates === beforePlates);
check("assertPristineDefaults is clean",
    Pipeline.assertPristineDefaults().length === 0,
    Pipeline.assertPristineDefaults().join("; "));

const planet = Pipeline.createPlanet(config);
check("document has config, body, sim, detail, geometry",
    planet.config === config
    && planet.body.radiusKm === 3186
    && planet.sim === null
    && planet.detail === null
    && planet.geometry === null);

console.log("  run   short generate (n=4000, detailN=5000, steps=2)");
const ran = Planet.generatePlanet({
    seed: 7,
    n: 4000,
    detailN: 5000,
    simSteps: 2,
    quiet: true,
});
check("run writes sim and geometry", !!(ran.sim && ran.sim.mesh && ran.geometry));
check("run writes detail when detailN > n", !!(ran.detail && ran.detail.mesh));
check("legacy aliases still point at the visible layer",
    ran.mesh === ran.detail.mesh && ran.map === ran.detail.map && ran.simMesh === ran.sim.mesh);
check("DEFAULTS stay pristine after a run",
    Pipeline.assertPristineDefaults().length === 0,
    Pipeline.assertPristineDefaults().join("; "));

const skipped = Planet.generatePlanet({
    seed: 7,
    n: 4000,
    detailPass: false,
    simSteps: 2,
    quiet: true,
});
check("detail is absent when the pass is off", skipped.detail == null);
check("surface is then the sim",
    skipped.mesh === skipped.sim.mesh);

/* A later seed must not keep the first seed's mesh jitter. The tables used
 * to be process-global and fill-once, so opening one variant (or a search
 * tile) made every later recipe a different planet until refresh. */
{
    const xyzHead = (r_xyz) => Array.from(r_xyz.slice(0, 12), (x) => x.toFixed(8)).join(",");
    const isolatedA = SphereMesh.makeSphere(400, 0.75, makeRandFloat(11), {lat: [], lon: []});
    const isolatedB = SphereMesh.makeSphere(400, 0.75, makeRandFloat(99), {lat: [], lon: []});
    const defaultA = SphereMesh.makeSphere(400, 0.75, makeRandFloat(11));
    check("mesh jitter follows the current seed, not the last sphere",
        xyzHead(isolatedA.r_xyz) === xyzHead(defaultA.r_xyz)
        && xyzHead(isolatedA.r_xyz) !== xyzHead(isolatedB.r_xyz),
        `isolated=${xyzHead(isolatedA.r_xyz)} default=${xyzHead(defaultA.r_xyz)}`);
}

let bakeThrew = false;
try { Bake.run(); } catch (e) { bakeThrew = /named slot/.test(e.message); }
check("bake stub refuses to pretend it exists", bakeThrew);

let hydroThrew = false;
try { Hydrology.run(); } catch (e) { hydroThrew = /named slot/.test(e.message); }
check("hydrology stub refuses to pretend it exists", hydroThrew);

console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
