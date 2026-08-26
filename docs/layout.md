# Layout

First stage. **Open, and the one we improve most often.**

## What it does

Simulates plate tectonics on a ~10k-cell sphere and hands on a planet:
where the plates are, where the continents are, what the crust is made of
and how old it is, and 200 Myr of history for how it got that way.
`climate.js` runs on the result (see [climate.md](climate.md)).

Grain is ~113 km per cell on Thalos, ~226 km on Earth, at `N = 10000`.
That is coarse on purpose. Raising `N` does not make the planet finer —
it makes it worse; see [§ Must not regress](#must-not-regress).

The model lives in `src/tectonics.js`, free of WebGL and DOM, so captures
and the headless helpers share one model.

## Reads

Layout is first, so it reads from the studio, not from a stage.

| Input | From | Used for |
| --- | --- | --- |
| **body** — radius, gravity, day, tilt, age, water | the variant | every derivation is a ratio against Earth, exactly 1 at Earth's defaults |
| **layout seed** | the variant | plates, continents, crust. Shuffle → a *different planet* |
| **layout genes** — `plates`, `steps`, `cratons`, `continentFraction`, `hotspots`, … | the variant's ranges | what kind of planet within that body |

`world.js` holds the body and its derivations, separate from the model
parameters because all three models read it. `params.js` is the registry
of every parameter with its unit and range; it validates project files
and throws if a knob is added without being registered.

**Wishes** — nothing upstream to ask. What Layout wants is a better
model, which is [§ Open](#open).

## Hands on

Sampled onto Shape's mesh with the same `sampleWeights` / `sampleField`
interpolation the crust advection uses. This table is the contract; a new
field means a new row.

| Field | Type | Meaning | Consumed by |
| --- | --- | --- | --- |
| `meters` | f32 | elevation in physical metres, before `metersToElevation` | Shape (warps it), everything downstream |
| `r_crust_type` | u8 | continental or oceanic | Shape, Terrain conditioning |
| `r_crust_age` | f32 | sea-floor age, Myr | Shape; ocean depth via half-space cooling |
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

**The peak/age/strike triples are the point.** Present strength alone is
not enough: an extinct arc and an old hotspot track have to still be on
the map after the volcanoes stop, or Shape has nowhere to put Curaçao and
the Emperor seamounts. This is compact **maps**, not a step log — Layout
does not hand on a history of events, it hands on the present state of
four things plus how long ago each was last refreshed.

Iceland-style plume-on-ridge plateaus and drowned-margin islands are
**derived** downstream from these plus crust, elevation, and the live
boundary. Do not add a fifth field until a picture fails.

## Must not regress

**Coasts come from interpolation over a continuous field, never from
plate outlines.** This is the one thing. The generator once grew land as
blobs that filled a plate, and coastlines traced plate boundaries. Today
the coastline is the sea-level contour of a continuous elevation field
built from crustal thickness and sea-floor age, relaxed across the margin
(`coastBlend`). Crust type is seeded from cratons placed independently of
the plate partition, so a plate can carry a continent and an ocean at
once.

Do not:

- Grow continents as blobs on plates, or derive crust type from plate id
- Go back to thresholding a noise field for crust type. At the ~40%
  coverage continental crust needs, a thresholded isotropic field sits at
  the percolation threshold, which produces stringy maze-like land spread
  evenly over the sphere. No seed escapes it; this was measured.
- Floor continental plates or flatten ocean basins to a constant depth
- `Math.max(elevation, …)` on a plate or a cell
- Widen `coastBlend` — a wide blend averages a margin against the abyssal
  plain and drowns it
- Bring back a radial dome from core to coast. Elevation is not a
  function of distance to the coastline; the dome is what made every
  continent shade like a blob. Relief on land belongs to orogeny and
  sutures.
- Adjust per-nucleus scales to hit plate areas. It does not converge:
  area is a steep function of the ratio between neighbouring scales, so
  the correction overshoots. On one seed the worst error grew 2.0 → 4.6
  while a single plate swelled from 131 sites to 340.
- Raise `N` to get detail. Tried at 10k / 60k / 150k on seed 42: land
  thins, continents wash out, arcs break into speckle. Smoothing is
  counted in cell hops not kilometres (`coastBlend`, `healPasses`,
  `crustSmoothing`), noise frequencies are fixed in world space, and
  `speckCells` / `minFragment` / `plateRetireArea` are tuned against 10k.
  Resolution is decoupled instead — that is what Shape is.

**Per-cell fields belong to their mesh.** `boundaryWarp` and the crust
arrays are one value per cell, so a cached one is only valid for the mesh
it was built for. `simulateTectonics` stamps `map.tectonicFieldsFor` with
the region count and seed and rebuilds when it changes. Without that, a
caller that keeps one `map` across regenerations — which the browser does
— indexes a 10k field with a 40k mesh, reads undefined, and hands NaN
weights to the ownership pass. The planet collapses to two or three
plates, but only after the mesh size changes, so the headless scripts
never see it.

## How it works today

**1. Plate geometry.** A plate is a rigid body made of *sites* — points
that rotate with it. A cell belongs to whichever site is nearest, so a
boundary falls where two plates' nearest sites tie: a great-circle arc,
and where three meet, a triple junction. Several sites per plate rather
than one is what keeps shapes from being convex caps.

Ownership is grown outwards from the sites with a weighted Dijkstra, not
by testing every cell against every site. That matters: the all-pairs
cost caps how many sites a plate can have, and that cap is what broke the
size hierarchy, because the smallest plates in a heavy-tailed
distribution want less than one site each and end up with none. Sites are
handed to plates by a **capacity-constrained assignment** — nearest pairs
first, each plate taking exactly its quota.

**Majors and minors are not seeded alike.** The majors tile the sphere
between them; the minors are then carved out of the boundaries between
majors — each born at the midpoint of a tight cross-plate site pair,
preferring margins where the majors converge, its sites gathered with a
stretch along the boundary (`microplateElongation`) so it comes out a
sliver hugging the margin, the way the Caribbean, Cocos and Scotia do.
Seeding every plate from a free-standing nucleus instead drops minors
into the middle of majors, where they sit as single-neighbour enclaves.
Earth has no enclave plates, and neither does this model: `absorbEnclaves`
hands any plate whose whole edge touches one neighbour back to that
neighbour, at birth and every step. A leftover enclave shows up on the
plate capture as a single-neighbour island of colour. Minors also spin
faster than majors (`microplateSpin`), as Earth's do.

**Subduction acts on the plates themselves.** Sites used to be immortal,
so a converging plate's sites marched through whatever stood in the way;
a microplate in a closing vice was overrun in a few steps and the census
fell from ~20 to ~9 with nothing small left. Now a site standing on
another plate's ground at a converging margin is slab: density decides
which side sinks (ocean under continent, older floor under younger,
continents never — they collide, which is what a collision belt needs),
decided by majority along the whole shared margin rather than site by
site — a per-site verdict flip-flops along a patchy coast and shreds the
front. The overriding side's site retreats onto its own ground instead,
so the trench stays pinned to the plate that owns it. Every consumed site
is handed back as a new site on a spreading margin, weighted by the
*share* of each plate's boundary that is divergent — never by raw ridge
length, which is the same rich-get-richer term that once let one plate
eat the map. Trenches also calve back-arc microplates (`spawnBackArcPlate`,
the Philippine Sea story) whenever the census is below the plate count
asked for. `sitesPerPlate` doubles as the grain of trench erosion: too few
sites and the eaten front looks chewed; around 40 the trench stays a line
on any mesh size.

**2. Motion.** Rigid rotation about an Euler pole, `omega x r`, in a
no-net-rotation frame. A single constant vector per plate is tangent at
one point only, and on 20 plates puts >30% of the velocity into the
radial direction across a third of the surface. Boundaries are classified
convergent / divergent / transform from relative velocity against the
boundary normal.

Plates grow at their ridges and shrink at their trenches, measured as a
share of the plate's *own* boundary. Counting raw cells makes the term
scale with plate size, so the biggest plate has the longest ridges, gains
most, and grows until it owns the map. The reversion term must stay
stronger than the growth term or there is no equilibrium at all.

**3. Continents.** A handful, unequal in size and biased to cluster into
one hemisphere — which is what leaves a Pacific-sized ocean opposite
instead of spreading land evenly. Each is grown as a chain of overlapping
elliptical blocks (`planBlocks`), the way a real continent is an
aggregate of cratons: the union's outline gets waists, promontories and
concavities from the structure, and noise (`cratonWarp`, `gulfCut`…) only
textures the margin. A weld between two blocks can carry an old belt or
sag into a shallow inland sea (`sutures`). A global bisection rescales the
plan to hit the target continental area; the Earth fixture authors its
blocks directly and zeroes `sutures`.

Interiors are *flat*: a coastal plain climbs to a platform at
`crustReferenceKm` (~650 m via isostasy) and stays there.

**4. Simulation.** The crust is the state: type, age, thickness, orogeny,
arc. Each step the plates turn, ownership is rebuilt from the sites, and
the crust is advected by back-rotating each cell along its owning plate.

What happens to the crust keys off **what the boundary is doing, never
off whether a cell changed hands**. Ownership is also renumbered when
plates split, weld or absorb a scrap, and reading that bookkeeping as
subduction shreds the continents. Divergent margins thin the neighbouring
crust by a fixed amount per step and flood once it breaks; thinning by a
*fraction* instead halves a cell every step it touches a rift and leaves
half the continental crust too deep to be land.

Arcs and belts are raised along a margin for as long as it is converging,
not only in the step the boundary sweeps past. Ownership changes over a
band a cell or two wide per step, so tying mountain building to that band
alone leaves a planet with almost no relief.

A plate cut in two by its neighbours is not a bug to patch over: the main
body keeps the name, a piece big enough stands up as a new plate with its
own pole and birthday, and a scrap is absorbed. Nothing is left
disconnected.

**5. Identity.** Plates have stable ids, generated names, a birth time and
a parent. A name survives every rift and collision the plate survives; the
absorbing plate in a weld keeps its own. Plate colour keys off the
permanent id, so a plate keeps its colour as others come and go.

**Elevation** is read off the crust: ocean depth from half-space cooling
(`5650 - 3050·exp(-age/62.8)` metres), land height from Airy isostasy on
thickness (145 m per km, relative to `seaLevelThicknessKm`).

`continentFraction` is the crust the planet *starts* with; the simulation
consumes some at sutures, so it sits well above the final figure.
`seaLevelThicknessKm` is the land-fraction dial — it stands for how much
water the planet has, and is deliberately separate from `crustReferenceKm`,
the thickness undisturbed crust relaxes towards.

### The 1843 path

The original distance-field blend (`findCollisions` +
`assignRegionElevation`) is still there behind the **Simulate tectonics**
toggle, and `bun run preview --no-tectonics`. Keep it working as a
comparison. It is no longer bit-identical to the original: it is fed plate
velocities taken at each plate's centroid rather than the old random
neighbour-direction vectors, so the codebase has one motion model. Its
`<` compression pick and collision table are otherwise untouched.

`mergeOceanPlates` and `connectWorldOcean` remain UI toggles, both off by
default. `mergeOceanPlates` only applies on the 1843 path.

## Open

- **Relief is the gap, not the partition.** Boundaries are already close
  to straight arcs; the leftover roughness is trench fronts, which
  genuinely erode now. What still looks wrong is that mountains sit in
  diffuse patches rather than linear belts. This is the live question.
- **The ridge staircase cannot be drawn here.** Earth's divergent
  boundaries look angular because short spreading segments are offset by
  transform faults. Built, then removed. Earth's segments run 30–500 km
  and its offsets 30–900 km, against cells 226 km across at `N=10000` and
  113 km at `N=40000`, so only the largest offsets are drawable at all —
  and drawing them cost 4 of 18 plates and pushed pieces per plate from
  1.0 to 1.5 while staying invisible in captures at both resolutions. Do
  not rebuild it without first raising the mesh by an order of magnitude.
- **Why this model and not another** — the Aug 2026 survey of World
  Orogen, GPlates, ASPECT, tectonics.js and the Cortial and Borg papers
  is in [history/base-survey-2026-08.md](history/base-survey-2026-08.md).
  Borg et al. (Eurographics 2026) is the one to watch.

## How to judge it

```sh
bun run preview plates    # plate shapes, sizes, motion, names, age
bun run preview crust     # sea-floor age, orogeny, boundary types
bun run sheet             # twelve seeds at once
bun run sheet --view=globe
```

`crust` is the view that shows what the simulation is actually doing:
ridges with young pale crust beside them fading to dark old crust,
trenches, transform segments. Crop in on a margin when the full frame is
too small to see whether a boundary is an arc or a chew, or whether a
trench is a line.

Judge the **batch**. A failure mode that hits every seed is easy to
mistake for a bad roll, and a good roll is easy to mistake for a fix —
that is what `sheet` is for.

`bun run stats` is optional if a picture looks collapsed and you want a
hint (enclaves, a plate in pieces). Do not tune toward its raggedness
number. `bun run check:earth` is a tripwire on the Earth fixture, not a
taste test: if it fails, look at the Earth captures, decide whether the
picture moved the right way, then `--update` to accept.
