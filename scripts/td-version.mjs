/**
 * A fingerprint of the code the bake API is running.
 *
 * `bun run dev` reuses a td-server that is already listening, and `bun --hot`
 * only reloads the page. So the browser can be current while the process that
 * bakes is whatever was started hours ago. That is not theoretical: six tiles
 * baked on 2026-09-04 came out on the face's conformal plane because the
 * server predated `bakeBackOntoTile`, and nothing said so — the tiles just
 * did not meet. The handshake is what makes that loud instead of silent.
 *
 * The fingerprint is the *closure* of the server's sources, walked from the
 * entry rather than listed here, so a module added tomorrow is covered
 * without anyone remembering to add it. A list would go stale exactly the way
 * the server did.
 *
 * Only files under this repo count, and only the ones the server actually
 * reaches — editing `src/studio/` must not invalidate a running bake.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const ENTRY = join(here, "td-server.mjs");

/* `import x from "./y"`, `export * from "./y"`, `await import("./y")`. */
const RELATIVE_ESM = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.[^"']+)["']/g;
/* `require('./y')` — how src/ modules reach each other. */
const RELATIVE_CJS = /\brequire\(\s*["'](\.[^"']+)["']\s*\)/g;
/* `require(join(root, "src", "cubesphere.js"))` — how scripts/ reaches src/. */
const JOINED_CJS = /\brequire\(\s*join\(([^)]*)\)\s*\)/g;
/* The bake and dump scripts are spawned by path, so they are code too. */
const PYTHON = /["']([\w.-]+\.py)["']/g;
const LITERAL = /["']([^"']*)["']/g;

/*
 * What the server *writes* is not what the server *is*. `POST /params-ranges`
 * rewrites this file and calls `Params.setOverlay` in the same breath, so a
 * server that has had a range edited is holding the new values already.
 * Hashing it would report that server stale for a change it has made itself.
 */
const WRITTEN_AT_RUNTIME = new Set(["src/params-ranges.json"]);

/* Node's own resolution, minus everything this repo does not use: a bare
 * specifier is a dependency and is not walked. */
function resolveFile(candidate) {
    for (const p of [candidate, `${candidate}.js`, `${candidate}.json`, join(candidate, "index.js")]) {
        try {
            if (existsSync(p) && statSync(p).isFile()) return p;
        } catch { /* raced or unreadable; treat as absent */ }
    }
    return null;
}

function inRepo(path) {
    const rel = relative(ROOT, path);
    return rel && !rel.startsWith("..");
}

function referencesFrom(file, text) {
    const dir = dirname(file);
    const out = [];
    const add = (p) => { if (p) out.push(p); };
    for (const m of text.matchAll(RELATIVE_ESM)) add(resolveFile(join(dir, m[1])));
    for (const m of text.matchAll(RELATIVE_CJS)) add(resolveFile(join(dir, m[1])));
    for (const m of text.matchAll(JOINED_CJS)) {
        const parts = [...m[1].matchAll(LITERAL)].map((s) => s[1]).filter(Boolean);
        if (!parts.length) continue;
        /* `join(here, "..", "src", x)` and `join(root, "src", x)` differ only in
         * which base the literals hang off, and the literals are the same either
         * way — so try both bases and take whichever exists. */
        add(resolveFile(join(dir, ...parts)) || resolveFile(join(ROOT, ...parts)));
    }
    for (const m of text.matchAll(PYTHON)) add(resolveFile(join(ROOT, "scripts", m[1])));
    return out;
}

/* Every repo file the bake API loads or spawns, entry first, sorted. */
export function bakeApiFiles() {
    const seen = new Set();
    const stack = [ENTRY];
    while (stack.length) {
        const file = stack.pop();
        if (seen.has(file) || !inRepo(file)) continue;
        seen.add(file);
        let text;
        try {
            text = readFileSync(file, "utf8");
        } catch {
            continue; // a binary or vanished file contributes nothing to walk
        }
        for (const next of referencesFrom(file, text)) {
            if (!seen.has(next)) stack.push(next);
        }
    }
    return [...seen]
        .map((f) => relative(ROOT, f).split("\\").join("/"))
        .filter((rel) => !WRITTEN_AT_RUNTIME.has(rel))
        .sort();
}

/*
 * Content, not mtimes: a checkout, a stash pop or a branch switch moves
 * timestamps without changing what runs, and the point is to catch code that
 * differs, not code that was touched.
 */
export function bakeApiVersion() {
    const files = bakeApiFiles();
    const hash = createHash("sha256");
    for (const rel of files) {
        hash.update(rel);
        hash.update("\0");
        try {
            hash.update(readFileSync(join(ROOT, rel)));
        } catch {
            hash.update("missing");
        }
        hash.update("\0");
    }
    return {version: hash.digest("hex").slice(0, 12), files};
}
