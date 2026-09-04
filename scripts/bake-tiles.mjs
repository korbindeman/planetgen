#!/usr/bin/env bun
/**
 * Bake named cubesphere tiles without a browser.
 *
 *   bun run bake:tiles <variant> <tile> [<tile>...]
 *   bun run bake:tiles v1788473173180 f1l4x15y0 f2l4x0y0 f5l4x15y0
 *   bun run bake:tiles --project=thalos --seed=... <tile>...
 *   bun run bake:tiles --export-only v1788473173180 f1l4x15y0
 *
 * The studio builds a tile's conditioning in the page and POSTs it, so until
 * now a bake needed a browser open — which also meant the app's own export
 * path could not be checked from a script. This generates the same planet the
 * studio would, calls the same `TdExport.tileJobBody`, and submits. It is the
 * app's path, not a second one.
 *
 * Order matters at a fold: the first tile of a pair owns the edge and the
 * second conforms to it, so tiles bake one at a time in the order given.
 *
 * Needs terrain-diffusion — docs/ref/terrain-diffusion.md § Where it lives.
 * `--export-only` stops after writing the conditioning GeoTIFFs, which is the
 * half that needs no GPU.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRun } from "./project-run.mjs";
import { getJob, submitJob, tdCheckout } from "./td-jobs.mjs";
import { projectBakeDir } from "./td-overlays.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Cube = require(join(root, "src", "cubesphere.js"));
const Planet = require(join(root, "src", "planet.js"));
const Projects = require(join(root, "src", "projects"));
const TdExport = require(join(root, "src", "td-export.js"));
const TdTile = require(join(root, "src", "td-tile.js"));

function parseArgs(argv) {
    const out = {tiles: [], project: null, seed: null, variant: null, exportOnly: false};
    for (const arg of argv) {
        if (arg === "--export-only") out.exportOnly = true;
        else if (arg.startsWith("--project=")) out.project = arg.slice(10);
        else if (arg.startsWith("--seed=")) out.seed = arg.slice(7);
        else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
        else if (Projects.isVariantId(arg)) out.variant = arg;
        else if (Cube.parseTileName(arg)) out.tiles.push(Cube.parseTileName(arg));
        else throw new Error(`not a variant id or a tile name: ${arg}`);
    }
    return out;
}

/* A job is done when it stops moving. Bakes are minutes, so poll slowly and
 * print the tail so a stall is visible rather than silent. */
async function waitFor(id) {
    let lastLog = "";
    for (;;) {
        const job = getJob(id);
        if (!job) throw new Error(`job ${id} vanished`);
        const line = job.logTail[job.logTail.length - 1] || "";
        if (line !== lastLog) {
            lastLog = line;
            const pct = job.progress != null ? ` ${job.progress}%` : "";
            console.log(`    [${job.status}${pct}] ${line}`);
        }
        if (job.status === "done") return job;
        if (job.status === "error") throw new Error(job.error || "bake failed");
        await new Promise((r) => setTimeout(r, 2000));
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.tiles.length) {
        console.error("usage: bun run bake:tiles [<variant>] <tile>... [--export-only]");
        return 2;
    }
    const run = await resolveRun(root, Projects, args.project, args.seed, args.variant);
    console.log(`project ${run.project}  seed ${run.seed}  variant ${run.variant || "(none)"}`);
    if (!args.exportOnly) console.log(`terrain-diffusion at ${tdCheckout()}`);

    const planet = Planet.generatePlanet({
        seed: run.seed,
        project: run.project,
        values: run.values,
        simulateTectonics: true,
        polarStraits: true,
        detailPass: true,
        quiet: true,
    });
    const cells = Cube.tileCells(
        args.tiles[0].level, planet.body.radiusKm, TdTile.SCALE_KM,
    );
    console.log(`${cells} conditioning cells per tile, ${TdTile.CONTEXT_PAD} of pad\n`);

    /*
     * Drop what a previous generation left for these tiles, before any of
     * them bakes. A fold tile conforms to whatever neighbour is already on
     * disk, so with stale output still there the *first* tile of a batch
     * stitches itself onto the run it is replacing — which inverts the whole
     * point of the order. On the first three-tile bake that pulled f5's edge
     * 32 m off its own halo and put a crease down the fold.
     */
    if (!args.exportOnly && args.tiles.length > 1) {
        const dir = projectBakeDir(root, run.project, run.variant);
        for (const tile of args.tiles) {
            const crop = join(dir, `crop-${Cube.tileName(tile)}`);
            for (const f of ["output.elev", "output.elev.json", "output.tif"]) {
                await Bun.file(join(crop, f)).unlink().catch(() => {});
            }
            for (const edge of Cube.EDGES) {
                for (const ext of ["tif", "elev", "elev.json"]) {
                    await Bun.file(join(crop, `halo-${edge}.${ext}`)).unlink().catch(() => {});
                }
            }
        }
        console.log(`cleared ${args.tiles.length} tiles so the batch stitches to itself\n`);
    }

    for (const tile of args.tiles) {
        const name = Cube.tileName(tile);
        const body = TdExport.tileJobBody(planet, tile, {
            cells,
            rasterize: (t, rect) => Planet.rasterizeBakeRect(planet.mesh, planet.map, t, rect, 0),
        });
        const halo = TdTile.haloCellsFor(tile);
        const folds = Object.entries(halo).filter(([, c]) => c).map(([e]) => e);
        console.log(`${name}  ${body.cropW}x${body.cropH} cells`
            + `${folds.length ? `, halo on ${folds.join("/")}` : ""}`);
        const job = await submitJob(root, {
            ...body,
            seed: run.seed,
            project: run.project,
            variant: run.variant || undefined,
            exportOnly: args.exportOnly,
        });
        if (args.exportOnly) {
            console.log(`    conditioning written to ${job.name}`);
            continue;
        }
        const done = await waitFor(job.id);
        console.log(`    done: ${done.name}\n`);
    }
    console.log("look at it:  bun run seam <variant-dir> <tile>... --relief");
    return 0;
}

process.exit(await main());
