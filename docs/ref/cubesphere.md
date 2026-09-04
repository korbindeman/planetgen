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

**Scale is only half of it, and the other half is what a bake shows.** The
two face axes are not perpendicular on the ground. The skew is 0° at a face
centre and at an edge midpoint — exactly where the scale ratio is worst —
and −30° at a face **corner**, where the scale ratio is 1. Two equal axes
120° apart turn a circle into a **√3 = 1.73× ellipse**, so the real ground
anisotropy is worst at a corner and worse than the √2 above. check:tiles
pins all three points.

This is not academic. terrain-diffusion paints terrain that is isotropic in
its own square grid — measured at 0.5–5% anisotropy in raster axes — so
whatever this map does to a circle is printed on the ground, and it points a
different way on every face. Measured on the three level-4 tiles that meet
at one cube corner, the terrain's smoothest direction ran at 75°, 120° and
165° on the ground, each within one bin of its own tile's stretch axis. Two
tiles across a fold therefore meet with their terrain combed 60–120° apart,
which reads as a hard line even though the elevations, the roughness and the
colour are all continuous across it. Stitching cannot fix it: nothing about
the elevations is wrong.

## The bake plane

So the model does not paint on the tile square. It paints on the face's
**bake plane**: stereographic from the face centre, which is conformal, so
anisotropy is exactly 1 everywhere and the terrain has no direction to
inherit. What it spends instead is scale — 1.27× across a face, *less* than
the equal-angle square's √2, and scale is the distortion the model's learned
statistics already tolerate.

One plane per face, not one per tile. Per tile would be conformal too and
would throw away what the face-wide lattice buys: two tiles that touch name
overlapping cells of one grid, so the bake hands them the same noise there
and a same-face join is not a join at all.

`tileBakeRect(tile, cells, pad)` is a tile's rectangle on that lattice — its
footprint rounded out to whole cells, then grown by the pad. Rectangles are
**not** all `cells²`: a conformal plane does not cut a face into equal
squares, and a corner tile spans up to 1.5× the nominal count. Callers read
`cropW`/`cropH` off the rect, and `usableLevels` tests `worstBakeCells`
against the job cap rather than `tileCells`, or the picker would offer a
level the bake then refuses.

After the bake, `Seam.bakeToTile` resamples the result onto the tile's own
raster. **`output.elev` is always the tile raster** — the drape, the stitch,
the painter and the exporter never see the bake plane.

A fold is still two separate diffusions, so their terrain still differs
there; that is what the halo fade is for, and the cure for it is generating
both sides of a fold in one pass.

The **face-adjacency table** — edges and rotations — is the foundation
everything else shares: conditioning margins, hydrology routing across
face edges, rendering skirts.

## What check:tiles holds

- every direction lands in exactly one tile (a real partition)
- tile centres round-trip through the addressing
- levels nest, so picking a coarse tile picks whole finer tiles
- the equal-angle scale ratio stays at √2
- the ground anisotropy is 1 at a face centre, √2 at an edge midpoint and
  √3 at a corner — the number a bake's texture actually follows
- the bake plane is conformal (anisotropy 1 everywhere) and costs 1.27× of
  scale, under the equal-angle √2
- neighbouring bake rects are cells of one lattice, so the bake still shares
  noise along a same-face edge
- a bake rect covers its whole tile, and resamples back onto it keeping 85%+
  of a rough field's detail
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

Same-face neighbours share one bake-plane lattice, so their 90 m pixels
abut: the exporter feeds the pad at lattice cells the neighbour also names,
and adjacent tiles share coordinates at the seam instead of each starting at
(0, 0).

**A cube fold is a 90° turn in that plane.** Two native grids sample the
same ground and no origin shift can make them adjacent cells. So a job at
a fold also generates a one-cell halo past the edge; when the neighbour is
already baked, the new tile's DEM is resampled into the other tile's UV
and blended (`src/td-seam.js`). The new tile conforms to whatever is
already on disk — first bake owns the edge, and the join is C0.

**Proven on a real bake, and it was not enough.** Three level-4 tiles at one
cube corner were baked and cropped. The warp is right: elevations meet to a
few metres, roughness is continuous, and the painted colour step across a
join is 1.05–2.0× an ordinary neighbouring-pixel step. The join was still
obvious, because the two sides were *combed* differently — see the ground
anisotropy above. That is what the bake plane fixes, and `bun run seam` is
the capture that shows a corner without a browser.

What is left at a fold is that its two sides are separate diffusions. The
halo fade hides it over ~8 km; widening `SEAM_HALO_CELLS`, or generating
both sides in one pass, is the next lever. Tracked in
[terrain.md § Open](../stages/terrain.md#open).

## Prior art

The unmerged terrain-diffusion PR #15 "Sphere export" does cube-face
sampling. Read it; do not trust it.
