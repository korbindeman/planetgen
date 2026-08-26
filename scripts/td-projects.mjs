/**
 * User projects on disk.
 *
 *   preview/<name>/project.json
 *
 * Shipped worlds (Thalos, Earth) stay JS modules. A Create writes a
 * record here; the studio registers it for the rest of the session.
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

export function projectFile(root, Projects, name) {
  return join(root, Projects.projectFile(name));
}


export async function readUserProject(root, Projects, name) {
  try {
    return Projects.Init.parseRecord(await Bun.file(projectFile(root, Projects, name)).json());
  } catch {
    return null;
  }
}


export async function writeUserProject(root, Projects, project) {
  const parsed = Projects.register(project);
  const path = projectFile(root, Projects, parsed.name);
  await mkdir(join(root, Projects.dir(parsed.name)), {recursive: true});
  const record = {
    name: parsed.name,
    label: parsed.label,
    pipeline: parsed.pipeline,
  };
  if (parsed.init) record.init = parsed.init;
  if (parsed.body && Object.keys(parsed.body).length) record.body = parsed.body;
  await Bun.write(path, JSON.stringify(record, null, 2) + "\n");
  return parsed;
}


export async function createUserProject(root, Projects, input) {
  let record;
  try {
    record = Projects.Init.buildRecord(input);
  } catch (err) {
    err.status = 400;
    throw err;
  }
  let exists = false;
  try {
    Projects.byName(record.name);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists && await Bun.file(projectFile(root, Projects, record.name)).exists()) {
    exists = true;
  }
  if (exists) {
    const err = new Error(`"${record.label}" is already a project`);
    err.status = 409;
    throw err;
  }
  return writeUserProject(root, Projects, record);
}


export async function loadUserProjects(root, Projects) {
  let names = [];
  try {
    names = await readdir(join(root, "preview"));
  } catch {
    return [];
  }
  const loaded = [];
  for (const name of names) {
    if (Projects.isShipped(name)) continue;
    const record = await readUserProject(root, Projects, name);
    if (!record || record.name !== name) continue;
    try {
      loaded.push(Projects.register(record));
    } catch {
      /* skip junk */
    }
  }
  return loaded;
}
