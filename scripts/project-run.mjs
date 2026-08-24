/**
 * CLI run: committed variant if one exists, else a working planet.
 * Earth is the fixture token. A seed or variant id on the command line wins.
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
  const committed = catalog.committed
    && Projects.Variants.findById(catalog.variants, catalog.committed);
  const variant = asked || (seedArg == null ? committed : null);
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
