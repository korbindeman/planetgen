/**
 * CLI run: `--variant=` wins. With no seed, the last saved variant if
 * the catalog has one, else a working planet from the adopted body.
 * Earth is the fixture token.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function resolveRun(root, Projects, projectName, seedArg, variantId) {
  const project = Projects.byName(projectName || Projects.DEFAULT);
  if (project.fixture) {
    return {
      project: project.name,
      seed: seedArg != null ? seedArg : project.seed,
      values: Projects.authored(project),
      variant: null,
    };
  }
  let catalog = Projects.Variants.emptyCatalog(project.name);
  try {
    const raw = JSON.parse(await readFile(join(root, Projects.catalogPath(project.name)), "utf8"));
    catalog = Projects.parseCatalog(raw, project.name);
  } catch (_) { /* no catalog yet */ }
  const asked = variantId && Projects.Variants.findById(catalog.variants, variantId);
  const liveAsked = asked && !asked.deleted ? asked : null;
  const latest = Projects.Variants.live(catalog.variants)[0];
  const variant = liveAsked || (seedArg == null ? latest : null);
  if (variant) {
    return {
      project: project.name,
      seed: seedArg != null ? seedArg : variant.seed,
      values: Projects.recipeOf(variant, project.body),
      variant: variant.id,
    };
  }
  return {
    project: project.name,
    seed: seedArg != null ? seedArg : 1,
    values: Projects.authored(project),
    variant: null,
  };
}
