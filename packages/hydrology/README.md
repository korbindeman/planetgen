# @planetgen/hydrology

Named slot for fine drainage on the baked DEM: priority-flood, D8 routing across cubesphere face edges, stream-power incision, lakes.

The detail pass in this repo only roughs in valleys. Do not carve a river network on the ~220 km sim mesh.

How hard to cut is **open**. The 90 m bake already looks eroded; this pass has to connect drainage without a second landscape-evolution. See `docs/preparing-for-diffusion.md`.
