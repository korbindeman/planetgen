/*
 * The stages from planetgen base to the raw bake export — the product a
 * game can convert, not a game package. Shared list; each project fills
 * in how far it has got. Missing or empty means not started.
 *
 * This is execution status, not the plan. The plan lives in
 * docs/full-planet-pipeline.md (decided / recommended / open).
 */
'use strict';

module.exports = [
    {id: 'base', label: 'Base', title: 'Planetgen: plates, heightmap, climate'},
    {id: 'conditioning', label: 'Conditioning', title: '23 km five-channel sketch'},
    {id: 'climate', label: 'Bake climate', title: 'ExoPlaSim (or climate.js until that trial)'},
    {id: 'regional', label: 'Regional DEM', title: 'terrain-diffusion on crops'},
    {id: 'cubesphere', label: 'Cubesphere', title: 'Faces, adjacency, one edge and one corner'},
    {id: 'coarse', label: 'Coarse planet', title: 'All six faces at 23 km, coarse model only'},
    {id: 'bake', label: '90 m bake', title: 'Full planet at the 90 m model'},
    {id: 'hydrology', label: 'Hydrology', title: 'Rivers, lakes, canyons on the baked DEM'},
    {id: 'export', label: 'Export', title: 'Residual pyramid: the raw product'},
];
