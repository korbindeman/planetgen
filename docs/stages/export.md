# Export

## What it does

Export turns the baked planet into what the game installs. **The bake is
an authoring product. The install is not the bake.**

Schema v1 is decided. The cubesphere bake that would feed it is not
written.

## Reads

The carved 90 m DEM ([hydrology](carve-hydrology.md),
[landforms](carve-landforms.md)), the 23 km climate fields, and the river
graph.

**Wishes** — none. Export takes what the pipeline made.

## Hands on

A **sparse cube-sphere pyramid**, not a dense GeoTIFF — addressed
`(face, lod, x, y)`, zstd per node, and stopping wherever the parent is
already good enough. Ocean, cratons and mare die at 1–2 km. Coasts, belts
and crater rims keep 90 m.

The precise contract is [§ The planet package](#the-planet-package), and the byte-level reference a consumer implements against is [ref/planet-package.md](../ref/planet-package.md). It is
**not** the game's schema v1 (`crates/domain/terrain/src/package.rs` in
`../thalos`). That schema was shaped for Mira — an airless moon, a
`StaticSurfaceData` full of cubemaps this pipeline does not produce, and a
`HEIGHT_PRUNE_ERROR_M` of 256 m chosen for 2.7 km/texel, which would prune
away everything a 90 m bake is for. Thalos is being rebuilt on a custom
engine, so the consumer is ours to write and the contract is ours to choose.

Alongside it: climate at the coarse cell (~23 km, megabytes), rivers as a
reach/lake graph (hundreds of MB for a planet), and analytic octaves as
an algorithm plus a seed.

| Body | Role | Install |
| --- | --- | --- |
| Thalos | home terrestrial | 2–3 GB |
| Ashara | larger terrestrial | 3–5 GB |
| Pelagos | ocean world | 1–2 GB |
| Mira-class moons | airless / ice | 0.2–0.8 GB each |
| Rocks (Selva, Nyx, Carpo, Theron) | small | tens of MB |
| Kael, Xxirt | 8–14 km | analytic or a few MB |
| Auron, Teros, Nereus | gas | no height package |

Dense 90 m int16 for Thalos is ~30 GB. After pruning, quantization and
zstd it should land at **2–3 GB**. Home pair (Thalos + Mira) is a ~2.5 GB
base. The rest is a solar-system pack or on-demand bodies. The whole
system fits in about **10–20 GB** — a texture pack. Dense 90 m for all of
Pyros' solid area (~one Earth, ~490 million km²) would be ~120 GB. That
is not a product.

**If one body crosses ~5 GB, the prune threshold is wrong.** Then 90 m
got stored on plains.

The current Mira `29.6 MiB` file is the crater MVP, not the production
number. The game-side package contract lives in `~/dev/thalos`
(`docs/world/mira_airless_mvp.md`, ADR-20260720T211046Z).

## The planet package

The contract between this repo and the engine. Decided Sep 2026, when Thalos
moved to a custom engine and the consumer became ours to write.

### One frame, end to end

Nodes are addressed on **the same equal-angle cubesphere the bake runs on** —
`(face, lod, x, y)`, `src/cubesphere.js`. No second projection, no re-frame at
the boundary.

This is the load-bearing decision. Every serious defect in the campaign was a
frame mismatch and none of them looked like one: the face import transposed
its windows and baked open ocean over tiles the sketch calls 100% land, while
every tile still agreed with its neighbours; then the cubemap builder mixed
this repo's z-up with the engine's y-up and would have shipped the planet on
its side; then the *validator* written to catch that had the same bug and
reported a confident 71.6%. A format that re-frames is a format that invites
all three again.

### Nodes

- **Grid**: `2^lod` nodes per face edge. Leaf lod is `bake level + 3`, because
  a bake tile is 8 nodes on a side.
- **Resolution**: `tileCells * 256 / 8` texels square — 448 for a 14-cell
  bake, 512 for a 16-cell one. The *node grid* is the power of two, not the
  node itself, which is what lets a leaf be a straight copy out of a tile
  raster: no resampling of the sphere, and reduction is exact 2:1 box
  averaging of four children.
- **Skirt**: one texel on every side, so a node carries `res + 2` square. The
  consumer computes normals and interpolates at an edge without ever looking
  up a neighbour, which is where cube-face code usually goes wrong. Costs
  under 1%.
