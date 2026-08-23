/*
 * Where a project's artifacts live.
 *
 * Pins and the seed are in the project file. Captures, crops and bakes
 * are on disk under preview/<name>/. The path is a string so the browser
 * bundle can name it; only the bake server reads the files.
 */
'use strict';


function projectSlug(name) {
    const slug = String(name || '').toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
        throw new Error(`bad project "${name}"`);
    }
    return slug;
}


function dir(project) {
    return `preview/${projectSlug(project)}`;
}


function sameSeed(a, b) {
    if (a == null || a === '' || b == null || b === '') return false;
    return String(a).toLowerCase() === String(b).toLowerCase();
}


module.exports = {projectSlug, dir, bakeDir: dir, sameSeed};
