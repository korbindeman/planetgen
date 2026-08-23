/**
 * Live app plus the local TD bake API.
 * bun --hot serves the page; td-server accepts crop jobs and overlay PNGs.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = Number(process.env.TD_PORT) || 3748;

await Bun.spawn(["bun", "./scripts/sync-td-overlays.mjs"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
}).exited;

async function bakeApiUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/health`);
    const data = await res.json();
    return data && data.ok === true;
  } catch {
    return false;
  }
}

let api = null;
if (await bakeApiUp()) {
  console.log(`td bake  already on http://localhost:${apiPort}`);
} else {
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
