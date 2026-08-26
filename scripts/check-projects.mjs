#!/usr/bin/env bun
/**
 * Check that projects resolve, and that loading one clears the last one.
 *
 *   bun run check:projects
 *
 * The interesting case is not that Earth's fixture knobs apply — it is that
 * Thalos, which authors only a body, comes back with the default cratons
 * after Earth has been loaded. Switching must not leave a planet that
 * belongs to neither file.
 *
 * Browser-free, so this runs alongside `stats` and `check:earth`.
 */
import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { listTdOverlays } from "./td-overlays.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Projects = require(join(root, "src", "projects"));
const Params = require(join(root, "src", "params.js"));
const Boot = require(join(root, "src", "studio", "boot.js"));

const failures = [];
const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else { console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
};

console.log("projects");

check("default project is thalos", Projects.DEFAULT === "thalos");
for (const project of Projects.PROJECTS) {
    check(`${project.name} has a label`, typeof project.label === "string" && project.label.length > 0);
}

/* 1. Every project resolves and validates. */
for (const project of Projects.PROJECTS) {
    let resolved = null, error = null;
    try { resolved = Projects.resolve(project.name); } catch (e) { error = e; }
    check(`${project.name} resolves`, !!resolved, error && error.message);
    if (resolved) {
        console.log(`        ${resolved.applied.length} applied, seed ${JSON.stringify(resolved.seed)}`);
    }
}

/* 2. Earth's fixture knobs actually land, in the right module. */
const earth = Projects.resolve("earth");
check("earth is the fixture", Projects.isFixture("earth") && earth.fixture && earth.seed === "earth");
check("earth authors continentFraction into tectonics",
    earth.options.tectonics.continentFraction === 0.41,
    `got ${earth.options.tectonics.continentFraction}`);
check("earth authors cratons into tectonics",
    earth.options.tectonics.cratons === 9,
    `got ${earth.options.tectonics.cratons}`);
check("earth keeps its fixture params out of the module options",
    !("paintPasses" in earth.options.tectonics)
    && !("paintPasses" in earth.options.detail)
    && !("paintPasses" in earth.options.climate));
check("earth authors fixture paintPasses into fixture",
    earth.options.fixture.paintPasses === 6,
    `got ${earth.options.fixture && earth.options.fixture.paintPasses}`);

/* 3. The one that matters: an unpinned parameter comes back. */
const pristineCratons = Projects.PRISTINE.tectonics.cratons;
const thalos = Projects.resolve("thalos");
check("thalos is not a fixture and holds no seed",
    !Projects.isFixture("thalos") && Projects.byName("thalos").seed == null);
check("thalos does not inherit earth's cratons",
    thalos.options.tectonics.cratons === pristineCratons,
    `got ${thalos.options.tectonics.cratons}, want the default ${pristineCratons}`);
check("thalos does not inherit earth's continentFraction",
    thalos.options.tectonics.continentFraction === Projects.PRISTINE.tectonics.continentFraction,
    `got ${thalos.options.tectonics.continentFraction}`);
check("thalos applies its adopted body",
    thalos.options.world.radiusKm === 3186 && thalos.options.world.rotationHours === 21.3);

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

/* 6. A caller overlay replaces the authored bag. A missing key is free. */
{
    const overlay = {cratons: 9, radiusKm: 3186};
    const pinned = Projects.resolve({name: "thalos", values: overlay}).options.tectonics.cratons;
    delete overlay.cratons;
    const freed = Projects.resolve({name: "thalos", values: overlay}).options.tectonics.cratons;
    check("dropping a key from the overlay restores its default",
        pinned === 9 && freed === Projects.PRISTINE.tectonics.cratons,
        `applied ${pinned}, freed ${freed}`);
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
        implicit.project === "thalos" && implicit.seed === 1
        && implicit.options.world.radiusKm === 3186,
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
    check("pipeline stages are layout → export",
        ids.join(",") === "layout,shape,climate,terrain,hydrology,export",
        ids.join(","));
    for (const project of Projects.PROJECTS) {
        const problems = Projects.checkPipeline(project);
        check(`${project.name} pipeline validates`, problems.length === 0, problems.join("; "));
    }
    check("thalos has started layout",
        Projects.byName("thalos").pipeline.layout === "in play");
    check("earth layout is the locked fixture",
        Projects.byName("earth").pipeline.layout === "fixture locked");
    check("a project's artifacts live under preview/<name>",
        Projects.dir("thalos") === "preview/thalos"
        && Projects.bakeDir("earth") === "preview/earth");
    check("sameSeed treats earth tokens as equal",
        Projects.sameSeed("earth", "Earth") && !Projects.sameSeed("earth", 1003));
}

