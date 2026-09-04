# Why cube folds showed a seam — Sep 2026

**Historical. Do not update this file.** It records what the fold seam
actually was, how it was measured, and why the bake moved off the tile
square. What the bake does *now* is [terrain.md](../stages/terrain.md) and
[ref/cubesphere.md](../ref/cubesphere.md). Further work belongs there.

Status labels are **decided**, **recommended**, **open**, as in
[../README.md](../README.md).

## The symptom

Three level-4 tiles that meet at one cube corner — `f1l4x15y0`,
`f2l4x0y0`, `f5l4x15y0` on Thalos `v1788473173180` — drew as a 3D box.
Each face had its own flat tone and the folds read as hard straight lines.
It survived the Relief look, where colour is elevation alone.

## What it was not — decided

Every obvious cause was measured and cleared:

- **Not an elevation step.** Profiles ±800 px across each join were smooth:
  no step, no per-tile bias.
- **Not roughness.** Continuous across the joins.
- **Not a local discontinuity at all.** The painted colour step across the
  line was 1.05–2.0× an ordinary neighbouring-pixel step. That ratio is why
  the seam resisted diagnosis for so long: it is a one-pixel metric and the
  break was not one pixel wide.
- **Not the stitch.** `blendFromNeighbor` was doing its job.

Two real bugs were found and fixed along the way, and neither was the cause:
the overlay hillshaded in each tile's own texel axes (so the light pointed
57–118° apart across a fold), and both painters read the coarse climate with
a clamp that pinned every sample into the context pad, ~50 cells outside the
tile. Fixing them moved the picture but not the seam.

## What it was — decided

**The equal-angle face square is not conformal, and the model paints
isotropic terrain in whatever grid it is given.**

Scale had always been the pinned number — √2 across a face, worst at an edge
midpoint. Skew was never measured. It is 0° at a face centre *and* at an edge
midpoint, and −30° at a face **corner**, where the scale ratio is 1. Two equal
axes 120° apart turn a circle into a **√3 = 1.73:1 ellipse**, so the real
ground anisotropy is worst exactly where scale says it is best.

terrain-diffusion paints terrain isotropic in its own square grid — measured
at 0.5–5% anisotropy in raster axes — so that ellipse is printed on the
ground, pointing a different way on every face. Measured directly, as rms
rise over 900 m by compass bearing:

| tile | smoothest ground bearing | its projection's stretch axis | ratio |
| --- | --- | --- | --- |
| `f1l4x15y0` | 75° | 58° | 1.33 |
| `f2l4x0y0` | 120° | 121° | 1.43 |
| `f5l4x15y0` | 165° | 0° | 1.24 |

Each tile's terrain is combed along its own stretch axis, 60–120° from its
neighbour's. Two differently-combed textures meeting on a dead-straight line
is what the eye locks onto. No stitch can fix it: nothing about the
elevations is wrong.

The bake in question sat at a three-face corner — the worst point on the
sphere. At a face centre the distortion is 1:1.

## The bake plane — decided

The model no longer paints on the tile square. It paints on the face's
**bake plane**: stereographic from the face centre, conformal, so anisotropy
is exactly 1 everywhere. It costs 1.27× of scale across a face, *less* than
the equal-angle square's √2, and scale is the distortion the model tolerates.

**One plane per face, not one per tile.** Per tile would be conformal too and
was the first instinct, but it throws away what the face-wide lattice buys:
two tiles that touch name overlapping cells of one grid, so the bake gives
them the same noise and a same-face join is not a join. A face-wide plane
keeps that and drops the shear.

The tile grid is untouched. `tileDirection`, addressing, nesting and the
drape are all unchanged; the bake is resampled back onto the tile raster
before anything downstream sees it, and `output.elev` is still the tile
raster. What changed is the raster the model works on.

The cost is that bake rects are no longer all `cells²` — a conformal plane
does not cut a face into equal squares, and a corner tile spans up to 1.5×
the nominal count. `usableLevels` tests `worstBakeCells` against the job cap
instead of `tileCells`, or the picker offers a level the bake then refuses.

## What the first real bake found — decided

The geometry was provable headlessly. The pipeline was not, and three bugs
only appeared once tiles were actually baked and looked at:

- **The conditioning smeared.** Stereographic has an answer for almost the
  whole sphere, so one far-side triangle's bounding box covered the raster
  and painted a tile flat at −0.920. The equal-angle projector refuses
  `w <= 0` for this reason; the bake plane now refuses `c <= 0` too.
- **Tile rasters came back 1195 px instead of 1792.** `td-preview.py` caps
  the dump at 2048, and the bake raster now covers tile *plus* halo, so the
  cap applied to a bigger picture and the tile's share shrank.
- **A tile's halo contradicted its own interior by 32 m.** The halo was cut
  before the stitch moved the interior near that edge. The halo is what the
  *next* tile conforms to, so the next tile was pulled onto a surface this
  one no longer had — a crease down the fold. Compounding it, the batch
  stitched onto the generation it was replacing: the *first* tile conformed
  to the run being overwritten, inverting the ordering.

After the fixes, the three edges meet to 0.2 m (f1 803.0, f5 802.9, f5's
halo 803.1) and the corner draws as continuous ground.

## What this does not fix — open

A fold's two sides are still separate diffusions, so their terrain differs
there; only their elevations agree. The halo fade hides it over ~8 km.
Widening `SEAM_HALO_CELLS`, or generating both sides of a fold in one pass,
is the next lever if it ever reads. It did not read on this corner.

The bake-vs-coarse boundary is a different seam and is untouched: the globe
shades the coarse surface in **screen space** (`dFdx` of the elevation
varying, so the light rotates with the camera) while a baked tile is painted
once in a geographic frame. Those two can never quite agree. Making them
agree means hillshading the tile in the fragment shader, which trades the
seam for minification aliasing, since a 1792² NPOT texture cannot mipmap in
WebGL1.
