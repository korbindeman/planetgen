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

The model is a sibling checkout at `../terrain-diffusion` — see
[ref/terrain-diffusion.md § Where it lives](../ref/terrain-diffusion.md#where-it-lives)
for that path and for the native-Windows and WSL2 environments. It is never
vendored into this tree. What it reads is
[ref/terrain-diffusion.md](../ref/terrain-diffusion.md).

Grain in is 23 km/px. Grain out is 90 m/px — 256× on each axis.

## Reads

The [sketch](shape.md#hands-on), rasterized into five single-band float32
GeoTIFFs per tile.

| Channel | From | Mapping |
| --- | --- | --- |
| `heightmap.tif` | `r_meters` | metres, sea level = 0 |
| `temperature.tif` | seasonal monthly temperature | annual mean, °C |
| `temperature_std.tif` | seasonal monthly temperature | sample SD, °C |
| `precipitation.tif` | seasonal monthly precipitation | annual sum, mm/yr |
| `precipitation_cv.tif` | seasonal monthly precipitation | WorldClim CV, % |

Exact conversions in
[ref/terrain-diffusion.md § Unit mapping](../ref/terrain-diffusion.md#unit-mapping).

**Wishes** — what Terrain would use if upstream emitted it:

- **Independent climate validation.** The seasonal model now supplies all
  four channels from monthly fields. A GCM comparison remains open;
  see [climate.md § Open](climate.md#open). Regional Shape preview tiles
  and old campaigns retain normalized preview climate and its seasonality
  heuristics.
- **Polar conditioning that the model believes.** The model saw no
  training data past ±60°. Pinning climate channels cold at high SNR is
  the current mitigation. It is not an answer.

## Hands on

`output.elev` — the DEM in **raw Float32 metres**, plus a Float32 GeoTIFF
for downstream tools. LZW tiled 256×256, with the sketch's geotransform and
CRS copied on. The worker preserves the model's sub-metre signs without
integer truncation or height clamping. Invalid/non-finite samples fail the
bake. The masked cache also stores Float32; its convex fade preserves a
fully selected model sample exactly, even beside a deep fallback.

Consumed by [Carve](carve-hydrology.md), then [Export](export.md).

Downstream consumers — game mesh, hydrology, any external tool — read
that GeoTIFF, never the planetgen canvas.

**Not `output.png`.** That file was coloured once at bake time. It could
never follow the map. What lands on the globe is `output.elev`, coloured
in the browser with the globe's own surface look.

### Campaign overlap and fine-mask trial

Campaigns load the saved Layout and Shape artifacts, including sculpted
fields and the separate Shape seed. They do not regenerate the recipe
against current simulation code. `campaign-settings.json` stamps their
sketch fingerprint and model/lattice settings. A resumable tile needs a
completion marker and intact DEM dimensions/bytes; a failed tile is not
completed merely because an output file exists.

New campaigns stamp `heightEncoding: "float32-metres-v1"` in settings, tile
metadata, raw/final raster sidecars and completion markers. Their finalizer
and exporter require matching stamps. Earlier campaigns truncated the model
to integer metres before writing Float32 files; casting those files again
cannot restore lost low-land and shallow-water signs. They remain readable
as legacy sources, but the corrected worker refuses to resume them, including
with `--force`. Save a new variant to generate corrected source. The raw
window/cache memory is twice its previous integer storage (four bytes per
sample); the cache retains the same sixteen-window bound.

Package format 1 quantized these heights to integer metres before building
its hierarchy. Format 2 builds from the Float32 source and adds centimetres
near sea level; see [export.md § Nodes](export.md#nodes).
Run `python scripts/check-terrain-precision.py`,
`bun scripts/check-terrain-campaign.mjs` and
`bun scripts/check-terrain-finalizer.mjs` for the producer and artifact contract.
In the terrain-diffusion Python environment,
`python scripts/check-terrain-worker.py` checks the real native worker, four
halos and the TIFF-to-raw preview round trip using an analytic world. It does
not load or run a learned model.

Fresh campaigns default to `--climate=seasonal`. The CPU solve and its
convergence checks finish before a terrain worker starts. `climate/` holds
the independent monthly artifact, and campaign settings, tile metadata and
completion markers carry its key. Both the face import and tile colour
conditioning use those physical fields. `--climate=preview` is an explicit
choice for a fresh campaign. On resume, a missing climate stamp means the
original preview recipe; changing mode or climate identity requires a new
variant. `--force` does not override that protection. `--dry-run` reports the
selected mode without preparing climate or writing campaign files.

`--seam=symmetric --blend-km=64` preserves immutable `raw.elev` face
planes with enough overlap on both sides of every fold. Generation's
`campaign-complete.json` marks this raw phase; it does not produce the
final square DEM or run legacy stitching. Then run
`bun scripts/blend-campaign.mjs --project=<project> --variant=<id>`.
The finalizer samples one normalized spherical blend, including all three
faces at a corner. Both sides read the same field, independently of bake
order. Its completion is `seam-complete.json`. This is a wider terrain
transition than the legacy first-baked-edge stitch; native DEM crops must
judge its landform character as well as the absence of a height step.
Named subsets can be finalized while generation continues, once all their
contributing raw sources are complete. Build studio previews afterwards.
For symmetric campaigns, the preview Gaussian reads a small spherical
halo from finalized neighboring tiles and the shared masked-ocean field.
It filters at true pixel centres, without flattening each tile's border.
The reduced raster retains two filtered neighboring pixels on each side
(`padPixels` in its sidecar). Shading uses that border; the overlay maps
only the interior onto the tile, so bilinear sampling can cross its edge.
`build:previews --tiles=<tile>,<tile>` rebuilds a selected subset for review.

`--fine-mask` (with `--seam=symmetric`) selects output windows **inside**
the existing bake tiles. `--mask-cells=2` uses two conditioning cells per
side, about 45 km on Quarter at level 3, without changing the native grain.
Selected windows form one global square partition per face, coalescing to
2×2, 4×4, or 8×8 cells where the mask permits. A query crossing a tile's
bounds stays square; only its copied output is clipped. Sixteen recent
query results are cached per face so adjacent tiles can reuse them. The
full 64-cell input context extends beyond the outermost query and fold
halo. Only requested fine output is sparse; decoder and parent-latent
context still costs compute.

Square queries also fix a measured window dependence in the sibling
model's postprocessing: `laplacian_denoise` passes the low-resolution width
as a scalar resize target, which resizes the shorter edge on a rectangle.
The same overlap in two rectangular requests differed by 2.56 m on average
and 217 m at worst in the coastal trial. Shared square queries reduced
that overlap difference to exactly zero. This is an orchestration fix;
the sibling model is neither copied nor modified here.

The mask protects sampled land and all positive saved-mesh vertices.
`--mask-buffer-km=46 --mask-fade-km=46` retain a coastal buffer and smoothly
fade the generated seabed into a shared coarse field farther offshore.
Conservative sampling and face-scale guards add margin. `--shelf-m=-200`
also retains shallow shelf. The output mask and fallback are saved in
`fine-mask.json` and `face-<face>-mask.json`; changing them requires a new
variant. Intentionally skipped tiles must use the same spherical fallback
via `scripts/campaign-fields.mjs`, rather than a separately warped sketch.
Expected but incomplete tiles must remain errors in downstream consumers.

Inspect a mask without starting a worker:

```sh
bun run bake:campaign --project=quarter --variant=<id> --level=3 --seam=symmetric --fine-mask --mask-preview=preview/mask.png
```

On Rill's current preflight recipe this requests 80,567 output cells versus
110,597 for the previous whole-tile mask: **27.2% less requested area**.
That is a planning comparison, not a measured wall-time speedup. Coastal
DEM and fold/corner capture checks precede the full campaign.

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

- **Seams — a corner is done; the rest of the sphere is not.** The three
  tiles at one cube corner were baked and read as a 3D box, and the cause
  was not the stitch: the equal-angle face square skews 30° at a corner, so
  the model's isotropic terrain arrived combed 60–120° differently on each
  face. The bake now runs on a conformal per-face plane and that corner
  draws as continuous ground. The whole argument, and the three pipeline
  bugs the first real bake exposed, are
  [cubesphere-seam-2026-09.md](../history/cubesphere-seam-2026-09.md).
  What is still open:
  - **Only one corner has been looked at**, on one variant, in the
    orthographic `bun run seam` capture. Not in the app on the globe, not
    at an edge midpoint (where scale is worst instead of skew), not at a
    polar fold, not on a second variant.
  - **A fold's two sides are still separate diffusions.** Their elevations
    agree; their terrain does not. The halo fade hides it over ~8 km and it
    did not read on this corner. `SEAM_HALO_CELLS`, or generating both
    sides of a fold in one pass, is the lever if it ever does. It *does*
    read on the quarter-radius bake: f0l3x0y3 | f3l3x7y3 stitched 321k
    edge pixels and the join is still visible as a change of terrain
    character, smooth on one side and dissected on the other. Level, not
    detail, is what the stitch fixes.
  - **Same-face joins were not seamless, and the reason was the import.**
    They are now, but not by construction. Baked and cropped for the first
    time on f0l4x1y8 | f0l4x1y9: the shared edge disagreed by **269 m mean,
    1351 m max**, against 9 m from one row to the next inside a tile, with
    the two edge profiles correlated at r = 0.88 — the same landforms, read
    off the same sketch, with independent detail on top.
    The cause is one import per tile. `set_custom_conditioning_import`
    calls `rebuild()`, which installs a fresh `MemoryTileStore`, so
    neighbours never share a parent latent no matter how well their
    lattices line up. Sharing the lattice is necessary and was never
    sufficient. Importing **once per face** and taking each tile as a
    window of it — [bake-campaign](../../scripts/bake-campaign.mjs), and
    what the plan below always said — brings the same pair to **1.7 m mean,
    37 m max**. `bun run bake:tiles` still imports per tile; it is a
    preview tool and a preview tile has no neighbour to disagree with.
  - The unmerged terrain-diffusion PR #15 "Sphere export" does cube-face
    sampling. It is prior art to read, not code to trust.
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
2. One face edge, then one corner, seam-blended and cropped. **One corner
   done** — `bun run bake:tiles <variant> <tile>...` bakes without a
   browser, `bun run seam` crops it. An edge midpoint and a polar fold are
   not done.
3. Cheap whole-planet pass: all six faces at 23 km conditioning, coarse
   model only. First look at the planet as a planet. A drainage graph
   on that pass would be a preview. Those rivers do not constrain the
   90 m pass.
4. Scale out to the 90 m bake. What the first whole-planet campaign cost
   and the six defects it exposed are
   [planet-bake-2026-09.md](../history/planet-bake-2026-09.md).
   **Masked to land and shelf** — `--mask`
   keeps every tile with a cell above sea level, grows that set by one
   tile in all eight directions, and fills single-tile holes. On the
   quarter-radius planet that is 250 of 384 tiles: a third of the sphere
   skipped, about an hour off a 3.3 h bake, and no tile carrying land
   dropped (asserted, not assumed). The growth is what makes it safe to
   look at — a tile that merely contains land still ends at a tile edge,
   so without a ring the DEM would stop within 313 km of a shore.
   `--mask-preview` draws the mask over the project's equirect, which is
   how it should be judged: red must never touch a coast. Skipped tiles
   have **no DEM at all**, so anything downstream needs the coarse sketch
   as its fallback there — a gap, not a coarser level. Then hand off to
   Carve. `bun run bake:campaign` walks a whole level face by face —
   one conditioning import per face, a window per tile, resumable, and it
   checks each tile's baked land fraction against the sketch's so a bake
    that stops reading its conditioning stops the run instead of filling a
    night. It wants the WSL2 worker ([wsl-bake-env](../ref/wsl-bake-env.md));
    the first planet through it is the quarter-radius body, 384 tiles at
    level 3, ~30 s a tile.
5. Preflight before the next night. `--tiles=` bakes a named set through the
   same face-import path as the campaign, so prove a region before
   committing the night: a **2×2 block over land** (same-face joins) and a
   **pair across a fold** (character join), each cropped with `bun run seam`
   and looked at. Both took three minutes on the first planet and both found
   something. Do not start a full campaign without them.
6. Trial: **16 cells per tile, not 14.** A tile is then 4096 px, a package
   node is 512, and the node grid aligns with tile boundaries with no
   resample anywhere. `SCALE_KM` is the model's grain and does not move, so
   this means choosing the campaign level whose `tileCells` lands on 16 for
   the target body — one trial bake decides it, not arithmetic.

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
