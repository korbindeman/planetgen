#!/usr/bin/env bun
/**
 * Guard the Earth fixture against drift.
 *
 *   bun run check:earth            compare against the locked baseline
 *   bun run check:earth --update   re-lock the baseline after a deliberate change
 *
 * The fixture is not random — Bird 2003 outlines, NNR-MORVEL56 poles, a
 * fixed mesh seed — so `stats --earth` is reproducible to the digit, and
 * this compares the whole report rather than a handful of numbers within a
 * tolerance. Any change to the model that moves Earth shows up here.
 *
 * That makes failure the normal outcome of improving the generator, not a
 * bug. Read the diff, decide whether Earth moved the right way, and rerun
 * with --update to accept it. The baseline is checked in, so the diff is
 * also the record of what a change did to Earth.
 *
 * `stats --earth` measures the fixture against Earth's real figures, which
 * this deliberately does not assert: the model is knowingly short on some
 * of them (~3% of the surface above 2000 m against Earth's ~5%, see
 * `.cursor/rules/plates-elevation.mdc`). Asserting the real figures would
 * fail today for reasons that are documented rather than accidental. This
 * asserts what the fixture currently produces, so the known gaps stay
 * visible in the baseline instead of being blessed as correct.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const baselinePath = join(here, "earth-baseline.txt");
const update = process.argv.includes("--update");

/* Wall-clock timings are the one thing that legitimately varies run to
 * run. Everything else is geometry and must not. */
function normalise(text) {
    return text
        .replace(/\(\d+ ms\)/g, "(TIME)")
        .replace(/^ {2}runtime ms.*$/gm, "  runtime ms                 TIME   Earth")
        .trimEnd() + "\n";
}

const result = spawnSync("bun", [join(root, "scripts", "tectonics-stats.mjs"), "--earth"], {
    cwd: root, encoding: "utf8",
});

if (result.status !== 0) {
    console.error("stats --earth failed:\n" + (result.stderr || result.stdout));
    process.exit(1);
}

const actual = normalise(result.stdout);

if (update) {
    writeFileSync(baselinePath, actual);
    console.log(`earth baseline updated: ${baselinePath}`);
    process.exit(0);
}

if (!existsSync(baselinePath)) {
    console.error(`no baseline at ${baselinePath}\nrun: bun run check:earth --update`);
    process.exit(1);
}

const expected = readFileSync(baselinePath, "utf8");

if (actual === expected) {
    console.log("earth fixture matches baseline");
    process.exit(0);
}

/* Line-by-line rather than a real diff: the report is short and aligned,
 * so paired lines read better than a hunk. */
const a = expected.split("\n"), b = actual.split("\n");
console.error("earth fixture has drifted from the baseline\n");
for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) console.error(`  - ${a[i]}`);
    if (b[i] !== undefined) console.error(`  + ${b[i]}`);
}
console.error("\nif this change is intended: bun run check:earth --update");
process.exit(1);