/* 9b. A variant is seed, body, genes, pins, ranges, parent. */
{
    const Variants = Projects.Variants;
    const pins = Object.assign({}, Projects.authored("thalos"));
    const sampled = {plates: 17, continentFraction: 0.44, radiusKm: pins.radiusKm};
    const variant = Variants.ofWorking({
        project: "thalos",
        seed: 4242,
        pins,
        values: sampled,
        name: "ridge",
    });
    check("variant keeps body off its gene bag",
        variant && !("radiusKm" in variant.values)
        && variant.body.radiusKm === pins.radiusKm
        && variant.values.plates === 17
        && variant.values.continentFraction === 0.44);
    check("variant pins are body-only",
        variant.pins.radiusKm === pins.radiusKm && !("plates" in variant.pins));
    check("variant keeps the seed and project",
        variant.seed === 4242 && variant.project === "thalos" && variant.name === "ridge");
    const child = Variants.ofWorking({
        project: "thalos",
        parent: variant.id,
        seed: 99,
        pins: variant.pins,
        values: {plates: 12},
    });
    const tree = [variant, child];
    check("a child inherits the parent's body pin",
        Variants.inheritedPins(tree, child).radiusKm === pins.radiusKm
        && child.parent === variant.id);
    const catalog = Variants.parseCatalog({
        project: "thalos",
        committed: variant.id,
        variants: [variant, {seed: 8, values: {plates: 11}, project: "thalos"}],
    }, "thalos");
    check("catalog keeps a committed id that is in the list",
        catalog.committed === variant.id && catalog.variants.length === 2);
    const committed = Variants.commit(catalog, catalog.variants[1].id);
    check("commit switches the instance without writing the project file",
        committed.committed === catalog.variants[1].id
        && !Projects.byName("thalos").values);
    const serialized = Variants.serializeCatalog({
        project: "thalos",
        variants: [Object.assign({}, variant, {thumb: "data:image/jpeg;base64,xx"})],
    }).variants[0];
    check("serializeCatalog drops thumbs and keeps the tree fields",
        !("thumb" in serialized)
        && serialized.body.radiusKm === pins.radiusKm
        && serialized.pins.radiusKm === pins.radiusKm);
    check("shaped survives parse and serialize",
        Variants.parseCatalog({
            project: "thalos",
            variants: [{id: variant.id, seed: 4242, values: {plates: 17}, shaped: true}],
        }, "thalos").variants[0].shaped === true
        && Variants.serializeCatalog({
            project: "thalos",
            variants: [Object.assign({}, variant, {shaped: true})],
        }).variants[0].shaped === true);
    const legacy = Projects.parseCatalog({
        project: "thalos",
        variants: [{id: "vold1", seed: 77, values: {plates: 14}}],
    }, "thalos");
    check("an old catalog row picks up the adopted body",
        legacy.variants[0].body.radiusKm === pins.radiusKm
        && legacy.variants[0].pins.radiusKm === pins.radiusKm
        && legacy.variants[0].values.plates === 14);
    check("parseCatalog keeps a file thumb",
        Variants.parseCatalog({
            project: "thalos",
            variants: [{id: variant.id, seed: 4242, values: {plates: 17}, thumb: "/preview/thalos/v/vabc/thumb.jpg"}],
        }, "thalos").variants[0].thumb === "/preview/thalos/v/vabc/thumb.jpg");
    check("stampThumb fills a matching recipe that has none",
        Variants.stampThumb([variant], variant, "data:image/jpeg;base64,xx")[0].thumb === "data:image/jpeg;base64,xx");
    check("stampThumb does not replace an existing thumb",
        Variants.stampThumb(
            [Object.assign({}, variant, {thumb: "old"})],
            variant,
            "new",
        )[0].thumb === "old");
    check("putThumb writes only that id",
        (() => {
            const other = Variants.ofWorking({project: "thalos", seed: 9, pins, values: {}});
            const next = Variants.putThumb([variant, other], other.id, "data:image/jpeg;base64,yy");
            return next[0].thumb == null && next[1].thumb === "data:image/jpeg;base64,yy";
        })());
    check("putThumb replace overwrites an existing thumb",
        Variants.putThumb(
            [Object.assign({}, variant, {thumb: "old"})],
            variant.id,
            "data:image/jpeg;base64,zz",
            true,
        )[0].thumb === "data:image/jpeg;base64,zz");
    check("bakeDir scopes a variant under v/<id>",
        Projects.bakeDir("thalos", variant.id) === `preview/thalos/v/${variant.id}`
        && Projects.bakeDir("earth") === "preview/earth");
    check("isVariantId accepts only v-prefixed ids",
        Projects.isVariantId(variant.id) && !Projects.isVariantId("abc"));
    const seedOnly = Variants.ofWorking({
        project: "thalos", seed: 1003, pins, values: {},
    });
    check("a seed-only save is a variant with an empty values bag",
        seedOnly && Object.keys(seedOnly.values).length === 0
        && seedOnly.body.radiusKm === pins.radiusKm);
    const migrated = Variants.migrate(
        [{seed: 7, values: {plates: 12}, project: "thalos"}],
        [{seed: 1003, name: "start"}],
        "thalos",
        pins,
    );
    check("legacy keeps and saved seeds migrate into variants",
        migrated.length === 2
        && migrated.some((v) => v.seed === 7 && v.values.plates === 12 && v.body.radiusKm === pins.radiusKm)
        && migrated.some((v) => v.seed === 1003 && v.name === "start"));
    check("toggle is by recipe, not by like index",
        Variants.toggleRecipe([], variant).length === 1
        && Variants.toggleRecipe([variant], variant).length === 0);
    check("refinement is 0 when ranges are empty",
        Variants.refinement(variant) === 0);
    const refined = Variants.ofWorking({
        project: "thalos", seed: 55, pins,
        values: {plates: 17},
        ranges: {continentFraction: [0.40, 0.44]},
    });
    check("refinement is tightness vs vouched",
        Variants.refinement(refined) > 0.5);
    const ancestor = Variants.ofWorking({
        project: "thalos", seed: 10, pins,
        values: {plates: 17},
    });
    const descendent = Variants.ofWorking({
        project: "thalos",
        parent: ancestor.id,
        seed: 11,
        pins,
        values: {plates: 12},
        ranges: {continentFraction: [0.40, 0.44]},
    });
    const rows = Variants.treeRows([descendent, ancestor]);
    check("tree rows walk parent then child",
        rows.length === 2
        && rows[0].variant.id === ancestor.id && rows[0].depth === 0
        && rows[1].variant.id === descendent.id && rows[1].depth === 1);
    check("the edge names what the child narrowed",
        rows[1].notes.some((note) => note.includes("crust")));
    const other = Variants.ofWorking({
        project: "thalos", seed: 12, pins, values: {plates: 10},
    });
    const pair = [variant, other];
    check("a deep-linked variant wins over last selected",
        Variants.resumeId({
            pendingId: other.id,
            lastId: variant.id,
            committed: variant.id,
            variants: pair,
        }) === other.id);
    check("switching a project resumes the last selected variant",
        Variants.resumeId({
            lastId: other.id,
            committed: variant.id,
            variants: pair,
        }) === other.id);
    check("a project with no last selected does not invent a variant",
        Variants.resumeId({committed: variant.id, variants: pair}) == null);
    check("an id that is not in the catalog is not a neighbour",
        Variants.resumeId({
            pendingId: "vmissing",
            lastId: "vmissing",
            committed: variant.id,
            variants: pair,
        }) == null);
    check("a variant in the query wins even when a seed is there",
        Variants.resumeId({
            pendingId: variant.id,
            lastId: other.id,
            committed: variant.id,
            variants: pair,
            seedFromQuery: true,
        }) === variant.id);
    check("a seed query with no variant id does not resume last",
        Variants.resumeId({
            lastId: other.id,
            variants: pair,
            seedFromQuery: true,
            querySeed: 1,
        }) == null);
    check("the address bar seed still resumes last when it matches",
        Variants.resumeId({
            lastId: variant.id,
            variants: pair,
            seedFromQuery: true,
            querySeed: variant.seed,
        }) === variant.id);
    check("a missing last id is still wanted so it can be restored",
        Variants.wantedId({
            lastId: "vmissingid1",
            variants: pair,
            seedFromQuery: true,
            querySeed: variant.seed,
        }) === "vmissingid1");
    check("the fixture has no variant to resume",
        Variants.resumeId({
            lastId: variant.id,
            committed: variant.id,
            variants: pair,
            fixture: true,
        }) == null);
    check("nothing is guessed when the catalog has no target",
        Variants.resumeId({variants: pair}) == null);
    const first = Variants.ofWorking({
        project: "thalos", seed: 21, pins, values: {plates: 16},
    });
    const same = Variants.ofWorking({
        project: "thalos", seed: 21, pins, values: {plates: 16},
    });
    check("dirty is false for the same recipe",
        !Variants.dirty(same, first) && Variants.sameRecipe(first, same));
    check("dirty is true when the working planet moved",
        Variants.dirty(Variants.ofWorking({
            project: "thalos", seed: 22, pins, values: {plates: 16},
        }), first));
    const grown = Variants.append([first], Variants.ofWorking({
        project: "thalos", seed: 23, pins, values: {plates: 11}, name: "ridge",
    }));
    check("a name appends a snapshot instead of updating the last one",
        grown.length === 2
        && grown[0].id !== first.id
        && grown[0].name === "ridge"
        && grown[1].id === first.id);
    const namedHead = Object.assign({}, first, {name: "interesting"});
    const moved = Variants.save(
        [namedHead],
        namedHead,
        Variants.ofWorking({project: "thalos", seed: first.seed, pins, values: {plates: 18}}),
    );
    check("a save with the same name is a new snapshot, not a child",
        moved.length === 2
        && moved[0].id !== first.id
        && !moved[0].parent
        && moved[0].name === "interesting"
        && moved[0].seed === first.seed
        && moved[0].values.plates === 18
        && moved[0].generation === 2
        && /^v\d{12,}$/.test(moved[0].id)
        && moved[1].id === first.id);
    const boxed = Variants.ofWorking({
        project: "thalos", seed: 21, pins, values: {plates: 16},
        name: "interesting",
        ranges: {continentFraction: [0.40, 0.44]},
    });
    const wet = Variants.save(
        [boxed],
        boxed,
        Variants.ofWorking({
            project: "thalos", seed: boxed.seed, pins, values: {plates: 16},
            name: "wet",
        }),
    );
    check("a new name keeps the ranges you were on",
        wet[0].name === "wet"
        && wet[0].ranges.continentFraction[0] === 0.40
        && wet[0].ranges.continentFraction[1] === 0.44
        && Variants.lineageRows(wet).length === 2
        && Variants.lineageRows(wet).every((row) => row.depth === 0));
    check("a new layout seed is a different planet, the same seed is not",
        Variants.differentPlanet(first, {seed: first.seed + 1})
        && !Variants.differentPlanet(first, {seed: first.seed}));
    check("an explore draw is a different planet even on the same seed",
        Variants.differentPlanet(first, {discover: true, seed: first.seed}));
    check("a name is not a different planet",
        !Variants.differentPlanet(first, {name: "ridge"}));
    const ranged = Variants.setRanges(moved, first.id, {continentFraction: [0.40, 0.44]});
    check("explore writes ranges without saving a node",
        ranged[1].id === first.id
        && ranged[1].generation === 1
        && ranged[1].ranges.continentFraction[0] === 0.40);
    const withShape = Variants.ofWorking({
        project: "thalos", seed: 21, shapeSeed: 99, pins, values: {plates: 16},
    });
    check("shape seed is part of the recipe and defaults to the layout seed",
        Variants.effectiveShapeSeed(first) === first.seed
        && withShape.shapeSeed === 99
        && Variants.dirty(withShape, first)
        && Variants.samePlanet(withShape, first));
    check("two versions may share a recipe",
        Variants.parseVariants([first, same], pins).length === 2);
    check("the latest save of a name is the tip",
        Variants.isLineageTip(moved, moved[0]) && !Variants.isLineageTip(moved, moved[1]));
    const headed = Variants.advanceHead({
        project: "thalos",
        committed: first.id,
        variants: grown,
    }, first.id, grown[0].id);
    check("the first save on a line can adopt that version",
        headed.committed === grown[0].id);
    const side = Variants.ofWorking({
        project: "thalos", seed: 30, pins, values: {plates: 9},
    });
    const sideChild = Variants.ofWorking({
        project: "thalos", seed: 31, pins, values: {plates: 8}, name: "wet",
    });
    const branched = Variants.advanceHead({
        project: "thalos",
        committed: first.id,
        variants: [sideChild, side, first],
    }, side.id, sideChild.id);
    check("a named branch leaves the committed head",
        branched.committed === first.id);
    const named = Object.assign({}, first, {name: "interesting"});
    const shaped = Variants.save(
        [named],
        named,
        Variants.ofWorking({project: "thalos", seed: named.seed, pins, values: {plates: 16}}),
    );
    const lineage = Variants.lineageRows(shaped);
    check("saves with the same name are one variant",
        lineage.length === 1
        && lineage[0].name === "interesting"
        && lineage[0].history.length === 2
        && lineage[0].variant.id === shaped[0].id
        && lineage[0].depth === 0);
    const fork = Variants.save(
        shaped,
        named,
        Variants.ofWorking({
            project: "thalos", seed: named.seed, pins, values: {plates: 12}, name: "wet",
        }),
    );
    const forkedRows = Variants.lineageRows(fork);
    check("a new name is another variant, not a descendant",
        forkedRows.length === 2
        && forkedRows.every((row) => row.depth === 0)
        && forkedRows.some((row) => row.name === "interesting")
        && forkedRows.some((row) => row.name === "wet"));
    const otherWorld = Variants.save(
        shaped,
        shaped[0],
        Variants.ofWorking({
            project: "thalos", seed: named.seed + 1, pins, values: {plates: 10}, name: "interesting",
        }),
    );
    const worlds = Variants.lineageRows(otherWorld);
    check("the same name continues that variant even on another seed",
        worlds.length === 1
        && worlds[0].name === "interesting"
        && worlds[0].history.length === 3);
    const trimmed = Variants.removeLineage(fork, fork[0].id);
    check("removing one name keeps the other",
        Variants.lineageRows(trimmed).length === 1
        && Variants.lineageRows(trimmed)[0].name === "interesting");
    const hidden = Variants.markLineage(fork, fork[0].id, true);
    check("delete marks a lineage and keeps the id",
        hidden.length === fork.length
        && hidden.some((item) => item.id === fork[0].id && item.deleted)
        && Variants.lineageRows(hidden).length === 1
        && Variants.lineageRows(hidden)[0].name === "interesting"
        && Variants.findById(hidden, fork[0].id).deleted);
    const restored = Variants.markLineage(hidden, fork[0].id, false);
    check("clearing deleted puts the card back",
        Variants.lineageRows(restored).some((row) => row.name === "wet")
        && !Variants.findById(restored, fork[0].id).deleted);
    const gone = Variants.markLineage(fork, fork[0].id, true);
    check("a deleted recipe is not a kept save",
        !Variants.findByRecipe(gone, fork[0])
        && !!Variants.findByRecipe(fork, fork[0]));
    check("resume skips a deleted checkout",
        Variants.resumeId({lastId: fork[0].id, variants: gone}) == null);
    const roundTrip = Variants.serializeCatalog({
        project: "thalos",
        variants: Variants.parseVariants(gone, pins),
    });
    check("serialize stores deleted and keeps the id",
        roundTrip.variants.some((item) => item.id === fork[0].id && item.deleted)
        && roundTrip.variants.length === gone.length);
    const layoutRoot = Variants.ofWorking({
        project: "thalos", seed: 77, pins, values: {plates: 14}, name: "interesting",
    });
    const shapeRoot = Object.assign({}, Variants.ofWorking({
        project: "thalos", seed: 77, pins, values: {plates: 14},
    }), {shaped: true});
    const coalescedRows = Variants.lineageRows(Variants.parseVariants([shapeRoot, layoutRoot], pins));
    check("an unnamed snapshot is not folded into a named one",
        coalescedRows.length === 2);
    const namedA = Variants.ofWorking({
        project: "thalos", seed: 88, pins, values: {plates: 14}, name: "interesting",
    });
    const namedB = Variants.ofWorking({
        project: "thalos", seed: 88, pins, values: {plates: 14}, name: "other",
    });
    check("two names are two variants even on the same seed",
        Variants.lineageRows(Variants.parseVariants([namedB, namedA], pins)).length === 2);
    const buried = Object.assign({}, namedA, {parent: namedB.id});
    const recovered = Variants.lineageRows([namedB, buried]);
    check("a parent pointer does not nest a differently named variant",
        recovered.length === 2
        && recovered.every((row) => row.depth === 0)
        && recovered.some((row) => row.name === "interesting")
        && recovered.some((row) => row.name === "other"));
    const diskOnly = Variants.parseCatalog({
        project: "thalos",
        variants: [{id: "vdisk1", seed: 11, name: "gloop inland sea", project: "thalos"}],
    }, "thalos");
    const cacheExtra = Variants.parseCatalog({
        project: "thalos",
        variants: [
            {id: "vcache1", seed: 22, name: "interesting", project: "thalos"},
            {id: "vdisk1", seed: 11, project: "thalos"},
        ],
    }, "thalos");
    const merged = Variants.mergeCatalogs(diskOnly, cacheExtra);
    check("merging catalogs keeps every id and does not drop a name",
        merged.variants.length === 2
        && merged.variants.some((item) => item.name === "interesting")
        && merged.variants.some((item) => item.name === "gloop inland sea"));
    const shrunk = Variants.mergeCatalogs(diskOnly, cacheExtra);
    check("a smaller incoming catalog does not delete the rest",
        shrunk.variants.length === 2);
    const dropped = Variants.applyDrop(merged, ["vcache1"]);
    check("drop is the only way an id leaves the catalog",
        dropped.variants.length === 1
        && dropped.variants[0].id === "vdisk1");
    const ghost = Variants.ofWorking({
        project: "thalos", seed: 99, pins, values: {plates: 10}, name: "interesting",
    });
    const listed = Variants.lineageRows(diskOnly.variants, ghost);
    check("a checkout missing from the catalog still has a card",
        listed.length === 2
        && listed.some((row) => row.name === "interesting")
        && listed.some((row) => row.name === "gloop inland sea"));
    check("serialize stores the name and not a parent",
        Variants.serializeCatalog({
            project: "thalos",
            variants: Variants.parseVariants([named], pins),
        }).variants[0].name === "interesting"
        && !("parent" in Variants.serializeCatalog({
            project: "thalos",
            variants: Variants.parseVariants([named], pins),
        }).variants[0])
        && !("lineage" in Variants.serializeCatalog({
            project: "thalos",
            variants: Variants.parseVariants([named], pins),
        }).variants[0]));
}

