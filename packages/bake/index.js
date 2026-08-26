/*
 * Cubesphere bake — not implemented.
 *
 * Six equal-angle faces, overlap at the edges, blend at the seams.
 * Talks to the sibling terrain-diffusion checkout; it does not vend it.
 */
'use strict';

function run() {
    throw new Error(
        '@planetgen/bake is a named slot. The cubesphere bake is not in this repo. See docs/terrain.md.',
    );
}

module.exports = {run};
