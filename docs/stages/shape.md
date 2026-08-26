# Shape

Second stage. **Open. The three steps below shipped and still look wrong
in places.**

## What it does

Takes Layout's coarse planet up to the terrain model's grain and writes
the **sketch**: coasts, island bodies, belt grain, drainage texture.
Explicit, cached on the variant it ran on — not a generate flag.

Grain is **23 km/px**, set by what terrain-diffusion's 90 m model reads
as one conditioning cell. Cell count is derived from radius:
`N ≈ π (2r / spacingKm)²` — ~240k cells on Thalos, ~1M on Earth. Shape
always lands on the model's grain independent of planet size. If the
terrain model later wants a different grain, change the shipped spacing.

A feature here is **at least two cells**. One-cell cones are dropped;
they wait for [Carve](carve-landforms.md).

Mechanism in `src/detail.js` and `src/erosion.js`; the cached artifact in
`src/shape-artifact.js`.

## Reads

Everything in [Layout's contract](layout.md#hands-on), sampled onto the
finer mesh. Specifically:

| From Layout | What Shape does with it |
| --- | --- |
| `meters` | the height it warps — sampled *before* `metersToElevation`, so it stays physical |
| `r_orogeny` + `r_orogenyDir` | phasor ridge amplitude and strike |
| `r_arc`, `r_arcPeak`, `r_arcAge`, `r_arcDir` | island crests; old/weak ribbons from peak+age, oriented by dir |
| `r_hotspot`, `r_hotspotPeak`, `r_hotspotAge` | young islands from present, drowned tracks from peak+age |
| `r_crust_type`, `r_crust_age`, `r_boundary`, `r_plate` | sampled **without** the warp, so a trench can still be judged against its arc |
| `r_moisture`, `r_temperature` | where ice belongs, for glacial erosion |

**Wishes** — what Shape would use if Layout emitted it. Promote a line
here into a row in [Layout § Hands on](layout.md#hands-on) when it is
built, do not leave it in both places.

- Nothing outstanding. The last one granted was the peak/age/strike
  triples, which is what made extinct arcs and old hotspot tracks
  shapeable at all. Iceland plateaus and drowned-margin islands are being
  derived from the existing fields plus crust and the live boundary;
  **no fifth Layout field until a picture fails.**

## Hands on

The **sketch**: height plus the story maps, cached on the variant.
`src/shape-artifact.js` is the encode, and this is its field list.

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

**The sketch is not height alone.** Finish still needs the story maps —
Carve stamps below this grain have nowhere to go without them. A doc or a
cache that keeps height and climate only is broken.

### What Terrain wants from this

Shape's real output target is a sketch terrain-diffusion can eat. Written
from the model's side in [ref/terrain-diffusion.md](../ref/terrain-diffusion.md);
the part that constrains Shape:

- Continent-scale land vs ocean, sea at 0 m, irregular coasts that came
  from the elevation blend crossing sea level.
- Mixed land and water **inside** a plate.
- Broad belts and plateaus as **smooth ramps**, hundreds of km across —
  not a blocky slot. The model heals one-cell anomalies and will "correct"
  shapes it does not believe.
- A real **base-level drop** where you want dissection: high land next to
  a low basin, shelf or trench, kilometres of relief across the window.
- Not a pancake. On a low-relief coast test the model **ate land** —
  fraction dropped ~55% → 34%.

## Must not regress

- **A body is at least two cells.** Isolated 1-cell cones, atolls, reefs,
  islets and real fjords are not Shape's job. Dropping them here is
  deliberate, not an oversight.
- **Do not finish coasts, river valleys or eroded slopes.** The sketch
  stays a sketch; terrain-diffusion redraws local shape anyway. Erosion
  here is texture so the model sees valleys, not a drainage network.
- **Do not carve on Layout's ~113–226 km mesh.** Valleys would be
  hundreds of kilometres wide.
- **Keep the largest warp amplitude below craton scale.** Past that the
  warp dissolves the global layout, which is the part we are good at.
- **Do not flatten ocean basins or floor continental plates** before
  export. Coasts come from the elevation blend crossing sea level; a crust
  mask or land floor makes coasts snap to plate edges and the diffusion
  model inherits that lie.
- **No Shape search sheet.** Sixteen thumbnails would not show the grain
  you are judging and would be too slow. Iterate on the globe.
- Smoothing radii, coast blend and noise frequencies stay expressed in
  **kilometres** derived from mesh spacing, so both meshes agree.

## How it works today

Three steps, in this order, on a second mesh built from the same sphere
routine as the sim:

**A — detail mesh, warp, island crests.** Sample Layout's `meters` onto
the finer mesh, then displace each cell's *sample point* in the tangent
plane by multi-octave FBM before the lookup. Warping the lookup rather
than adding height is the specific thing that produces embayments, capes
and peninsulas instead of a bumpy fringe. Amplitude is scale-graded: a
low-frequency component that swings whole capes down to a fine one that
frays the shore, ±0.13 rad max (~830 km at strength 1). A higher-frequency
fractal roughens only within a band of the shoreline, so interiors do not
get noisy for free. Island crests run *after* the warp against the
transferred `r_arc` / `r_hotspot`, which is what turns one 226 km blob per
island into a believable chain.

**C — oriented ridges.** A belt used to be `orogenyReliefM * r_orogeny` —
a smooth dome with no strike and no grain. Now: sum directional Gabor
kernels along the belt, each a complex exponential under a Gaussian
envelope, and take `atan2(Σsin, Σcos)` per cell for a sawtooth ridge
field, biased positive for thrust-like asymmetry and phase-warped so
ridgelines meander instead of tracing clean small-circles. 4000 kernels,
55 km wavelength, 180 km envelope.

Kernels are oriented from `r_orogenyDir` — the **real** convergence
direction recorded at collision time. World Orogen infers an
instantaneous stress field because it never integrates motion; we have
the actual kinematics, and this is where that pays.

**E — first-stage erosion.** Priority-flood so every land cell drains to
the sea, a few iterations of stream-power incision, talus/thermal
diffusion, soil creep. Latitude- and elevation-gated ice flow on top,
which is where drowned glaciated coasts come from. Detail noise is
modulated per cell so quiet cratons stay subdued and active belts read
rough.

Erosion is O(iterations × cells) with a sort per iteration, so at ~1M
cells it is the most expensive thing in the generator. Bake-time cost,
not interactive.

Shape reuses the variant's layout: plates and `climate.js` do **not**
rerun when you Shape, shuffle the shape seed, or move a shape gene.

The full reasoning for choosing these three, and what was rejected, is in
[history/shape-detail-pass-2026-08.md](../history/shape-detail-pass-2026-08.md).

## Open

Shape claims 23 km and does not yet deliver all of it. Missing or wrong
at this grain:

- young hotspot islands
- old / weak arc ribbons (Curaçao class)
- plume-on-ridge plateaus (Iceland)
- the forearc trough
- drowned-margin islands
- ria inlets
- fracture-zone scars

**Not** Shape's list, do not add them here: abyssal hills, a second
continental-shelf pass, large lakes, rift grabens.

- **Fjords are a grain problem.** The erosion pass drowns glaciated
  high-latitude coasts, but a cell is ~23 km and a real fjord is 1–6 km
  across. What you get is one drowned cell, not a Norway coast. Real
  fjords wait for [Carve](carve-landforms.md).
- **Authored editing** — raising land, draining basins, hand edits to a
  generated sketch. Implementation open. [World
  Orogen](https://orogen.studio) already does this; read that codebase
  when we get to it. Same planet; Save is a new snapshot.

## How to judge it

The sketch is what the terrain model eats, so judge the **heightmap**,
not the biome colours.

```sh
bun run preview relief    # hypsometric tint + hillshade — belts and basin shape
bun run preview           # globe + equirect
bun run crop preview/thalos/equirect.png --x=800 --y=200 --w=600 --h=400
```

Read `bun run preview crust` after any change to the warp or the ridges —
a warp large enough to be interesting can shear the tectonic story, and
the geography views hide a trench that slid off its arc.

Surface biomes hide elevation; `relief` does not. Crop in rather than
guessing from a thumbnail.
