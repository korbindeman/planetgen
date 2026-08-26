#!/usr/bin/env bun
/**
 * Check the docs are navigable and true.
 *
 *   bun run check:docs
 *
 * Docs rot in ways a reader does not notice until the doc has already
 * misled them: a link that moved, a contract table that lost a field the
 * code still writes, a stage doc missing the section every other doc
 * links into. None of that needs a picture to judge, so it gets judged
 * here — the same bargain as `check:tiles`.
 *
 * The contract check is the one that matters. docs/stages/*.md § Hands on
 * is what downstream stages are told to rely on, so a field the code
 * emits and the table omits is a promise nobody made.
 *
 * Also prints the open wishes across the pipeline: § Reads is where a
 * stage records what it would use if upstream emitted it, and that list
 * is the research backlog. Granting one moves it into § Hands on upstream.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else { console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
};

function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === ".git" || e === "build" || e === "preview") continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (e.endsWith(".md") || e.endsWith(".mdc")) out.push(p);
    }
    return out;
}

const SECTIONS = [
    "What it does", "Reads", "Hands on", "Must not regress",
    "How it works today", "Open", "How to judge it",
];
const STAGES = [
    "layout", "shape", "climate", "terrain",
    "carve-hydrology", "carve-landforms", "export",
];
const RETIRED = [
    "full-planet-pipeline.md", "full-planet-bake.md",
    "preparing-for-diffusion.md", "wanted.md", "detail-pass-plan.md",
];

/* GitHub's slug: lowercase, drop punctuation, spaces to hyphens. Runs of
 * spaces are NOT collapsed, so an em dash in a heading leaves a double
 * hyphen in its anchor. */
const slug = (h) => h.trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/ /g, "-");

const files = walk(root).sort();
const headings = new Map();
for (const f of files) {
    headings.set(resolve(f), new Set(
        [...readFileSync(f, "utf8").matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) => slug(m[1]))));
}

console.log("links");
{
    const dead = [];
    for (const f of files) {
        const text = readFileSync(f, "utf8");
        for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
            const target = m[1];
            if (/^(https?:|mailto:)/.test(target)) continue;
            const [path, frag] = target.split("#");
            const abs = path ? resolve(dirname(f), decodeURIComponent(path)) : resolve(f);
            let ok = true;
            try { statSync(abs); } catch { ok = false; }
            if (!ok) { dead.push(`${relative(root, f)} -> ${target} (no such file)`); continue; }
            if (frag && /\.mdc?$/.test(abs) && !headings.get(abs)?.has(frag)) {
                dead.push(`${relative(root, f)} -> ${target} (no such heading)`);
            }
        }
    }
    check(`every internal link and anchor resolves (${files.length} files)`,
        dead.length === 0, dead.join("; "));
}

console.log("\nretired docs");
{
    const stale = [];
    for (const f of walk(root).concat(
        ["src", "scripts", "packages"].flatMap((d) => walkCode(join(root, d))))) {
        const text = readFileSync(f, "utf8");
        for (const name of RETIRED) {
            /* The checker names them to look for them; the history records
             * may name a doc that existed when they were written. */
            if (text.includes(name) && !f.includes("/history/")
                && !f.endsWith("check-docs.mjs")) {
                stale.push(`${relative(root, f)} -> ${name}`);
            }
        }
    }
    check("nothing points at a retired doc", stale.length === 0, stale.join("; "));
}

function walkCode(dir, out = []) {
    let entries;
    try { entries = readdirSync(dir); } catch { return out; }
    for (const e of entries) {
        if (e === "node_modules") continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walkCode(p, out);
        else if (/\.(js|mjs|py)$/.test(e)) out.push(p);
    }
    return out;
}