/* 10. A crop is a folder. Whatever files it holds, the directory is what
 * the catalog lists — so a DEM without a PNG, or a tile sidecar without a
 * GeoTIFF, still appears. */
{
    const root = join(tmpdir(), `planetgen-td-overlays-${process.pid}`);
    const folder = join(root, "preview", "earth", "crop-f3l4x1y2");
    await mkdir(folder, {recursive: true});
    await writeFile(join(folder, "output.elev"), new Uint8Array(16));
    await writeFile(join(folder, "output.elev.json"), JSON.stringify({width: 2, height: 2}));
    await writeFile(join(folder, "tile.json"), JSON.stringify({face: 3, level: 4, i: 1, j: 2}));
    try {
        const listed = await listTdOverlays(root, {project: "earth"});
        const crop = listed.crops.find((c) => c.name === "f3l4x1y2");
        check("a crop folder is listed from what it contains",
            !!(crop && crop.baked && crop.elev && crop.tile && crop.elevWidth === 2),
            crop ? JSON.stringify({baked: crop.baked, elev: crop.elev, tile: crop.tile}) : "missing");
        check("the catalog is the folders, not a job merge",
            listed.crops.length === 1 && listed.crops[0].name === "f3l4x1y2");
    } finally {
        await rm(root, {recursive: true, force: true});
    }
}

