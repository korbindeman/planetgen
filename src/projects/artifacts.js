/*
 * Where a project's artifacts live.
 *
 * The project file holds the adopted body. Variants live in the catalog
 * tree. Captures, crops and bakes belong to a variant:
 *
 *   preview/<project>/                 Earth, or a project with no variant
 *   preview/<project>/project.json     a user project (not Thalos or Earth)
 *   preview/<project>/v/<id>/          one variant's folder
 *   preview/<project>/v/<id>/layout.json   the 10k sim
 *   preview/<project>/v/<id>/shape.json    the 23 km sketch
 *   preview/<project>/variants.json    the catalog
 *
 * The project root is never a dump of every variant's tiles. Listing
 * without a variant id does not walk `v/`.
 */
'use strict';


function projectSlug(name) {
    const slug = String(name || '').toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
        throw new Error(`bad project "${name}"`);
    }
    return slug;
}


function variantSlug(id) {
    const slug = String(id || '').toLowerCase();
    if (!/^v[a-z0-9]+$/.test(slug)) {
        throw new Error(`bad variant "${id}"`);
    }
    return slug;
}


function isVariantId(id) {
    return typeof id === 'string' && /^v[a-z0-9]+$/i.test(id);
}


function dir(project) {
    return `preview/${projectSlug(project)}`;
}


function variantDir(project, id) {
    return `${dir(project)}/v/${variantSlug(id)}`;
}


function bakeDir(project, variant) {
    return variant ? variantDir(project, variant) : dir(project);
}


function catalogPath(project) {
    return `${dir(project)}/variants.json`;
}


function projectFile(project) {
    return `${dir(project)}/project.json`;
}


function thumbPath(project, id) {
    return `${variantDir(project, id)}/thumb.jpg`;
}


function shapePath(project, id) {
    return `${variantDir(project, id)}/shape.json`;
}


function layoutPath(project, id) {
    return `${variantDir(project, id)}/layout.json`;
}


function sameSeed(a, b) {
    if (a == null || a === '' || b == null || b === '') return false;
    return String(a).toLowerCase() === String(b).toLowerCase();
}


module.exports = {
    projectSlug,
    variantSlug,
    isVariantId,
    dir,
    variantDir,
    bakeDir,
    catalogPath,
    projectFile,
    thumbPath,
    shapePath,
    layoutPath,
    sameSeed,
};