- **Payload**: `i16`, zstd. Absolute metres at `lod <= dense_lod`; **residual
  against the bilinear parent above it**, with the high bit of the index
  record's lod byte saying which.

  Absolute everywhere was tried first, on the argument that a node should
  decode without walking its ancestors. The measurement killed it: a bilinear
  parent misses this terrain by a median **122 m** at the leaves and 565 m at
  p90, so no honest error budget prunes anything and every node is stored at
  full price — 3.38 GB, against 2.14 GB for the same planet with residuals.
  Sparsity cannot pay for itself when the predictor is that weak.

  Keeping the base absolute bounds what a residual costs: a leaf reconstructs
  through at most `leaf_lod - dense_lod` parents, two on the first planet.
  Prediction is **closed-loop** — the residual is taken against the parent the
  reader will have reconstructed, not the original — so nothing drifts as
  levels stack, and reconstruction is exact. Verified: leaves rebuilt from the
  file match the baked DEM to **0 m**.

### Dense base, sparse refinement

Every node exists from lod 0 to `dense_lod`. Above it, **a missing node means
exactly one thing: the parent is within the error budget.**

Absence must not also mean "no data". Schema v1 overloads the two and that is
how a planet ends up with holes. Here the masked abyss simply stops refining
early — the ground is still there at whatever lod last described it, and
[the mask](terrain.md) is a statement about detail, not about existence.

### Container

One file: magic, version, JSON manifest, fixed-size index records, blob
region. JSON so a person can read it; fixed records so the engine can mmap and
binary-search. A content hash over the inputs sits in the header, so a rebake
cannot quietly reuse a cache keyed to the previous planet.

### Measured, on the first planet

`quarter` / `glep`, 1593 km, level 3, 250 baked tiles, node 448 + skirt:

| | |
| --- | --- |
| Nodes | 25 429, lod 0..6 |
| File | **2.14 GB** (absolute-only was 3.38 GB) |
| Leaves | 17 904 nodes, 1.35 GB — 63% of the file |
| Reconstruction | **0 m** against the baked DEM |

The absolute base is 341 MB over 2046 nodes, which is where the next
compression lever is: `dense_lod` currently means both "every node exists" and
"stored absolute", and those are two different questions. Splitting them —
completeness at lod 4, absolute only at lod 0 and one keyframe level — would
take most of that 341 MB, at the cost of a longer reconstruct chain.

Scaled to Thalos, four times the area, this is ~8.5 GB against the 2-3 GB in
the table above. Either the prune threshold is doing nothing (it is: see the
predictor error) or the target assumed detail we are not throwing away. Settle
that before the Thalos bake, not after.

### For the next bake

Bake **16 cells per tile, not 14**. A tile is then 4096 px, a node is 512, and
the quadtree aligns with tile boundaries with no resample anywhere. 14 works —
it just forces 448-texel nodes.


## Must not regress

Do not ship:

- the dense bake
- latents (Q10 stays closed for distribution)
- a global `R16` range, or float32 heights
- a 90 m climate raster — climate stays at the coarse cell
- a planet-wide river raster — rivers are a graph

And: **deleting the disk cache must not change the planet.** Anything
below 90 m is an algorithm and a seed, not a stored artifact.

## How it works today

Schema v1 exists. Mira has a crater-MVP package. The cube-sphere bake
that would feed a real package is not written. `@planetgen/bake` is a
named slot.

### Below 90 m — decided, runtime

The model floor is 90 m. Ground-level gameplay needs ~1 m. That layer is
**non-ML amplification**. The game evaluates it lazily from residual,
slope, biome and seed: erosion-aware detail noise, slope and material
displacement, bottoming out around 0.5 m.

Do not bake it. Human scale is never a diffusion bake. 30 m globally is
a measurement we might take later. It is not the global bake. See
[ref/bake-compute.md](../ref/bake-compute.md). A one-step 90 m → 10 m
model in the game would reopen this line. That trial is not run. See
[custom-model.md](../custom-model.md).

The whole planet is playable: landable and flyable everywhere. Do not
treat 90 m windows as "the playable parts."

## Open

- The bake itself, which is [Terrain](terrain.md#open)'s open
  engineering.
- Prune thresholds per terrain class have a stated target (ocean and
  craton at 1–2 km, coasts and rims at 90 m). They have not been measured
  against a real planet.
- **Earth's residual pyramid.** Schema v1 with Earth's real DEM and
  the story maps attached. That artifact would be training data, the
  install format, and the answer key. `check:earth` locks a stats
  report. That is not a pyramid. This trial is not run. See
  [custom-model.md](../custom-model.md).
- A **system** would author the solar-system pack named above. Not built.
  See [systems.md](../systems.md).

## How to judge it

Install size against the table above, and a visual diff of the
reconstructed pyramid against the dense bake at several LODs. A prune
threshold that is too aggressive shows up as terracing on a slope, not as
a number.