/* 10b. A variant's crops live under v/<id>/ and do not leak into the
 * project-root listing. */
{
    const root = join(tmpdir(), `planetgen-td-variant-${process.pid}`);
    const variantId = "vabc123";
    const rootFolder = join(root, "preview", "thalos", "crop-root");
    const variantFolder = join(root, "preview", "thalos", "v", variantId, "crop-hid");
    await mkdir(rootFolder, {recursive: true});
    await mkdir(variantFolder, {recursive: true});
    await writeFile(join(rootFolder, "output.elev"), new Uint8Array(16));
    await writeFile(join(rootFolder, "output.elev.json"), JSON.stringify({width: 2, height: 2}));
    await writeFile(join(rootFolder, "tile.json"), JSON.stringify({face: 3, level: 4, i: 1, j: 2}));
    await writeFile(join(variantFolder, "output.elev"), new Uint8Array(16));
    await writeFile(join(variantFolder, "output.elev.json"), JSON.stringify({width: 2, height: 2}));
    await writeFile(join(variantFolder, "tile.json"), JSON.stringify({face: 0, level: 4, i: 0, j: 0}));
    try {
        const atRoot = await listTdOverlays(root, {project: "thalos"});
        const atVariant = await listTdOverlays(root, {project: "thalos", variant: variantId});
        check("listing without a variant does not walk v/",
            atRoot.crops.length === 1 && atRoot.crops[0].name === "root" && !atRoot.variant);
        check("listing a variant sees only that folder",
            atVariant.crops.length === 1 && atVariant.crops[0].name === "hid"
            && atVariant.crops[0].variant === variantId);
    } finally {
        await rm(root, {recursive: true, force: true});
    }
}

