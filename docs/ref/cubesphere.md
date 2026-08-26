# Reference — the cubesphere grid

The addressing scheme every downstream stage shares: preview tiles, the
planet-scale bake, hydrology routing, and rendering skirts. Code is
`src/cubesphere.js`; the partition is held by `bun run check:tiles`.

## The grid

Six equal-angle faces, a quadtree per face, and a tile addressed by
`(face, level, i, j)` **and nothing else**. Tiles are 512² at bake time.

Equal-angle, not gnomonic. Pixel scale varies within **√2 = 1.41×** worst
case against ~2.12× for raw gnomonic, so a "90 m" pixel is really
90–127 m/px depending where on the face it lands, worst at an edge
midpoint. That is inside tolerance for the model's learned statistics.

The analytic scale is `(1+X²)√(1+Y²)/r²`. `bun run check:tiles` pins the
ratio at √2 so a drift back toward gnomonic fails loudly. (This was
recorded as ~1.3× / ~115 m before `src/cubesphere.js` made it
measurable.)

The **face-adjacency table** — edges and rotations — is the foundation
everything else shares: conditioning margins, hydrology routing across
face edges, rendering skirts.

## What check:tiles holds

- every direction lands in exactly one tile (a real partition)
- tile centres round-trip through the addressing
- levels nest, so picking a coarse tile picks whole finer tiles
- the equal-angle scale ratio stays at √2
- the seam warp resamples correctly across a fold — on a **spherical
  field**, not on 90 m noise

## Invariants

- **A tile is `(face, level, i, j)`.** No lon/lat crop box. A box centred
  on wherever the mouse happened to be is what this grid replaced.
- **Levels nest.** Picking a coarse tile still picks whole bake tiles.
- **The grid draws unconditionally** — every face, every line, fixed
  subdivision, at every viewpoint. Do not add a visibility probe, a
  minimum-cell-size threshold, or view-dependent subdivision to make it
  cheaper. Each turns a smoothly varying measurement into a binary
  draw/skip and the grid flickers as the view moves. All three were tried
  and reverted.
- **Cull only on viewpoint-independent things**: the globe's back-face
  test, and an antimeridian break measured in **longitude**. Never in
  screen pixels — at high zoom one ordinary segment exceeds half the
  canvas, which silently chopped the grid to pieces.

## Seams

Same-face neighbours already share a `WorldPipeline` plane, so their 90 m
pixels abut: the exporter feeds the pad at a face-grid origin and
adjacent tiles share coordinates at the seam instead of each starting at
(0, 0).

**A cube fold is a 90° turn in that plane.** Two native grids sample the
same ground and no origin shift can make them adjacent cells. So a job at
a fold also generates a one-cell halo past the edge; when the neighbour is
already baked, the new tile's DEM is resampled into the other tile's UV
and blended (`src/td-seam.js`). The new tile conforms to whatever is
already on disk — first bake owns the edge, and the join is C0.

**Still unproven on a real bake.** `check:tiles` proves the warp on a
spherical field, which is enough to know the transform is right and not
enough to know the terrain matches. Two tiles sharing a **cube edge**
(not the same face) need baking and cropping. A three-face corner is
worse and is untouched. Tracked in [terrain.md § Open](../terrain.md#open).

## Prior art

The unmerged terrain-diffusion PR #15 "Sphere export" does cube-face
sampling. Read it; do not trust it.
