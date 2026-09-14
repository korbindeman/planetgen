# The first planet-scale bake — Sep 2026

**Historical. Do not update this file.** It records what the first whole-planet
campaign actually cost, the six defects it exposed, and why each one survived
the obvious check. What the bake does *now* is
[terrain.md](../stages/terrain.md); the package is
[export.md](../stages/export.md) and
[ref/planet-package.md](../ref/planet-package.md). Further work belongs there.

Status labels are **decided**, **recommended**, **open**, as in
[../README.md](../README.md).

## What ran

`quarter` / `glep` — a 1593 km body, a quarter of Earth's radius, made to
rehearse the path at a quarter of Thalos's area before committing a night to
Thalos itself.

| | |
| --- | --- |
| Bake | level 3, 250 of 384 tiles after masking, **0 failed** |
| Output | 12.8 GB of 90 m DEM, 3584² float32 a tile |
| Rate | 23–32 s a tile, ~3.3 h of GPU |
| Package | 25 429 nodes, 2.14 GB, reconstruction exact to **0 m** |

Two orders-of-magnitude wins made it a night instead of a week: a **persistent
WSL2 worker** (the model loads and compiles once, not 384 times — ~4 h) and
the **land-and-shelf mask** (~1 h). Both are documented where they live:
[wsl-bake-env](../ref/wsl-bake-env.md), [terrain.md](../stages/terrain.md).

The run survived a session teardown and a PC crash. Resumability was not a
nicety: it was used twice, and the integrity scan that goes with it — file
size against `width * height * 4` — is what makes "resume" safe, because
`alreadyBaked` only ever checked that a file *existed*.

## The shape of every defect here — decided

Six things went wrong. **Every one produced internally consistent output**, and
every one passed the check that seemed natural at the time:

- tiles that disagreed with their neighbours by 269 m — but each tile was a
  perfectly good tile;
- windows that baked open ocean onto land — but every tile still agreed with
  its neighbours;
- a cubemap laid on its side — and a validator that made the same mistake and
  scored it a confident 71.6%;
- a package that decoded cleanly, every blob the right size, heights in range
  — with 180 nodes unreachable;
- an encoding chosen on a good argument that the measurement destroyed;
- a preview that was a faithful average of the DEM and looked wrong anyway.

The lesson is not "check more". It is **what** to check. Consistency checks —
does it decode, do neighbours agree, is it in range — passed on wrong
artifacts every time. What caught these was always a comparison against
something *independent*: the sketch the bake was conditioned on, the app's own
equirect, the source DEM. If a check can only see the artifact, it cannot tell
you the artifact is in the wrong place.

## Same-face joins were never seamless — decided

[terrain.md](../stages/terrain.md) had assumed they were seamless by
construction: neighbours share the bake plane's lattice, so the model gives
them the same noise. Baked and cropped for the first time, `f0l4x1y8` against
`f0l4x1y9`:

| | |
| --- | --- |
| Mean disagreement along the shared edge | **269 m** |
| Worst | 1351 m |
| One row to the next *inside* a tile | 9 m |
| Correlation of the two edge profiles | r = 0.88 |

r = 0.88 is the tell: the same landforms, read off the same sketch, with
independent detail laid over them. Two diffusions, not one.

The cause is one conditioning import per tile.
`set_custom_conditioning_import` calls `rebuild()`, and `rebuild()` installs a
fresh `MemoryTileStore` — so neighbours never share a parent latent however
well their lattices line up. **Sharing the lattice was necessary and never
sufficient.** Importing once per *face* and taking each tile as a window of it
brings the same pair to **1.7 m mean, 37 m max**.

`bun run bake:tiles` still imports per tile. That is correct for what it is: a
preview tool, and a preview tile has no neighbour to disagree with.

## The face frame, and a fix that was a guess — decided

The face-wide import then baked **open ocean over tiles the sketch calls 100%
land**. Neighbouring windows still agreed with each other perfectly, because
they were all wrong the same way. Nothing internal to the bake could see it.
What saw it was comparing each tile's baked land fraction against its own
conditioning — now a guard in `bake-campaign.mjs` that stops the run after
three disagreements rather than filling a night.

The cause was a frame. `bakeDirection` maps a rasterized rect's **column** to
`X = originI + x` and its **row** to `Y = originJ + height - y` — and the Y
axis is *flipped*, row 0 being the highest Y. The python anchors an import
`[row, col]` at `(origin_i, origin_j)`. Per tile the two compose into
something self-consistent, and a lone tile does not care which absolute cells
it sat on. Sharing one import across a face is what makes the frame matter.

The first fix was a **guess** — swap the axes — and it was wrong; the guard
fired again. Deriving it properly gives one frame for the whole face:

```
i = -Y        j = X
```

A transpose was the obvious reading and the flip is what the obvious reading
misses. **Derive the frame; do not pattern-match it.**

## Frames at a boundary — decided

Assembling the bake into the game's cubemap put a *third* convention in play.
This repo is **z-up** (`lonLatToXyz` puts latitude on z, `+z` is the pole);
glam and the OpenGL cubemap convention are **y-up** with `PosY` as the pole.
Feeding a game-frame direction straight into `xyzToLonLat` reads the pole as
the equator and lays the planet on its side.

Two details that only show up if you look for them:

- The sign is not free. `(x, z, y)` has determinant −1 and ships a **mirrored**
  planet, every coastline handed the wrong way. `(x, -z, y)` is the rotation.