/* 11. Startup has one implementation. The first-paint script only
 * toggles the picker from the same keys. */
{
    const fresh = Boot.resolveStartup({search: "", stored: null});
    check("no query and no store opens the picker",
        fresh.skipPicker === false && fresh.project === "thalos");

    const resumed = Boot.resolveStartup({search: "", stored: "earth"});
    check("a stored project skips the picker",
        resumed.skipPicker === true && resumed.project === "earth");

    const linked = Boot.resolveStartup({search: "?project=earth", stored: "thalos"});
    check("?project= wins over the stored project",
        linked.skipPicker === true && linked.project === "earth");

    const deep = Boot.resolveStartup({search: "?seed=42", stored: "thalos"});
    check("a seed in the query is a deep link",
        deep.skipPicker === true && deep.project === "thalos" && deep.seed === 42);

    const unknown = Boot.resolveStartup({search: "?project=kephos", stored: null});
    check("an unknown project in the URL is ignored",
        unknown.skipPicker === false && unknown.project === "thalos");

    const withVariant = Boot.resolveStartup({search: "?project=thalos&variant=vabc123", stored: "earth"});
    check("?variant= is a deep link",
        withVariant.skipPicker === true
        && withVariant.project === "thalos"
        && withVariant.variant === "vabc123");

    const junkVariant = Boot.resolveStartup({search: "?variant=nope", stored: "thalos"});
    check("a junk variant in the URL is ignored",
        junkVariant.variant == null && junkVariant.skipPicker === true);

    const seedOnly = Boot.resolveStartup({search: "?seed=42", stored: "thalos"});
    check("a seed query does not invent a variant",
        seedOnly.seed === 42 && seedOnly.variant == null && seedOnly.seedFromQuery === true);

    const remembered = Boot.nextStoredVariants({thalos: "vabc123"}, "earth", null);
    check("remembering one project's variant leaves the other alone",
        remembered.thalos === "vabc123" && remembered.earth == null);
    const switched = Boot.nextStoredVariants(remembered, "thalos", "vdef456");
    check("switching back writes the last selected variant for that project",
        switched.thalos === "vdef456" && switched.earth == null);
    const junked = Boot.storedVariantsOf({thalos: "nope", kephos: "vabc123"});
    check("a junk stored variant is dropped",
        junked.thalos == null && junked.kephos == null);
    check("a stored variant id is kept",
        Boot.storedVariantsOf({thalos: "vabc123"}).thalos === "vabc123");
}

check("polarStraits is an exposed parameter",
    Params.exposed().includes("polarStraits"));

console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
