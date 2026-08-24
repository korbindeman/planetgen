/**
 * On-disk variant catalog for a project.
 *
 *   preview/<name>/variants.json
 *   preview/<name>/v/<id>/thumb.jpg
 *
 * The browser hydrates from GET /variants and writes through PUT.
 * Thumbs are files, not data URLs in the catalog.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));
const Projects = require(join(here, "..", "src", "projects"));
const Variants = Projects.Variants;


export function catalogFile(root, project) {
    return join(root, Projects.catalogPath(project));
}


export function thumbFile(root, project, id) {
    return join(root, Projects.thumbPath(project, id));
}


export function thumbUrl(project, id) {
    return `/${Projects.thumbPath(project, id)}`;
}


export async function readCatalog(root, project) {
    try {
        const raw = await Bun.file(catalogFile(root, project)).json();
        return Projects.parseCatalog(raw, project);
    } catch {
        return Variants.emptyCatalog(project);
    }
}


export async function writeCatalog(root, catalog) {
    const parsed = Projects.parseCatalog(catalog, catalog.project);
    const path = catalogFile(root, parsed.project);
    await mkdir(dirname(path), {recursive: true});
    await Bun.write(path, JSON.stringify(Variants.serializeCatalog(parsed), null, 2) + "\n");
    return parsed;
}


export async function writeThumb(root, project, id, bytes) {
    Projects.variantDir(project, id);
    const path = thumbFile(root, project, id);
    await mkdir(dirname(path), {recursive: true});
    await Bun.write(path, bytes);
    return thumbUrl(project, id);
}


export async function attachThumbs(root, catalog) {
    const variants = [];
    for (const item of catalog.variants) {
        const path = thumbFile(root, catalog.project, item.id);
        if (await Bun.file(path).exists()) {
            variants.push(Object.assign({}, item, {thumb: thumbUrl(catalog.project, item.id)}));
        } else {
            variants.push(item);
        }
    }
    return Object.assign({}, catalog, {variants});
}


export function decodeDataUrl(data) {
    if (typeof data !== "string") return null;
    const match = data.match(/^data:image\/(?:jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return null;
    return Buffer.from(match[1], "base64");
}