- **The validator had the same bug.** Written to catch exactly this, it
  hand-rolled the same y-up assumption and reported 71.6% agreement — above
  chance, plausible enough to blame the data. Corrected, both agreed at
  **98.9%** with sea share matching to a tenth of a percent.

A checker that shares an assumption with the thing it checks is not a check.
This is why [ref/planet-package.md](../ref/planet-package.md) makes one frame
end-to-end the load-bearing decision of the format.

## Sparsity needs a predictor that works — decided

The package first stored **absolute** i16 heights, argued for on the grounds
that a node should decode without walking its ancestors — good for streaming
and for a collision query. The error distribution killed it:

| lod | nodes | median predictor error | p90 |
| --- | --- | --- | --- |
| 4 | 1 536 | 316 m | 1132 m |
| 5 | 5 479 | 231 m | 877 m |
| 6 (leaf) | 17 904 | **122 m** | 565 m |

A bilinear parent misses real 90 m terrain by *hundreds* of metres. So no
honest error budget prunes anything, and every node is stored at full price:
**3.38 GB**, against **2.14 GB** with residuals. Sparsity cannot pay for
itself when the predictor is that weak — and reaching a useful size by raising
the budget to 250 m would have been the Mira mistake, `HEIGHT_PRUNE_ERROR_M`
under another name.

`export.md` had specified residuals from the start. The argument for deferring
them was reasonable and wrong, and only the measurement said so.

## Absence has to mean exactly one thing — decided

Pruning was decided per node, so a pruned parent could still have an emitted
child: **180 nodes with no parent in the file**. The package decoded cleanly,
every blob was the right size, heights were in range, the dense base was
complete. Only a reachability check saw it.

If a missing node means "the parent is good enough", a reader that stops
descending at a gap must not be skipping detail that exists below. So pruning
**cascades** — a dropped node takes its subtree with it — and absence never
also means "no data". Overloading those two is how a planet gets holes.

## Filters are not interchangeable — decided

Two separate failures, same root: choosing a resampling kernel without asking
what reads the result.

**Nearest-neighbour on the sketch fallback.** One 23 km conditioning cell
became a 240-texel square of constant height. It looked like a staircase, and
worse it was *unprunable* — a bilinear parent cannot follow a step edge, so
max-abs error stayed enormous and every one of those nodes was kept at leaf
resolution to describe a flat plain. A third of the sphere.

**Box-averaging a DEM and then shading it.** Hillshading is nonlinear:
`shade(downsample(h))` is not `downsample(shade(h))`. Rendered side by side at
the same size, a tile shaded at 3584² and then reduced is soft and finely
detailed; the same tile box-averaged to 448² and *then* shaded is harsh and
faceted, because averaging strips the fine structure that would soften a slope
while keeping the step between neighbouring coarse texels. A separable
Gaussian and more resolution take out most of it. Only shading near-native
removes it, which is the studio LOD work.

## The await in the inner loop — decided

Three times in one session, the same shape: resolving a data source *per
texel* inside a loop that runs hundreds of millions of times. The cubemap
builder did it first (an `await` per sample, six hours), then the package's
leaf extractor (a 450² loop run 24 576 times — five billion promises).

The fix is always the same: resolve the source **once per tile** into a plain
array, then let the inner loop be a synchronous index. For the package that
meant expanding each tile once into `(tileSide + 2)²` int16 with its border
already filled from neighbours, after which every leaf is a pure slice.

If an inner loop touches I/O or a cache lookup, it is the wrong loop.

## What the checks were worth — decided

| Check | What it caught |
| --- | --- |
| Baked land fraction vs the sketch | windows on the wrong ground |
| Every node has a parent | 180 unreachable nodes |
| Reconstruct and compare to the source DEM | would have caught any predictor drift; confirmed 0 m |
| Land/sea agreement vs the app's own equirect | the z-up/y-up frame, once the checker was fixed |
| File size vs `width * height * 4` | a truncated tile that resume would have skipped |
| Rendering it and looking | the shading harshness, which every number called fine |

The last row matters. The 448² preview was a *faithful* average of the DEM —
verified to 1.3 m against a box average of the source — and it still looked
wrong. Some defects are only visible as a picture.

## What this does not fix — open

- **Fold seams.** Elevation agrees across a cube fold; terrain character does
  not. `f0l3x0y3 | f3l3x7y3` stitched 321k edge pixels and still reads as a
  change of texture. The stitch fixes level, not character. Twelve fold lines
  on a planet.
- **Package size against the target.** 2.14 GB here scales to ~8.5 GB for
  Thalos, against the 2–3 GB in [export.md](../stages/export.md). Either the
  prune budget is inert — it is — or the target assumed detail we are not
  discarding. Settle it before the Thalos bake.
- **The studio is a preview.** It shades a reduced DEM at uniform resolution
  and cannot look like the raw bake until per-tile LOD lands.
- **Poles and a polar fold** were baked but never looked at closely.
- **`dense_lod` means two things** — every node exists, and stored absolute.
  Splitting them is the next compression lever.

## For the next bake — recommended

**16 cells per tile, not 14.** A tile is then 4096 px, a package node is 512,
and the node grid aligns with tile boundaries with no resample anywhere. 14
works and forces 448-texel nodes and one resample at the cubemap boundary.

Validate a 2×2 block over land *and* a pair across a fold before committing
the night. Both took three minutes and both found something.