console.log("\nstage skeleton");
for (const stage of STAGES) {
    const f = join(root, "docs", "stages", `${stage}.md`);
    const text = readFileSync(f, "utf8");
    const heads = [...text.matchAll(/^##\s+(.*)$/gm)].map((m) => m[1].trim());
    const found = SECTIONS.filter((s) => heads.some((h) => h.toLowerCase().startsWith(s.toLowerCase())));
    const order = SECTIONS.filter((s) => found.includes(s));
    const actual = heads.filter((h) => SECTIONS.some((s) => h.toLowerCase().startsWith(s.toLowerCase())));
    check(`${stage}: seven sections, in order`,
        found.length === SECTIONS.length
        && order.every((s, i) => actual[i].toLowerCase().startsWith(s.toLowerCase())),
        `has ${found.length}/7`);
    check(`${stage}: § Reads records its wishes`, /\*\*Wishes\*\*/.test(text));
}

console.log("\nvocabulary");
{
    const context = readFileSync(join(root, "CONTEXT.md"), "utf8");
    /* Climate, Terrain and Export went years without an entry, so the
     * glossary is held to naming every stage it claims to cover. */
    const words = ["Layout", "Shape", "Climate", "Terrain", "Carve", "Export",
                   "Hydrology", "Sketch", "Pipeline", "Discover", "Finish"];
    const absent = words.filter((w) => !context.includes(`**${w}**:`));
    check(`CONTEXT.md defines every pipeline word (${words.length})`,
        absent.length === 0, absent.join(", "));
    /* An entry header is a bold term alone on its line ending in a colon.
     * Matching bare `**` also catches a term that merely wraps onto a new
     * line, which is most of them. */
    const entries = context.split(/^\*\*(.+?)\*\*:$/m);
    const noAvoid = [];
    for (let i = 1; i < entries.length; i += 2) {
        if (!entries[i + 1].split(/\n## /)[0].includes("_Avoid_")) noAvoid.push(entries[i]);
    }
    check(`every CONTEXT.md term says what not to call it (${(entries.length - 1) / 2})`,
        noAvoid.length === 0, noAvoid.join(", "));
}

console.log("\ncontracts match the code");
{
    const artifact = readFileSync(join(root, "src", "shape-artifact.js"), "utf8");
    const sketch = new Set();
    for (const name of ["F32", "PACKED3", "U8", "I32"]) {
        const block = artifact.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
        if (block) for (const m of block[1].matchAll(/'([^']+)'/g)) sketch.add(m[1]);
    }
    const shape = readFileSync(join(root, "docs", "stages", "shape.md"), "utf8");
    const missing = [...sketch].filter((f) => !shape.includes(`\`${f}\``));
    check(`shape.md documents every field in the cached sketch (${sketch.size})`,
        missing.length === 0, missing.join(", "));

    const layoutArt = readFileSync(join(root, "src", "layout-artifact.js"), "utf8");
    const layoutCache = new Set();
    for (const name of ["F32", "PACKED3", "U8", "I32"]) {
        const block = layoutArt.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
        if (block) for (const m of block[1].matchAll(/'([^']+)'/g)) layoutCache.add(m[1]);
    }

    const layout = readFileSync(join(root, "docs", "stages", "layout.md"), "utf8");
    const cacheMissing = [...layoutCache].filter((f) => !layout.includes(`\`${f}\``));
    check(`layout.md documents every field in the cached sim (${layoutCache.size})`,
        cacheMissing.length === 0, cacheMissing.join(", "));

    const tectonics = readFileSync(join(root, "src", "tectonics.js"), "utf8");
    const ret = tectonics.match(/return \{\s*(r_crust_type[\s\S]*?)\}/);
    const emitted = new Set(ret ? ret[1].match(/\br_[a-zA-Z_]+\b/g) : []);
    const undocumented = [...emitted].filter((f) => !layout.includes(`\`${f}\``));
    check(`layout.md documents every field the simulation emits (${emitted.size})`,
        undocumented.length === 0, undocumented.join(", "));

    const invented = [...layout.matchAll(/\|\s*`(r_[a-zA-Z_]+)`\s*\|/g)]
        .map((m) => m[1]).filter((f) => !tectonics.includes(f));
    check("layout.md documents no field the simulation never assigns",
        invented.length === 0, invented.join(", "));
}

console.log("\nstatus claims match the code");
{
    /* A status line is the first thing to rot: a stage gets built and the
     * row that says it is not still reads fine. So the claim is held
     * against the code that would have to change. Nothing here encodes an
     * opinion about a stage — only that the docs and the tree agree.
     *
     * A named slot is a package whose run() throws instead of running. It
     * is how this repo says "decided, not built", and it is exactly the
     * thing that stops being true without anyone editing a doc. */
    const namedSlot = (pkg) => {
        try { return readFileSync(join(root, "packages", pkg, "index.js"), "utf8").includes("named slot"); }
        catch { return false; }
    };
    const exists = (p) => { try { statSync(join(root, p)); return true; } catch { return false; } };

    const UNBUILT = /not started|not built|not written|not tried|named slot/i;
    const readme = readFileSync(join(root, "docs", "README.md"), "utf8");
    const state = new Map();
    for (const line of readme.split("\n")) {
        const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*\[.*?\]\((.+?)\)\s*\|$/);
        if (m && m[4].startsWith("stages/")) state.set(m[4].replace("stages/", "").replace(".md", ""), m[3]);
    }
    check(`the index states a status for every stage (${STAGES.length})`,
        STAGES.every((s) => state.has(s)),
        STAGES.filter((s) => !state.has(s)).join(", "));

    /* §5 of a stage that is not built reads "Nothing". The index row must
     * agree, in both directions. */
    for (const stage of STAGES) {
        const text = readFileSync(join(root, "docs", "stages", `${stage}.md`), "utf8");
        const how = (text.split(/^## How it works today$/m)[1] ?? "").split(/\n## /)[0].trim();
        const docSaysNothing = /^Nothing[.\s]/.test(how);
        const indexSaysUnbuilt = UNBUILT.test(state.get(stage) ?? "");
        if (docSaysNothing) {
            check(`${stage}: "How it works today: Nothing" agrees with the index`,
                indexSaysUnbuilt, `index says "${state.get(stage)}"`);
        }
        check(`${stage}: § How it works today is not empty`, how.length > 0);
    }

    /* The two named slots, against the packages that would stop throwing. */
    for (const [stage, pkg] of [["carve-hydrology", "hydrology"], ["terrain", "bake"]]) {
        const stub = namedSlot(pkg);
        const text = readFileSync(join(root, "docs", "stages", `${stage}.md`), "utf8");
        const claimsUnbuilt = UNBUILT.test(state.get(stage) ?? "") || /named slot/i.test(text);
        check(`@planetgen/${pkg} is a named slot and ${stage} still says so`,
            stub === claimsUnbuilt,
            stub ? `${stage} no longer says it is unbuilt`
                 : `@planetgen/${pkg} runs now — update ${stage}.md and the index`);
    }

    /* A stage that describes a mechanism must have the module it names. */
    for (const [stage, file] of [["layout", "src/tectonics.js"], ["layout", "src/layout-artifact.js"],
                                 ["shape", "src/detail.js"],
                                 ["shape", "src/shape-artifact.js"], ["climate", "src/climate.js"],
                                 ["terrain", "scripts/td-bake.py"], ["export", "src/cubesphere.js"]]) {
        check(`${stage}: ${file} exists`, exists(file));
    }
}

console.log("\nopen wishes across the pipeline\n");
for (const stage of STAGES) {
    const text = readFileSync(join(root, "docs", "stages", `${stage}.md`), "utf8");
    const block = text.split(/\*\*Wishes\*\*/)[1]?.split(/\n## /)[0] ?? "";
    const first = block.replace(/^\s*[—-]\s*/, "").split("\n\n")[0].replace(/\s+/g, " ").trim();
    console.log(`  ${stage.padEnd(17)} ${first.slice(0, 96)}`);
    for (const m of block.matchAll(/^- \*\*(.+?)\*\*/gm)) console.log(`  ${" ".repeat(17)}   · ${m[1]}`);
}

console.log(failures.length ? `\n${failures.length} failed` : "\nall good");
process.exit(failures.length ? 1 : 0);
