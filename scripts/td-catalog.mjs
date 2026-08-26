/**
 * On-disk variant catalog for a project.
 *
 *   preview/<name>/variants.json
 *   preview/<name>/v/<id>/thumb.jpg
 *
 * The browser hydrates from GET /variants and writes through PUT.
 * Thumbs are files, not data URLs in the catalog.
 */
import { mkdir, unlink } from "node:fs/promises";
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
    // Origin-relative. The page origin does not serve preview/;
    // the browser prefixes the bake API.
    return `/${Projects.thumbPath(project, id)}`;
}


export function shapeFile(root, project, id) {
    if (Projects.isFixture(project) || id === "earth") {
        return join(root, Projects.dir(project), "shape.json");
    }
    return join(root, Projects.shapePath(project, id));
}


export async function hasShape(root, project, id) {
    if (!id) return false;
    try {
        return await Bun.file(shapeFile(root, project, id)).exists();
    } catch {
        return false;
    }
}


export async function writeShape(root, project, id, payload) {
    const path = shapeFile(root, project, id);
    await mkdir(dirname(path), {recursive: true});
    await Bun.write(path, JSON.stringify(payload) + "\n");
    return true;
}


export async function readShape(root, project, id) {
    try {
        return await Bun.file(shapeFile(root, project, id)).json();
    } catch {
        return null;
    }
}


export function layoutFile(root, project, id) {
    return join(root, Projects.layoutPath(project, id));
}


export async function hasLayout(root, project, id) {
    if (!id || Projects.isFixture(project) || id === "earth") return false;
    try {
        return await Bun.file(layoutFile(root, project, id)).exists();
    } catch {
        return false;
    }
}


export async function writeLayout(root, project, id, payload) {
    const path = layoutFile(root, project, id);
    await mkdir(dirname(path), {recursive: true});
    await Bun.write(path, JSON.stringify(payload) + "\n");
    return true;
}


export async function readLayout(root, project, id) {
    try {
        return await Bun.file(layoutFile(root, project, id)).json();
    } catch {
        return null;
    }
}


export async function deleteShape(root, project, id) {
    try {
        await unlink(shapeFile(root, project, id));
        return true;
    } catch (err) {
        if (err && err.code === "ENOENT") return false;
        throw err;
    }
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
    let existing = Variants.emptyCatalog(parsed.project);
    try {
        existing = await readCatalog(root, parsed.project);
    } catch {
        /* first write */
    }
    const merged = Variants.applyDrop(Variants.mergeCatalogs(parsed, existing), catalog && catalog.drop);
    const path = catalogFile(root, merged.project);
    await mkdir(dirname(path), {recursive: true});
    await Bun.write(path, JSON.stringify(Variants.serializeCatalog(merged), null, 2) + "\n");
    return merged;
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
