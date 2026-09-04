/**
 * Live app plus the local TD bake API.
 * bun --hot serves the page; td-server accepts crop jobs and overlay PNGs.
 *
 * The page is rebundled on every edit; the bake API is not. Reusing whatever
 * already answers on the port is what let a server from before a change keep
 * baking against it — silently, because a bake that ran old code still
 * finishes and still writes a tile. So the two sides shake hands on a
 * fingerprint of the server's own sources, and a mismatch is replaced rather
 * than trusted. `td-version.mjs` is what the fingerprint means.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bakeApiVersion } from "./td-version.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = Number(process.env.TD_PORT) || 3748;
const {version} = bakeApiVersion();

await Bun.spawn(["bun", "./scripts/sync-td-overlays.mjs"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
}).exited;

async function bakeApiHealth() {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/health`);
    const data = await res.json();
    return data && data.ok === true ? data : null;
  } catch {
    return null;
  }
}

/* Wait for the old server to let go of the port, or the replacement races it
 * to EADDRINUSE and `bun run dev` comes up with no bake API at all. */
async function portFreed(deadlineMs = 5000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (!(await bakeApiHealth())) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let api = null;
const live = await bakeApiHealth();
if (live && live.version === version) {
  console.log(`td bake  already on http://localhost:${apiPort} (${version})`);
} else {
  if (live) {
    /* A server with no version at all predates the handshake, so it is by
     * definition older than this code. */
    const was = live.version || "no version";
    if (live.busy) {
      console.error(`td bake  on ${apiPort} is running other code (${was}, this tree is ${version})`
        + ` and is mid-bake: ${(live.jobs || []).join(", ")}`);
      console.error(`         Those tiles are being baked by that code. Let it finish or stop`
        + ` pid ${live.pid}, then rerun \`bun run dev\`.`);
      process.exit(1);
    }
    console.log(`td bake  on ${apiPort} is running other code (${was}, this tree is ${version}) — replacing it`);
    try {
      if (live.pid) process.kill(live.pid);
    } catch (err) {
      console.error(`         could not stop pid ${live.pid}: ${err.message}`);
    }
    if (!(await portFreed())) {
      console.error(`         port ${apiPort} is still held. Stop that process and rerun \`bun run dev\`.`);
      process.exit(1);
    }
  }
  api = Bun.spawn(["bun", "./scripts/td-server.mjs"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
}
const app = Bun.spawn(["bun", "--hot", "./index.html"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});

function shutdown() {
  if (api) api.kill();
  app.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.exited;
if (api) api.kill();
