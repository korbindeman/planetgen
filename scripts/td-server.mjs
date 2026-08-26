/**
 * Local bake API. The browser posts a crop or asks for preview bakes;
 * this writes GeoTIFFs under preview/<name>/ and runs
 * terrain-diffusion in the sibling checkout. Not the cubesphere bake.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveTdFile } from "./td-overlays.mjs";
import {
  getJob, listJobs, overlaysWithJobs, pipelineStatus, previewBakes, submitJob,
} from "./td-jobs.mjs";
import {
  attachThumbs, decodeDataUrl, readCatalog, writeCatalog, writeThumb,
  readShape, writeShape, deleteShape, readLayout, writeLayout,
} from "./td-catalog.mjs";
import { createUserProject, loadUserProjects } from "./td-projects.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Params = require(join(root, "src", "params.js"));
const Projects = require(join(root, "src", "projects"));
const rangesPath = join(root, "src", "params-ranges.json");
const port = Number(process.env.TD_PORT) || 3748;

await loadUserProjects(root, Projects);

function cors(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, {status: res.status, headers});
}

function json(data, status = 200) {
  return cors(Response.json(data, {status}));
}

function query(url) {
  return {
    project: url.searchParams.get("project") || undefined,
    seed: url.searchParams.get("seed") || undefined,
    variant: url.searchParams.get("variant") || undefined,
  };
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return cors(new Response(null, {status: 204}));

    if (url.pathname === "/health") {
      return json({ok: true});
    }
    if (url.pathname === "/params-ranges" && req.method === "GET") {
      try {
        const text = await Bun.file(rangesPath).text();
        return json(JSON.parse(text));
      } catch {
        return json({});
      }
    }
    if (url.pathname === "/params-ranges" && req.method === "POST") {
      let body;
      try { body = await req.json(); }
      catch { return json({error: "invalid json"}, 400); }
      const problems = Params.checkOverlay(body);
      if (problems.length) return json({error: problems.join("; ")}, 400);
      Params.setOverlay(body);
      await Bun.write(rangesPath, JSON.stringify(body, null, 2) + "\n");
      return json({ok: true});
    }
    if (url.pathname === "/projects" && req.method === "GET") {
      return json({
        projects: Projects.list().filter((p) => !Projects.isShipped(p.name)).map((p) => ({
          name: p.name,
          label: p.label,
          pipeline: p.pipeline,
          init: p.init || null,
          body: p.body || null,
        })),
      });
    }
    if (url.pathname === "/projects" && req.method === "POST") {
      let body;
      try { body = await req.json(); }
      catch { return json({error: "invalid json"}, 400); }
      try {
        const project = await createUserProject(root, Projects, body);
        return json({project}, 201);
      } catch (err) {
        return json({error: String(err.message || err)}, err.status || 400);
      }
    }
    if (url.pathname === "/variants" && req.method === "GET") {
      const q = query(url);
      if (!q.project) return json({error: "project required"}, 400);
      try { Projects.byName(q.project); } catch { return json({error: "unknown project"}, 400); }
      const catalog = await attachThumbs(root, await readCatalog(root, q.project));
      return json(catalog);
    }
    if (url.pathname === "/variants" && req.method === "PUT") {
      let body;
      try { body = await req.json(); }
      catch { return json({error: "invalid json"}, 400); }
      try { Projects.byName(body.project); } catch { return json({error: "unknown project"}, 400); }
      const catalog = await writeCatalog(root, body);
      return json(await attachThumbs(root, catalog));
    }
    if (url.pathname === "/variants/thumb" && req.method === "PUT") {
      let body;
      try { body = await req.json(); }
      catch { return json({error: "invalid json"}, 400); }
      try { Projects.byName(body.project); } catch { return json({error: "unknown project"}, 400); }
      if (!Projects.isVariantId(body.id)) return json({error: "bad variant"}, 400);
      const bytes = decodeDataUrl(body.data);
      if (!bytes) return json({error: "thumb must be a jpeg or png data URL"}, 400);
      const thumb = await writeThumb(root, body.project, body.id, bytes);
      return json({ok: true, thumb});
    }
    if (url.pathname === "/pipeline" && req.method === "GET") {
      const q = query(url);
      if (!q.project) return json({error: "project required"}, 400);
      return json(await pipelineStatus(root, q));
    }
    if (url.pathname === "/shape" && req.method === "GET") {
      const q = query(url);
      if (!q.project || !q.variant) return json({error: "project and variant required"}, 400);
      try { Projects.byName(q.project); } catch { return json({error: "unknown project"}, 400); }
      if (!Projects.isVariantId(q.variant) && q.project !== "earth") {
        return json({error: "bad variant"}, 400);
      }
      const payload = await readShape(root, q.project, q.variant || "earth");
      if (!payload) return json({error: "no shape"}, 404);
      return json(payload);
    }
    if (url.pathname === "/shape" && req.method === "PUT") {
      let body;
      try { body = await req.json(); }
      catch { return json({error: "invalid json"}, 400); }
      try { Projects.byName(body.project); } catch { return json({error: "unknown project"}, 400); }
      const id = body.variant || (Projects.isFixture(body.project) ? "earth" : null);
      if (!id || (!Projects.isVariantId(id) && id !== "earth")) {
        return json({error: "bad variant"}, 400);
      }
      if (!body.n || !body.f32) return json({error: "shape payload required"}, 400);
      await writeShape(root, body.project, id, body);
      return json({ok: true});
    }
    if (url.pathname === "/shape" && req.method === "DELETE") {
      const q = query(url);
      if (!q.project || !q.variant) return json({error: "project and variant required"}, 400);
      try { Projects.byName(q.project); } catch { return json({error: "unknown project"}, 400); }
      if (!Projects.isVariantId(q.variant)) return json({error: "bad variant"}, 400);
      await deleteShape(root, q.project, q.variant);
      return json({ok: true});
    }
    if (url.pathname === "/layout" && req.method === "GET") {
      const q = query(url);
      if (!q.project || !q.variant) return json({error: "project and variant required"}, 400);
      try { Projects.byName(q.project); } catch { return json({error: "unknown project"}, 400); }
      if (!Projects.isVariantId(q.variant)) return json({error: "bad variant"}, 400);
      const payload = await readLayout(root, q.project, q.variant);
      if (!payload) return json({error: "no layout"}, 404);
      return json(payload);
    }
    if (url.pathname === "/layout" && req.method === "PUT") {
      let body;
      try { body = await req.json(); }
      catch { return json({error: "invalid json"}, 400); }
      try { Projects.byName(body.project); } catch { return json({error: "unknown project"}, 400); }
      const id = body.variant;
      if (!id || !Projects.isVariantId(id)) return json({error: "bad variant"}, 400);
      if (!body.n || !body.f32 || !body.plates) return json({error: "layout payload required"}, 400);
      await writeLayout(root, body.project, id, body);
      return json({ok: true});
    }
    if (url.pathname === "/overlays.json") {
      return json(await overlaysWithJobs(root, query(url)));
    }
    if (url.pathname === "/jobs" && req.method === "GET") {
      const q = query(url);
      return json({jobs: listJobs(q.project, q.variant)});
    }
    if (url.pathname === "/jobs" && req.method === "POST") {
      try {
        const body = await req.json();
        const job = await submitJob(root, body);
        return json({job});
      } catch (err) {
        return json({error: String(err.message || err)}, 400);
      }
    }
    if (url.pathname === "/preview-bakes" && req.method === "POST") {
      try {
        const body = await req.json();
        const result = await previewBakes(root, body);
        return json(result);
      } catch (err) {
        return json({error: String(err.message || err)}, 400);
      }
    }
    const jobMatch = url.pathname.match(/^\/jobs\/([a-z0-9/-]+)$/);
    if (jobMatch && req.method === "GET") {
      const job = getJob(jobMatch[1]);
      if (!job) return json({error: "not found"}, 404);
      return json({job});
    }

    const td = await serveTdFile(root, url.pathname);
    if (td) return cors(td);

    return json({error: "not found"}, 404);
  },
});

console.log(`td bake  http://localhost:${server.port}`);
