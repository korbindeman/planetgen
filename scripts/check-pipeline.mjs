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
check("layout generate does not run Shape unless asked",
    config.detailPass === false);
check("shape cell count follows 23 km on Thalos",
    config.options.detail.n === World.regionsForSpacingKm(23, {radiusKm: 3186}),
    `got ${config.options.detail.n}`);

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
    detailPass: true,
    simSteps: 2,
    quiet: true,
});
check("run writes sim and geometry", !!(ran.sim && ran.sim.mesh && ran.geometry));
check("run writes detail when detailN > n", !!(ran.detail && ran.detail.mesh));
{
    const m = ran.sim.map;
    let peakOk = !!(m.r_arcPeak && m.r_arcAge && m.r_hotspotPeak && m.r_hotspotAge && m.r_arcDir);
    if (peakOk) {
        for (let r = 0; r < m.r_arc.length; r++) {
            if (m.r_arcPeak[r] + 1e-5 < m.r_arc[r]) peakOk = false;
            if (m.r_hotspotPeak[r] + 1e-5 < m.r_hotspot[r]) peakOk = false;
        }
    }
    check("Layout keeps lifetime peak at least present", peakOk);
}
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

{
    const Shape = require(join(root, "src", "shape-artifact.js"));
    const packed = Shape.fromMap(ran.detail.map, {
        n: 5000, jitter: 0.75, shapeSeed: 7, spacingKm: 23,
    });
    const fields = Shape.toFields(packed);
    check("shape artifact round-trips metres",
        !!(packed && fields && fields.cells === ran.detail.mesh.numRegions
            && fields.r_elevation && fields.r_elevation[0] === ran.detail.map.r_elevation[0]));
    check("shape artifact keeps Layout story maps",
        !!(fields.r_arcPeak && fields.r_arcAge && fields.r_hotspotPeak
            && fields.r_hotspotAge && fields.r_arcDir && fields.r_orogenyDir
            && fields.r_boundary));
    const laid = Planet.generatePlanet({
        seed: 7, n: 4000, detailPass: false, simSteps: 2, quiet: true,
    });
    const applied = Pipeline.stages.applyShapeFields(laid, fields, {});
    Pipeline.toLegacy(laid);
    check("a cached sketch attaches without rerunning Shape",
        applied && laid.detail && laid.mesh === laid.detail.mesh
        && laid.map.r_elevation[0] === ran.detail.map.r_elevation[0]);
}

{
    const cache = {};
    const laid = Planet.generatePlanet({
        seed: 7, n: 4000, detailPass: false, simSteps: 2, quiet: true,
    }, cache);
    const simMap = laid.sim.map;
    const shaped = Planet.generatePlanet({
        seed: 7, n: 4000, detailN: 5000, detailPass: true, shapeSeed: 99,
        simSteps: 2, quiet: true,
    }, cache);
    check("Shape reuses the layout sim and does not rerun tectonics",
        shaped.sim.map === simMap && !!shaped.detail);
    const other = Planet.generatePlanet({
        seed: 8, n: 4000, detailPass: false, simSteps: 2, quiet: true,
    }, cache);
    check("a new layout seed does not reuse the previous sim",
        other.sim.map !== simMap);
}

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
