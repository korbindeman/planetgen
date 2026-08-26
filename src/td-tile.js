/*
 * Shared constants for the terrain-diffusion crop path.
 *
 * Tile *geometry* is not here any more — it is `src/cubesphere.js`, where a
 * tile is (face, level, i, j) on the same grid the planet-scale bake will
 * use. What is left is the conditioning scale the model wants and the range
 * the view is allowed to zoom over.
 *
 * The old boxAround / boxFromCorners lived here. They built a crop centred
 * on wherever the mouse happened to be, quantised the span and then re-centred
 * the result on the drag's midpoint, so a crop snapped to nothing and a drag
 * trailed the cursor at half speed. Both are gone rather than patched: with a
 * grid there is no box to fit.
 */
'use strict';

const TD_EARTH_KM = 40075.017;
/* The 90 m model's conditioning grain: one coarse cell is 23 km. */
const SCALE_KM = 23;

/*
 * Cells a bake will accept across one side. Fewer than MIN and there is not
 * enough conditioning for the model to work from; more than MAX and it stops
 * being a preview. Shared with the bake server on purpose — when the picker
 * and the server disagreed about this, the picker happily offered a level the
 * server then refused, and said so only as a sample-count mismatch.
 */
const MIN_CELLS = 6;
const MAX_CELLS = 24;

/*
 * Coarse cells of real neighbouring terrain around a cube tile. Same count
 * `tiff-export` uses for its `mode="edge"` pad — we replace that pad rather
 * than stacking another 64 on top. The U-Net's window is 64, so this is
 * the context it actually consumes at a crop border.
 */
const CONTEXT_PAD = 64;

/*
 * Coarse cells of 90 m output generated past a *face* edge, then stripped
 * from the draped interior. Same-face tiles do not need this — they already
 * share WorldPipeline coordinates. A cube fold does: the halo is that
 * neighbour's ground in this face's continuation, so a stitch can resample
 * it instead of averaging two different noise fields at a cut.
 */
const SEAM_HALO_CELLS = 1;

/*
 * WorldPipeline cell of the padded raster's top-left. Adjacent tiles on
 * one face share this plane, so they share noise at the edge instead of
 * each starting at (0, 0) with a repeated rim. Row 0 is north (high j):
 * a face is one north-up mosaic.
 */
function contextOrigin(tile, cells, pad = CONTEXT_PAD) {
    const n = 1 << tile.level;
    return {
        originI: (n - 1 - tile.j) * cells - pad,
        originJ: tile.i * cells - pad,
    };
}

/* Output halo only on cube folds. Same-face edges already share a plane. */
function haloCellsFor(tile, cells = SEAM_HALO_CELLS) {
    if (!tile) return {north: 0, east: 0, south: 0, west: 0};
    const n = 1 << tile.level;
    const h = Math.max(0, cells | 0);
    return {
        north: tile.j === n - 1 ? h : 0,
        east: tile.i === n - 1 ? h : 0,
        south: tile.j === 0 ? h : 0,
        west: tile.i === 0 ? h : 0,
    };
}

/* What a preview tile covers on the ground. The picker uses this one size:
 * the bakeable cube level nearest it, per planet. Cover more ground by
 * picking more tiles, not a coarser level. A tile is a fixed slice of the
 * sphere, so the same level means different ground on a smaller planet. */
const TARGET_TILE_KM = 310;
/* 1 is the whole planet. 512 is enough that a 90 m cell is a couple of
 * screen pixels — Maps-style inspect, not a street view. */
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 512;

function wrapLon(lon) {
    let l = lon;
    while (l < -180) l += 360;
    while (l >= 180) l -= 360;
    return l;
}

module.exports = {
    TD_EARTH_KM,
    SCALE_KM,
    MIN_CELLS,
    MAX_CELLS,
    CONTEXT_PAD,
    SEAM_HALO_CELLS,
    TARGET_TILE_KM,
    ZOOM_MIN,
    ZOOM_MAX,
    wrapLon,
    contextOrigin,
    haloCellsFor,
};
