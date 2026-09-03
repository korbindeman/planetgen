# @planetgen/hydrology

Named slot for fine drainage on the baked DEM. Nothing here runs yet.
`run()` throws. See `docs/stages/carve-hydrology.md`.

The grain-independent drain lives in `src/route.js`. Shape uses a light
cut of that for valley texture and a drain tree. This package would call
the same core on the 90 m cubesphere when Carve starts.

How hard to cut on the bake is **open**. Do not rerun Shape's incision
knobs here.
