# Layout

## What it does

Layout simulates plate tectonics on a sphere of about 10k cells. It
hands on plate locations, continent locations, crust type and age, and
200 Myr of history for how that crust formed. `climate.js` runs on the
result. See [climate.md](climate.md).

Grain is ~113 km per cell on Thalos, and ~226 km on Earth, at
`N = 10000`. That grain is coarse. Raising `N` does not make the planet
finer. It makes the planet worse. See
[§ Must not regress](#must-not-regress).

The model lives in `src/tectonics.js`. It has no WebGL and no DOM.
Captures and the headless helpers share this model.

## Reads

Layout is first. It reads from the studio, not from a stage.

| Input | From | Used for |
| --- | --- | --- |
| **body** — radius, gravity, day, tilt, age, water | the variant | every derivation is a ratio against Earth, exactly 1 at Earth's defaults |
| **layout seed** | the variant | plates, continents, crust. Shuffle → a *different planet* |
| **layout genes** — `plates`, `steps`, `cratons`, `continentFraction`, `hotspots`, … | the variant's ranges | what kind of planet within that body |

`world.js` holds the body and its derivations. It is separate from the
model parameters because all three models read it. `params.js` is the
registry of every parameter with its unit and range. It validates
project files. If a knob is added without being registered, it throws.

**Wishes** — nothing upstream to ask. Layout needs a better model. See
[§ Open](#open).

## Hands on

Shape samples these fields onto its mesh with the same `sampleWeights` /
`sampleField` interpolation that crust advection uses. This table is the
contract. A new field means a new row.

| Field | Type | Meaning | Consumed by |
| --- | --- | --- | --- |
| `meters` | f32 | elevation in physical metres, before `metersToElevation` | Shape (warps it), everything downstream |
| `r_crust_type` | u8 | continental or oceanic | Shape, Terrain conditioning |
| `r_crust_age` | f32 | sea-floor age, Myr | Shape. Ocean depth via half-space cooling |
| `r_thickness` | f32 | crustal thickness, km | land height via isostasy |
| `r_plate` | i32 | owning plate id, stable across rifts | Shape, plate captures |
| `r_boundary` | u8 | convergent / divergent / transform | Shape (belt grain), Carve later |
| `r_orogeny` | f32 | present belt strength | Shape (ridge amplitude) |
| `r_orogenyDir` | packed3 | strike, from real convergence at collision time | Shape (phasor ridge orientation) |
| `r_arc` | f32 | present arc strength | Shape (island crests) |
| `r_arcPeak` | f32 | strongest this cell ever was | Shape (old/weak arc ribbons) |
| `r_arcAge` | f32 | Myr since last refresh | Shape (extinct arcs still on the map) |
| `r_arcDir` | packed3 | arc strike | Shape (ribbon orientation) |
| `r_hotspot` | f32 | present plume strength | Shape (young hotspot islands) |
| `r_hotspotPeak` | f32 | strongest this cell ever was | Shape (old tracks) |
| `r_hotspotAge` | f32 | Myr since last refresh | Shape (drowned seamount chains) |

The peak/age/strike triples are required. Present strength alone is not
enough. An extinct arc and an old hotspot track must still be on the map
after the volcanoes stop. If they are not, Shape has nowhere to put
Curaçao and the Emperor seamounts. Layout hands on compact **maps**, not
a step log. It does not hand on a history of events. It hands on the
present state of four things, plus how long ago each was last refreshed.

Shape derives Iceland-style plume-on-ridge plateaus and drowned-margin
islands from these fields plus crust, elevation, and the live boundary.
Do not add a fifth field until a picture fails.

Save writes these maps, plus `r_elevation`, `r_moisture`,
`r_temperature`, and the plate records, to `layout.json` on that
snapshot. `r_meters` is the `meters` row. Opening the variant loads
that file. It does not rerun the simulation. A new optional field
still loads: the old maps stay, the new one is empty. A file this
generator cannot apply (required field gone, or a newer schema) stays
on disk. It is not overwritten. **Regenerate** writes a current file
in its place. Same seed, same genes. It does not write a new
snapshot. A snapshot with no file generates once and then keeps that
result. `src/layout-artifact.js` is the encode. Bump `SCHEMA` there
when the contract changes. Do not bump it when the sim changes.

## Must not regress

**Coasts come from interpolation over a continuous field, never from
plate outlines.** The generator once grew land as blobs that filled a
plate. Then coastlines traced plate boundaries. Today the coastline is
the sea-level contour of a continuous elevation field. That field is
built from crustal thickness and sea-floor age, then relaxed across the
margin (`coastBlend`). Crust type is seeded from cratons placed
independently of the plate partition. As a result, a plate can carry a
continent and an ocean at once. The one place a plate does shape a
coast is a marginal sea: a small plate under extension has its crust
thinned by hops in from its edge, so the shoreline is still a contour
of a continuous field, a cell or two inside the boundary, and the arc
on its trench side is the boundary itself, as the Antilles are.

Do not:

- Grow continents as blobs on plates. Do not derive crust type from
  plate id.
- Threshold a noise field for crust type. At the ~40% coverage that
  continental crust needs, a thresholded isotropic field sits at the
  percolation threshold. That produces stringy maze-like land spread
  evenly over the sphere. No seed escapes it. This was measured.
- Floor continental plates or flatten ocean basins to a constant depth.
- Move a coast by rewriting plate ownership or a crust mask. Sculpt
  writes the metres field. The coastline is still the sea-level contour.
- Call `Math.max(elevation, …)` on a plate or a cell.
- Widen `coastBlend`. A wide blend averages a margin against the abyssal
  plain and drowns it.
- Bring back a radial dome from core to coast. Elevation is not a
  function of distance to the coastline. The dome made every continent
  shade like a blob. Relief on land belongs to orogeny and sutures.
- Adjust per-nucleus scales to hit plate areas. The method does not
  converge. Area is a steep function of the ratio between neighbouring
  scales, so the correction overshoots. On one seed the worst error grew
  2.0 → 4.6 while a single plate swelled from 131 sites to 340.
- Raise `N` to get detail. Tried at 10k / 60k / 150k on seed 42: land
  thins, continents wash out, arcs break into speckle. Smoothing is
  counted in cell hops, not kilometres (`coastBlend`, `healPasses`,
  `crustSmoothing`). Noise frequencies are fixed in world space.
  `speckCells` / `minFragment` / `plateRetireArea` are tuned against 10k.
  Resolution is decoupled instead. That is what Shape does.
- Copy a continental column into a divergent cell. On seeds 1–12 that
  cloned crust (some seeds 47% → 69%) and raised land-body count from
  ~3 to ~28. The birth plan is stamped back each step instead.
- Grow continent blocks away from the mass as a chain. That walk made
  sausages. Extra pieces hang off the shield. A satellite is one
  offshore fragment, not a chain.
- Seed the plates blind. The partition is fitted to the still: a major
  on each big continent, a toll on crossing a coast, minors born in the
  ocean, continental plates slowed. Unfitted, boundaries wandered
  through shields, the run's belts landed in interiors, and the story
  had to be composed from distance to the shoreline instead.
- Paint a belt by distance from the shoreline. A belt is placed by a
  boundary and sized by its closing speed. The coast-offset profile made
  every continent a flat plate with one raised rim, the same on every
  seed, and no plateau, rift, or interior range could exist.
- Let a belt shape run past a few cells. The first boundary-placed
  pass used collision widths up to twelve cells and a crest of 1.3.
  Every continent went white. The Andes are two to four cells at this
  grain; Tibet is six to eight.

**Per-cell fields belong to their mesh and their crust.** `boundaryWarp`
and the crust arrays are one value per cell. `simulateTectonics` rebuilds
the warp on every run, from this mesh and this birth crust, and never
reuses one from a previous run. A field from a previous mesh indexed
with this one reads undefined and hands NaN weights to the ownership
pass. The planet collapses to two or three plates. The browser used to
hit that after a mesh-size change. A field from a previous crust tolls
the wrong coasts.

## How it works today

**1. Plate geometry.** A plate is a rigid body made of *sites* — points
that rotate with it. A cell belongs to whichever site is nearest. A
boundary falls where two plates' nearest sites tie: a great-circle arc.
Where three meet, there is a triple junction. Several sites per plate,
rather than one, keep shapes from being convex caps.

Ownership is grown outwards from the sites with a weighted Dijkstra. It
is not grown by testing every cell against every site. That choice
matters. The all-pairs cost caps how many sites a plate can have. That
cap broke the size hierarchy: the smallest plates in a heavy-tailed
distribution want less than one site each and end up with none. Sites
are handed to plates by a **capacity-constrained assignment** — nearest
pairs first, each plate taking exactly its quota.

**The partition is fitted to the still.** The birth crust is planned
first (`planCrust`) and handed to `generatePlates`. Each birth continent
above `continentPlateMin` gets a major nucleus at its centre and the
largest share, largest continent first. At least one major stays
oceanic, two when there are four or more, so the empty ocean has a
ridge of its own. A site on the other crust type pays `siteToll` to join
a nucleus, so a continent's sites stay with the plate that carries it.
In the ownership Dijkstra a step across a coast costs `marginToll` times
a step over ocean or interior, so a front arriving from the ocean stops
at the shore instead of pushing through the shield. A plate whose sites
mostly stand on continent turns at `continentalDrag` of a normal plate,
and a plate born from it inherits that: the still does not move, and a
plate that turned 70° over the run would leave its continent behind.
The Earth fixture builds its plates from Bird 2003 outlines and skips
all of this.

**Majors and minors are not seeded alike.** The majors tile the sphere
between them. The minors are then carved out of the boundaries between
majors. Each minor is born at the midpoint of a tight cross-plate site
pair. It prefers oceanic pairs, then margins where the majors converge,
and takes land sites last: Cocos, Juan de Fuca, Scotia and the
Philippine Sea are oceanic, and a minor carved out of a shield is a
boundary through it. Its sites are gathered with a stretch along the
boundary (`microplateElongation`). The result is a sliver hugging the
margin, the way the Caribbean, Cocos and Scotia do. If every plate is seeded from a free-standing nucleus
instead, minors drop into the middle of majors. There they sit as
single-neighbour enclaves. Earth has no enclave plates. This model has
none either: `absorbEnclaves` hands any plate whose whole edge touches
one neighbour back to that neighbour, at birth and every step. A leftover
enclave shows up on the plate capture as a single-neighbour island of
colour. Minors also spin faster than majors (`microplateSpin`), as
Earth's do.

**Subduction acts on the plates themselves.** Sites used to be immortal.
A converging plate's sites marched through whatever stood in the way. A
microplate in a closing vice was overrun in a few steps. The census fell
from ~20 to ~9, with nothing small left. Now a site standing on another
plate's ground at a converging margin is slab. Density decides which
side sinks: ocean under continent, older floor under younger. Continents
never sink. They collide, which is what a collision belt needs. The
verdict is decided by majority along the whole shared margin, not site
by site. A per-site verdict flip-flops along a patchy coast and shreds
the front. The overriding side's site retreats onto its own ground
instead. The trench stays pinned to the plate that owns it. Every
consumed site is handed back as a new site on a spreading margin,
weighted by the *share* of each plate's boundary that is divergent.
Never weight by raw ridge length. Raw ridge length is the same
rich-get-richer term that once let one plate eat the map. Trenches also
calve back-arc microplates (`spawnBackArcPlate`, the Philippine Sea
story) whenever the census is below the plate count asked for.
`sitesPerPlate` doubles as the grain of trench erosion. Too few sites
and the eaten front looks chewed. Around 40, the trench stays a line on
any mesh size.

**2. Motion.** Rigid rotation about an Euler pole, `omega x r`, in a
no-net-rotation frame. A single constant vector per plate is tangent at
one point only. On 20 plates it puts >30% of the velocity into the
radial direction across a third of the surface. Boundaries are
classified convergent / divergent / transform from relative velocity
against the boundary normal.

Plates grow at their ridges and shrink at their trenches, measured as a
share of the plate's *own* boundary. Counting raw cells makes the term
scale with plate size. Then the biggest plate has the longest ridges,
gains most, and grows until it owns the map. The reversion term must
stay stronger than the growth term, or there is no equilibrium at all.

**3. Continents.** A handful, unequal in size, and biased to cluster
into one hemisphere. That cluster leaves a Pacific-sized ocean opposite.
Each continent is a composed still (`planBlocks`): a dominant shield,
then whatever extras the roll picked — a lobe, a hooked peninsula, a
sliver, satellites. Facets are the default margin. Noise (`cratonWarp`,
`gulfCut`) only textures. Huddled continents that almost touch get a
join cut (`planCuts`): a thin isthmus with islands on the open side, an
enclosed sea with a sliver into it, or the gap left as a seaway. Large
shields may also take an ocean-facing gulf. A weld can carry an old
belt. A global bisection rescales the plan to the target continental
area. The Earth fixture authors its blocks and basins directly and
zeroes `sutures`.

Below the cuts the margin carries a **cell octave** (`coastOctave`):
two octaves of noise at four and two cells, added to the distance
field from the shoreline out to the rim, in radians so an island gets
the same headlands as a shield. It makes coves, headlands and the odd
shelf island. It is additive on a smooth field, so it cannot string a
coast out. `shelfVary` swings the shelf width by region, one margin
drowned wide and another a cliff. The silhouettes stay the still's.

The run does not redraw those coasts. Matching coasts from a rift are
a later trial.

Interiors start *flat*: a coastal plain climbs to a platform at
`crustReferenceKm` (~650 m via isostasy). Relief on land is the
composed belts, not a dome from core to coast. After the belts are
painted, a load pass thins the column inland of the orogen: a
foredeep next to the chain, then a decay with hops from the belt so
a large shield is a gradient, not a second table. A large mass with
no active margin still gets a worn orogen on its most open coast.

**4. Simulation.** The crust is the state: type, age, thickness, orogeny,
arc. Each step the plates turn, ownership is rebuilt from the sites, and
the crust is advected by back-rotation of each cell along its owning
plate.

What happens to the crust keys off **what the boundary is doing, never
off whether a cell changed hands**. Ownership is also renumbered when
plates split, weld, or absorb a scrap. If that bookkeeping is read as
subduction, the continents shred. After each step the birth continent
plan is stamped back: type and thickness on cells that were continental
at birth. The run still paints sea-floor age. It does not grow, eat, or
smear coasts. Thinning a continental cell by a *fraction* of its
thickness each step it touches a rift also fails: half the continental
crust ends up too deep to be land.

After the run, `composeTectonicStory` replaces land orogeny and ocean
arcs. The run's own orogeny accumulated wherever a boundary swept,
which is a smear, not a belt. The story is authored shapes placed by
the boundaries the run ended with. Every coast within two cells of a
boundary on its own plate's edge is a **margin**: convergent facing
ocean is *active*, convergent facing a mass of another plate's land is
a *collision*, divergent is *rifted*, strike-slip is *transform*. A
boundary through land is the axis of the same kinds. Nothing within
reach is a *passive* margin. Each margin gets one strength: the mean
closing speed along that stretch against the typical plate speed.

Before any belt, **marginal seas**: a plate of 20 cells to 6% of the
sphere, mostly land, touching two or more plates and the ocean, either
born as a back-arc sliver or with at least 45% of its edge divergent or
transform, is drowned. Landlocked ones are left alone: drowned, they
were the round interior ponds this stage already calls a fail. Its
crust thins with hops in from its edge, to about 1.6 km below sea
level in the middle. Its own coastline at birth, the rim that faced
water, becomes young oceanic arc crust carrying a full-strength arc: a
slow noise along it leaves runs of islands and straits between them,
so the sea opens to the ocean through the arc. Put on the landward
edge, the arc fused into a peninsula; as a continental ribbon one cell
wide it was averaged into the basin and never surfaced. That is the
Sea of Japan behind Japan and the Caribbean inside the Antilles. A
small plate under compression stays land and gets belts instead, as
Anatolia does.
Land, for everything after this, is continental crust standing above
sea level, not the shelf and not a drowned basin.

The shapes, in cells from the seed: an active margin is a chain that
crests one cell in and decays over two to four cells, wider and higher
for a fast trench. A collision crests, holds a plateau for half its
width, then decays, with a thick root under it. A rift is a valley on
the axis with shoulders either side; from the coast the sea runs in
along the axis, five cells for a slow rift and ten for a fast one, so a
rift across a narrow mass is a seaway. A transform is a low fault range. A
passive margin stands up as an escarpment where the floor off it is
young, worn down where it is old, and a slow noise leaves some
stretches as plain. Strike follows the coast or the boundary. Then a
worn belt on old welds, a residual orogen on a large mass that has no
front at all, a flexural load inland of every belt, and a slow swell of
a few hundred metres over quiet interiors. Inland fill walks land only.
Hopping through water painted the same profile on the far shore of a
seaway. In the ocean, an island arc goes on the young side of every
ocean-ocean trench the run left away from land, and the geodesic arc
in the empty ocean is drawn only when the run left none. The Earth
fixture does not run this pass. It paints from authored plate margins.

A plate cut in two by its neighbours is not a bug to patch. The main
body keeps the name. A piece big enough stands up as a new plate with
its own pole and birthday. A scrap is absorbed. Nothing is left
disconnected.

**5. Identity.** Plates have stable ids, generated names, a birth time
and a parent. A name survives every rift and collision the plate
survives. The absorbing plate in a weld keeps its own name. Plate colour
keys off the permanent id, so a plate keeps its colour as others come
and go.

**Elevation** is read off the crust. Ocean depth comes from half-space
cooling (`5650 - 3050·exp(-age/62.8)` metres). Land height comes from
Airy isostasy on thickness (145 m per km, relative to
`seaLevelThicknessKm`).

`continentFraction` is the crust the planet *starts* with, and with
coasts frozen it is close to the final figure. It sits above Earth's
0.41 because birth includes drowned shelf. `seaLevelThicknessKm` is the
land-fraction dial. It stands for how much water the planet has. It is
separate from `crustReferenceKm`, the thickness that undisturbed crust
relaxes towards.

**Sculpt** writes the live metres field. The brush is a screen disk.
**Coast** grows or eats land at the sea-level contour. The new shore
stays jagged. **Relief** paints the local high or the local low. The
target comes from the neighbourhood. They do not stamp a plate
outline. Regenerate replaces the field. Save writes the live maps.

### The 1843 path

The original distance-field blend (`findCollisions` +
`assignRegionElevation`) is still there behind the **Simulate tectonics**
toggle, and `bun run preview --no-tectonics`. Keep it working as a
comparison. It is no longer bit-identical to the original. It is fed
plate velocities taken at each plate's centroid, rather than the old
random neighbour-direction vectors, so the codebase has one motion
model. Its `<` compression pick and collision table are otherwise
untouched.

`mergeOceanPlates` and `connectWorldOcean` remain UI toggles, both off by
default. `mergeOceanPlates` only applies on the 1843 path.

## Open

- **Boundary-placed story, judged from the relief sheet with
  `--no-detail`.** Belts are authored shapes placed by the run's final
  boundaries and sized by closing speed (`composeTectonicStory`). A pass
  is a coastal range where the crust view draws a trench, a plateau
  where two masses meet, a flooded rift where continental crust
  diverges near a coast, a marginal sea with an arc where a small plate
  sits under extension, a quieter back that sits lower, and continents
  that differ from one another. A fail is a pancake shield of one
  height, every coast a range, a lattice of ranges over a whole mass,
  or a small plate that only adds mountains where it should have opened
  a sea. Matching coasts from a rift are not this trial.
- **Boundaries through land.** Minors are born in the ocean and
  continental plates are slowed, but sites still drift and pieces still
  stand up, so some seeds carry a lattice of interior ranges where
  three or four plates meet on one mass. Judge on `sheet
  --overlay=plates --no-detail`: mostly one colour per continent is a
  pass. Not measured yet: how many land cells sit within two hops of a
  boundary, per seed.
- **Old oceans.** Median floor age is ~170 Myr against Earth's ~60, so
  the abyss reads as one dark plain and ridges are rare in the crust
  view. Two oceanic majors help. What would furnish the ocean is a
  ridge the empty ocean keeps for the whole run.
- **Polar continents.** Seven of twelve seeds put a land cap on a
  pole, and `polarStraits` then cuts the cap off as scattered flecks
  rather than a seaway. A placement bias away from the poles, or a
  strait that is one connected cut, is a trial.
- **The cell octave is texture, not features.** At 0.08 rad it makes
  coves and headlands of one or two cells. Peninsulas and gulfs of
  three to eight cells are the still's blocks and the story's rifts and
  forelands, not more noise.
- **Composed stills.** Continents are a shield plus pieces, then join
  cuts between huddled masses. The run stamps that plan back each
  step. Round ponds in the interior are still a fail.
- **The ridge staircase cannot be drawn here.** Earth's divergent
  boundaries look angular because short spreading segments are offset by
  transform faults. Built, then removed. Earth's segments run 30–500 km
  and its offsets 30–900 km, against cells 226 km across at `N=10000` and
  113 km at `N=40000`. Only the largest offsets are drawable at all.
  Drawing them cost 4 of 18 plates and pushed pieces per plate from 1.0
  to 1.5. The offsets stayed invisible in captures at both resolutions.
  Do not rebuild it without first raising the mesh by an order of
  magnitude.
- **Why this model and not another.** The Aug 2026 survey of World
  Orogen, GPlates, ASPECT, tectonics.js and the Cortial and Borg papers
  is in [history/layout-base-survey-2026-08.md](../history/layout-base-survey-2026-08.md).
  Borg et al. (Eurographics 2026) is the next model to compare.

## How to judge it

```sh
bun run preview plates    # plate shapes, sizes, motion, names, age
bun run preview crust     # sea-floor age, orogeny, boundary types
bun run preview relief    # hypsometric tint and hillshade — belts
bun run sheet             # twelve seeds at once
bun run sheet --overlay=relief
bun run sheet --overlay=relief --no-detail   # Layout's own field, no Shape on top
bun run sheet --overlay=plates --no-detail   # do boundaries hug coasts? one plate per continent?
bun run sheet --view=globe
```

`crust` shows what the simulation does: ridges with young pale crust
beside them fading to dark old crust, trenches, and transform segments.
If the full frame is too small, crop in on a margin. Then you can see
if a boundary is an arc or a chew, and if a trench is a line.

Judge the **batch**. A failure mode that hits every seed is easy to
mistake for a bad roll. A good roll is easy to mistake for a fix. That
is what `sheet` is for.

If a picture looks collapsed, `bun run stats` can hint at enclaves or a
plate in pieces. Do not tune toward its raggedness number.
`bun run check:earth` is a tripwire on the Earth fixture. It is not a
taste test. If it fails, look at the Earth captures. Decide whether the
picture moved the right way. Then `--update` to accept.
