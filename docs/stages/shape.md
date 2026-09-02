# Shape

## What it does

Shape takes Layout's coarse planet up to the terrain model's grain and
writes the **sketch**: coasts, island bodies, belt grain, drainage
texture. The pass is explicit. The result is cached on the variant it
ran on. It is not a generate flag.

Grain is **23 km/px**. That is the size of one conditioning cell for
terrain-diffusion's 90 m model. Cell count is derived from radius:
`N ≈ π (2r / spacingKm)²` — ~240k cells on Thalos, ~1M on Earth. Shape
always lands on the model's grain, independent of planet size. If the
terrain model later wants a different grain, change the shipped spacing.

A feature here is **at least two cells**. One-cell cones are dropped.
They wait for [Carve](carve-landforms.md).

Mechanism in `src/detail.js` and `src/erosion.js`. The cached artifact is
in `src/shape-artifact.js`.

## Reads

Everything in [Layout's contract](layout.md#hands-on), sampled onto the
finer mesh. Specifically:

| From Layout | What Shape does with it |
| --- | --- |
| `meters` | the height it warps — sampled *before* `metersToElevation`, so it stays physical |
| `r_orogeny` + `r_orogenyDir` | phasor ridge amplitude and strike |
| `r_arc`, `r_arcPeak`, `r_arcAge`, `r_arcDir` | island crests. Old/weak ribbons from peak+age, oriented by dir |
| `r_hotspot`, `r_hotspotPeak`, `r_hotspotAge` | young islands from present, drowned tracks from peak+age |
| `r_crust_type`, `r_crust_age`, `r_boundary`, `r_plate` | sampled **without** the warp, so a trench can still be judged against its arc |
| `r_moisture`, `r_temperature` | where ice belongs, for glacial erosion |

**Wishes** — what Shape would use if Layout emitted it. If a line here is
built, promote it to a row in [Layout § Hands on](layout.md#hands-on).
Do not leave it in both places.

- Nothing outstanding. The last granted wish was the peak/age/strike
  triples. Those triples made extinct arcs and old hotspot tracks
  shapeable. Iceland plateaus and drowned-margin islands are derived from
  the existing fields plus crust and the live boundary. **Do not add a
  fifth Layout field until a picture fails.**

## Hands on

The **sketch**: height plus the story maps, cached on the variant.
`src/shape-artifact.js` is the encode. This is its field list.

| Field | Type | Meaning |
| --- | --- | --- |
| `r_meters` | f32 | the sketch height, warped, ridged and eroded. Physical metres |
| `r_elevation` | f32 | the same after `metersToElevation`, for the renderer |
| `r_moisture`, `r_temperature` | f32 | climate sampled onto this mesh |
| `r_arc`, `r_arcPeak`, `r_arcAge` | f32 | carried through, at 23 km |
| `r_hotspot`, `r_hotspotPeak`, `r_hotspotAge` | f32 | carried through |
| `r_orogeny`, `r_crust_age` | f32 | carried through |
| `r_orogenyDir`, `r_arcDir` | packed3 | carried through |
| `r_crust_type`, `r_boundary` | u8 | carried through |
| `r_plate` | i32 | carried through |

**The sketch is not height alone.** Finish still needs the story maps.
Carve stamps below this grain have nowhere to go without them. A doc or
a cache that keeps height and climate only is broken.

A new optional field still loads. A file this generator cannot apply
stays on disk. **Regenerate** writes a current sketch in its place.
Bump `SCHEMA` in `src/shape-artifact.js` when the contract changes.
Do not bump it when the sketch pass changes.

### What Terrain wants from this

Shape's output target is a sketch that terrain-diffusion can use. Written
from the model's side in [ref/terrain-diffusion.md](../ref/terrain-diffusion.md).
The part that constrains Shape:

- Continent-scale land vs ocean, sea at 0 m, irregular coasts that came
  from the elevation blend crossing sea level.
- Mixed land and water **inside** a plate.
- Broad belts and plateaus as **smooth ramps**, hundreds of km across,
  not a blocky slot. The model heals one-cell anomalies. It will
  "correct" shapes it does not believe.
- A real **base-level drop** where you want dissection: high land next to
  a low basin, shelf or trench, kilometres of relief across the window.
- Not a pancake. On a low-relief coast test the model **ate land** —
  fraction dropped ~55% → 34%.

## Must not regress

- **A body is at least two cells.** Isolated 1-cell cones, atolls, reefs,
  islets and real fjords are not Shape's job. Dropping them here is
  intended.
- **Do not raise a feature list into `r_meters`.** Discrete edifices
  too small for a cell stay a list. If they enter height,
  terrain-diffusion heals the cones and Carve has nothing to stamp.
- **Do not finish coasts, river valleys or eroded slopes.** The sketch
  stays a sketch. Terrain-diffusion redraws local shape anyway. Erosion
  here is texture so the model sees valleys. It is not a drainage
  network.
- **Do not carve on Layout's ~113–226 km mesh.** Valleys would be
  hundreds of kilometres wide.
- **Keep the largest warp amplitude below craton scale.** Past that, the
  warp dissolves the global layout.
- **Do not flatten ocean basins or floor continental plates** before
  export. Coasts come from the elevation blend crossing sea level. A
  crust mask or land floor makes coasts snap to plate edges. Then the
  diffusion model inherits that lie.
- **No Shape search sheet.** Sixteen thumbnails would not show the grain
  you are judging. Sixteen sketches would be too slow. Iterate on the
  globe.
- Smoothing radii, coast blend and noise frequencies stay expressed in
  **kilometres** derived from mesh spacing, so both meshes agree.

## How it works today

Three steps plus coastal water, in this order, on a second mesh built
from the same sphere routine as the sim:

**A — detail mesh, warp, island crests.** Sample Layout's `meters` onto
the finer mesh. Then displace each cell's *sample point* in the tangent
plane by multi-octave FBM before the lookup. Warp of the lookup, rather
than added height, produces embayments, capes and peninsulas instead of
a bumpy fringe. Amplitude is scale-graded. A low-frequency component
swings whole capes. A fine component frays the shore. Max is ±0.13 rad
(~830 km at strength 1). A higher-frequency fractal roughens only
within a band of the shoreline, so interiors do not get noisy for free. Island crests run *after* the warp against the
transferred `r_arc` / `r_hotspot`. That is what turns one 226 km blob per
island into a chain.

**B — coastal water.** Warp will not open a Channel or raise Britain.
`warpCoastKeep` damps every land/ocean swap so an 800 km lookup cannot
close the Med, and also cannot cut a 1-cell gap. This step is the
asymmetric rule: do not fill a basin; do raise 2-cell bodies on shallow
drowned continental crust; do drown a short, low neck that already
separates an inland sea from the world ocean. A mountain isthmus stays.
A cut that would split two large land pieces stays. Layout still owns
the hole itself.

**C — oriented ridges.** A belt used to be `orogenyReliefM * r_orogeny`
— a smooth dome with no strike and no grain. The current method sums
directional Gabor kernels along the belt. Each kernel is a complex
exponential under a Gaussian envelope. The method takes
`atan2(Σsin, Σcos)` per cell for a sawtooth ridge field. The field is
biased positive for thrust-like asymmetry and phase-warped so ridgelines
meander instead of tracing clean small-circles. 4000 kernels, 55 km
wavelength, 180 km envelope.

Kernels are oriented from `r_orogenyDir` — the **real** convergence
direction recorded at collision time. World Orogen infers an
instantaneous stress field because it never integrates motion. This
model has the actual kinematics.

**E — first-stage erosion.** Priority-flood so every land cell drains to
the sea, a few iterations of stream-power incision, talus/thermal
diffusion, soil creep. Latitude- and elevation-gated ice flow on top.
That ice flow is where drowned glaciated coasts come from. Detail noise
is modulated per cell so quiet cratons stay subdued and active belts
read rough.

Erosion is O(iterations × cells) with a sort per iteration. At ~1M cells
it is the most expensive step in the generator. Bake-time cost, not
interactive.

Shape reuses the variant's layout. Plates and `climate.js` do **not**
rerun when you Shape, shuffle the shape seed, or move a shape gene.

The full reasoning for choosing these three steps, and what was rejected,
is in [history/shape-detail-pass-2026-08.md](../history/shape-detail-pass-2026-08.md).

## Open

Shape claims 23 km and does not yet deliver all of it. Missing or wrong
at this grain:

- young hotspot islands
- old / weak arc ribbons (Curaçao class)
- plume-on-ridge plateaus (Iceland)
- the forearc trough
- ria inlets
- fracture-zone scars
- island-arc chains that sit in the water, not on the continent (Japan,
  Antilles)

**Layout owns the basin. Shape owns the shore.** An enclosed sea is a
Layout hole (`planCuts` / authored basins). On Earth, 2026-08-27, the
west Med box (`lon -8..0`, `lat 34..38`) had zero water at Layout: Europe
and Africa meet as land, 126 km apart, then as 2–4 km of collision belt
after Shape. `planCuts` opens a second-join sea at `0.14 rad` (about
900 km on Earth). That is a gulf. A thin strait (Gibraltar / Dover
class, 1–2 cells at 23 km) belongs here. Real Gibraltar is 14 km. That
last pinch waits for [Carve](carve-landforms.md).

**Coastal water — in trial.** First raise (2026-08-27, Earth, no
erosion) took land bodies 49 → 1075, a necklace of 2–40 cell islands on
every coast, and split the Americas into two ~37k-cell pieces. Tightened
to: only raise drowned shelf that does not touch existing land, bodies
of at least four cells, and refuse a strait that increases the number of
large land masses. Judge on Earth: Britain crop, Aegean crop, Panama
still an isthmus, Drake still open. Pass: offshore 2-cell+ bodies on the
shelf without a speckle fringe; Americas one piece. Britain as a calf
still needs a Channel cut. That is a later trial. Fail: speckle returns,
or the Med or Drake closes.

Do not drop `warpCoastKeep` to get this. That closed the Med.

**Not** Shape's 23 km list. Do not add them here: abyssal hills, a
second continental-shelf pass, large lakes, rift grabens.

**Feature list — open.** Most islands are smaller than 23 km. Shape
would write every edifice the peak / age maps imply: hotspot volcanoes,
arc volcanoes, reef platforms, seamounts. Kind, age, trail. Carve
stamps would read it. A later Terrain would dress it. See
[custom-model.md](../custom-model.md). The row schema is not chosen.
Height still drops one-cell cones. Do not grant this as a fifth Layout
field. Layout already has the triples.

- **Fjords are a grain problem.** The erosion pass drowns glaciated
  high-latitude coasts. A cell is ~23 km. A real fjord is 1–6 km across.
  What you get is one drowned cell, not a Norway coast. Real fjords wait
  for [Carve](carve-landforms.md).
- **Authored editing** — raising land, draining basins, hand edits to a
  generated sketch. Implementation open. [World
  Orogen](https://orogen.studio) already does this. Read that codebase
  when we get to it. Same planet. Save is a new snapshot.
- **Supersample the DualMesh into the 23 km TIFF — recommended, not
  tried.** The 90 m model still reads one pixel per 23 km cell. A denser
  TIFF would mis-scale the prior. A finer Shape mesh, rasterized onto
  that same 23 km grid, might anti-alias coasts and ramps. The
  conditioning would be less Voronoi-blocky. Sub-23 km landforms would
  still average out. They are not the target. **The trial:** keep
  `SCALE_KM = 23`. Run Shape at a modestly smaller `shapeSpacingKm`
  (try ~12 km, about 4× the cells). Rasterize the same tile. Compare the
  conditioning heightmap, then one preview bake. Pass: the 23 km sketch
  and the bake read cleaner at coasts and belts, without new one-cell
  cones the model then heals. Fail: the bake matches 23 km Shape, or
  warp and erosion at the finer N alias into speckle. Do not ship a new
  spacing until a picture picks one.

## How to judge it

The sketch is what the terrain model reads. Judge the **heightmap**, not
the biome colours.

```sh
bun run preview relief    # hypsometric tint + hillshade — belts and basin shape
bun run preview --earth   # Earth fixture: coasts and shelf islands
bun run preview           # globe + equirect
bun run crop preview/thalos/equirect.png --x=800 --y=200 --w=600 --h=400
```

After any change to the warp or the ridges, read `bun run preview crust`.
A warp that is large enough to be interesting can shear the tectonic
story. The geography views hide a trench that slid off its arc.

Surface biomes hide elevation. `relief` does not. Crop in rather than
guessing from a thumbnail.
