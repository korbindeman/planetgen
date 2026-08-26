/*
 * The stages from Discover through Finish. Shared list; each project fills
 * in how far it has got. Missing or empty means not started.
 *
 * This is execution status, not the plan. Canonical model:
 * docs/studio.md. Preview tiles are a Shape tool, not a stage.
 */
'use strict';

module.exports = [
    {id: 'layout', label: 'Layout', title: 'Plates and continents — the 10k sim'},
    {id: 'shape', label: 'Shape', title: '23 km sketch: coasts, island bodies, belt grain'},
    {id: 'climate', label: 'Climate', title: 'Bake-time climate on the sketch (ExoPlaSim)'},
    {id: 'terrain', label: 'Terrain', title: 'Whole-planet diffusion: cheap pass then 90 m'},
        {id: 'carve', label: 'Carve', title: 'Rivers, fjords, and stamps on the baked DEM'},
    {id: 'export', label: 'Export', title: 'Residual pyramid: the raw product'},
];
