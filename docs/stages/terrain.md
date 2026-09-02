# Terrain

## What it does

Terrain turns the 23 km sketch into a 90 m DEM with
[terrain-diffusion](https://github.com/xandergos/terrain-diffusion). That
is the bake. Ridges, valley spacing, coast crenulation: **landform
statistics**. Not drainage. Drainage is [Carve](carve-hydrology.md).

This stage is designed on that model's contract: five channels, no
river graph, no feature list. A later Terrain would split into two
learned grains with Hydrology between them. That file is
[custom-model.md](../custom-model.md). Do not rewrite this stage to
match that order.

The model is a sibling checkout at `~/dev/terrain-diffusion`. It is never
vendored into this tree. What it reads is
[ref/terrain-diffusion.md](../ref/terrain-diffusion.md).

Grain in is 23 km/px. Grain out is 90 m/px — 256× on each axis.

## Reads

The [sketch](shape.md#hands-on), rasterized into five single-band float32
GeoTIFFs per tile.

| Channel | From | Mapping |
| --- | --- | --- |
| `heightmap.tif` | `r_meters` | metres, sea level = 0 |
| `temperature.tif` | `r_temperature` | °C |
| `temperature_std.tif` | derived | °C, from latitude + inland dryness |
| `precipitation.tif` | `r_moisture` | mm/yr |
| `precipitation_cv.tif` | derived | %, from dryness + seasonality |

Exact conversions in
[ref/terrain-diffusion.md § Unit mapping](../ref/terrain-diffusion.md#unit-mapping).

**Wishes** — what Terrain would use if upstream emitted it:

- **Two channels are guessed, not simulated.** `temperature_std` and
  `precipitation_cv` are derived from latitude and dryness because
  nothing upstream models a seasonal cycle. A GCM would supply all four
  from physics. See [climate.md § Open](climate.md#open). This is the
  outstanding upstream ask in the pipeline.
- **Polar conditioning that the model believes.** The model saw no
  training data past ±60°. Pinning climate channels cold at high SNR is
  the current mitigation. It is not an answer.

## Hands on

`output.elev` — the DEM in **raw float metres**, plus int16 GeoTIFF for
downstream tools. LZW tiled 256×256, with the sketch's geotransform and
CRS copied on.

Consumed by [Carve](carve-hydrology.md), then [Export](export.md).

Downstream consumers — game mesh, hydrology, any external tool — read
that GeoTIFF, never the planetgen canvas.

**Not `output.png`.** That file was coloured once at bake time. It could
never follow the map. What lands on the globe is `output.elev`, coloured
in the browser with the globe's own surface look.

## Must not regress

- **Do not vendor terrain-diffusion.** The studio orchestrates a sibling
  checkout and kicks it as a subprocess.
- **Do not `tiff-export` the whole-world raster.** The 720×360 `world/`
  raster is for inspection. Upsampling it in one shot is pole distortion
  plus one giant job. That is wrong. The cubesphere replaced it.
- **The tile grid is `(face, level, i, j)` and draws unconditionally.**
  No lon/lat crop box, no visibility probe, no view-dependent
  subdivision. Those were tried and reverted. The full list and the
  reasons are [ref/cubesphere.md § Invariants](../ref/cubesphere.md#invariants).
- **Do not raise elevation SNR to freeze a blocky sketch.** Very high
  ELEV SNR (1.5+) on an out-of-distribution sketch collapsed relief in
  tests. The coarse model is trained on Earth statistics. It will
  "correct" shapes it does not believe.

## How it works today

### Preview tiles: a Shape tool

Pick tiles on the [cubesphere grid](../ref/cubesphere.md), bake, drape on
the globe. In the studio this is a **tool inside Shape**, not a stage and
not a step you browse to. Tiles belong to a variant
(`preview/<project>/v/<id>/`). They do not follow you onto the next
candidate.

Hold shift over the canvas to see the grid and a ghost of the tile under
the cursor. Click a tile, or drag across several. Each picked tile is its
own bake job. Because levels nest, picking a coarse tile still picks
whole bake tiles.

The exporter rasterizes **64 cells of real neighbouring ground**,
including across a face edge. `scripts/td-bake.py` feeds that pad to
`WorldPipeline` at a face-grid origin. Adjacent tiles on one face then
share coordinates at the seam instead of each starting at (0, 0). That
replaces the importer's default `mode="edge"` rim repeat. A cube fold is
a 90° turn in that plane, so those jobs also generate a one-cell halo
past the edge. If the neighbour is already baked, the new tile's DEM is
resampled and blended against that halo (`src/td-seam.js`). First bake
owns the edge. The join is C0.

Isolated lon/lat crops still go through `tiff-export`. CLI:
`bun run export:td` writes regional sketches under `preview/<name>/`.

### The planet-scale plan — decided in approach

- **Cubesphere, equal-angle.** Six faces, quadtree per face, 512² tiles.
  Keeps pixel scale within **√2** worst case against ~2.12× for raw
  gnomonic. Details and the invariants in
  [ref/cubesphere.md](../ref/cubesphere.md).
- **Generate per face** on the face's raster via `WorldPipeline` +
  `set_custom_conditioning_import()`, not `tiff-export`. Conditioning for
  each face is the sketch reprojected into that face's projection. The
  sketch is extended past the edges with reprojected neighbour-face data.
  Then the 64-cell context pad sees real terrain.
- **Any partition of the tile list is a valid shard.** `get(i1,j1,i2,j2)`
  is a pure function of `(seed, coords)` plus a bounded parent window —
  InfiniteDiffusion's random access. N GPUs means N processes on the same
  seed and conditioning. Shared parent latents at a cut are recomputed or
  read from a shared tile store. Either way the pixels match. No
  generation-order constraint. No required seam blend. One
  `WorldPipeline` process will **not** see the other GPUs on an 8-wide
  machine. Shard the list yourself.
- Compute, wall-clock and sizes: [ref/bake-compute.md](../ref/bake-compute.md).

`@planetgen/bake` is a named slot. Nothing there runs yet.

## Open

- **Seams.** Overlap generation bands across face edges and blend
  elevation in the overlap. Corners, where three faces meet, are the hard
  case. `bun run check:tiles` proves the warp on a spherical field, not
  on 90 m noise. This needs a real bake. Pick two tiles that share a
  **cube edge**, not two on the same face. Same-face tiles use the
  shared-origin path. Bake both. Crop the join from orbit and at
  Maps-style zoom. Then crop a corner. The unmerged terrain-diffusion
  PR #15 "Sphere export" does cube-face sampling. It is prior art to
  read, not code to trust.
- **Poles.** The cubesphere removes equirect distortion. The ±60°
  training clip remains. Mitigation is pinning climate channels cold at
  high SNR and treating ice sheets as a post-pass. Open until a polar
  face looks right.
- **`coarse_pooling`** in `WorldPipeline` compresses horizontal space and
  intensifies terrain. A generation knob to understand. Not a planetgen
  export setting.
- **Content-addressed preview bakes.** Tiles live under the variant
  folder today. Saving a sibling snapshot invalidates tiles whose ground
  never moved. Address each tile by a hash of the local sketch it was
  baked from instead. Then a surgical edit elsewhere on the planet stops
  throwing away still-correct tiles.

The plan is an offline bake of one reference planet. The model's
InfiniteDiffusion random access also makes on-demand generation possible
later. Nothing here should preclude it. Keep tiles as deterministic
functions of `(seed, face, level, i, j)` wherever you can.

### Current sprint

Designed on [terrain-diffusion's contract](../ref/terrain-diffusion.md).
Five channels. No river graph. No feature list. Hydrology stays after
the 90 m DEM.

1. Cubesphere face raster + adjacency table, and one face generated via
   `WorldPipeline` with imported conditioning. Compare against a
   `tiff-export` crop of the same region.
2. One face edge, then one corner, seam-blended and cropped.
3. Cheap whole-planet pass: all six faces at 23 km conditioning, coarse
   model only. First look at the planet as a planet. A drainage graph
   on that pass would be a preview. Those rivers do not constrain the
   90 m pass.
4. Scale out to the 90 m bake. Mask to land and shelf if a trial shows
   the abyss does not need it. That trial is not run. Then hand off to
   Carve.

A late sea-level cut on the carved DEM is a Finish step. It is not a
re-bake unless the new shoreline leaves the baked band. See
[carve-landforms.md § Open](carve-landforms.md#open).

### Not this sprint

A later Terrain would invert drainage into the middle of the bake.
That file is [custom-model.md](../custom-model.md).

Earth's residual pyramid, with the story maps attached, is a parallel
artifact. It would be training data and the install format.
`check:earth` locks a stats report. That is not a pyramid. See
[export.md § Open](export.md#open).

## How to judge it

Judge the **heightmap**, not the green hillshade. Diffusion does not
paint biomes. Dryness only shows up if you colour by climate or use an
arid ramp.

Crop a bake and look at it twice: from orbit, and at Maps-style zoom. A
seam that is invisible at planet scale can be a wall at 90 m.

What to expect from a given sketch is tabulated in
[ref/terrain-diffusion.md § Landforms](../ref/terrain-diffusion.md#landforms-you-can-expect).
