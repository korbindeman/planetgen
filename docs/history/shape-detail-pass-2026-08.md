# Giving the base planet detail — Aug 2026

**Historical. Do not update this file.** It records how Shape's three
steps were chosen and what they replaced, as argued at the time, after
reading [World Orogen](https://orogen.studio)'s implementation.

All three shipped: a second mesh with domain warp and island crests (A),
phasor ridges on the belts (C), and first-stage erosion (E). What they do
*now* — and what still looks wrong — is [shape.md](../stages/shape.md). Further
work on the pass belongs there, not here.

Status labels are **decided**, **recommended**, **open**, as in
[../README.md](../README.md).

## Why not simply raise the mesh — decided

The obvious move is to run the existing model at 200k cells instead of 10k
(226 km per cell). It was tried on seed 42 at 10k / 60k / 150k and the planet
gets *worse*, not finer: land thins, continents wash out, and the island arcs
break into speckled dot-fields.

The model is resolution-dependent in at least three ways:

- **Smoothing is counted in cell hops, not kilometres.** `coastBlend: 1`,
  `healPasses: 2`, `crustSmoothing: 1`, and the thickness smoothing at
  `tectonics.js:1870` all cover a quarter of the physical distance at 150k that
  they cover at 10k, so margins never relax into shelves and drown instead.
- **Noise frequencies are fixed in world space.** The arc crest noise at
  `tectonics.js:1909` uses frequency 8 regardless of mesh, so at high cell counts
  it resolves into speckle rather than picking out stretches of a front.
- **Thresholds are tuned against 10k**: `speckCells`, `minFragment`,
  `plateRetireArea`.

So resolution has to be *decoupled* from the simulation and detail added
deliberately. Raising `N` is not a shortcut to any of the three steps below.

## What we keep and what we borrow

| | planetgen today | World Orogen | plan |
| --- | --- | --- | --- |
| Continents | clustered cratons, crust type independent of the plate partition | land is a per-plate boolean, continents seeded farthest-point | **keep ours** — this is why our coasts do not trace plate outlines and why one ocean stays empty |
| History | 200 Myr of rigid-body rotation, rift and collision | one-shot; velocity evaluated once, never integrated | **keep ours** |
| Ocean floor | half-space cooling on real sea-floor age | distance-to-coast profile, no age field | **keep ours** |
| Resolution | 10k cells, one mesh | 20k coarse sim → 204k–2.5M render mesh | **borrow theirs** (step A) |
| Coastline shape | one warp octave + `detailNoise: 0.06` | domain-warped lookup, coastal fractal, glacial fjords | **borrow theirs** (steps A, E) |
| Mountains | scalar orogeny → smooth swell | phasor/Gabor ridges oriented to compression | **borrow theirs, improved** (step C) |
| Erosion | none | priority-flood + stream power + thermal + glacial | **borrow theirs, staged** (step E) |

Their weakness is ours to keep away from: whole-plate land assignment and
farthest-point continent seeding are exactly what removes hemispheric asymmetry,
and filling interior depressions (`fixupTopology`) is what removes inland seas.

## Step A — the detail and warp pass — implemented

The one that matters most. Everything else needs the mesh it creates.

**Two meshes.** The simulation keeps its current mesh (10k–40k): plates, crust,
climate, all tuned parameters unchanged. A second **detail mesh** of 200k–1M
regions is built from the same sphere routine and carries the final heightmap.

**Transfer.** Sample the simulation's `meters` field — before `metersToElevation`,
so it stays in physical units — onto the detail mesh, using the same
`sampleWeights` / `sampleField` interpolation the crust advection already uses
(`tectonics.js:1058`, called at `tectonics.js:1192`). `r_arc` and `r_hotspot`
must come across too; the crest pass below consumes them.

**Warp.** Displace each detail cell's *sample point* in the tangent plane by
multi-octave FBM before the lookup. Warping the lookup rather than adding height
is the specific thing that produces embayments, capes and peninsulas instead of a
bumpy fringe — World Orogen's `warpTerrain` (`terrain-post.js:252`) displaces up
to 0.13 rad (~760 km) over 5 octaves.

Amplitude should be scale-graded: a low-frequency component of a few hundred km
that swings whole capes, down to a fine component of tens of km that frays the
shore. **Keep the largest amplitude below craton scale** — past that the warp
starts dissolving the global layout, which is the part we are good at.

**Coastal roughening.** A higher-frequency fractal applied only within a band of
the shoreline, so interiors do not get noisy for free.

**Then the island crests — moved here.** The crest pass currently runs inside
`crustToElevation` (`tectonics.js:1898`) and can only paint one 226 km cell per
island, which is far too big. Run it *after* the warp instead, on the detail mesh,
against the transferred `r_arc` / `r_hotspot` fields: the same mechanism then
produces chains of small islands at a believable size, which is what it was
written for.

**Scale invariance this forces.** Smoothing radii, coast blend and noise
frequencies have to be expressed in kilometres derived from mesh spacing so both
meshes agree. World Orogen does this with `scaleFactor = sqrt(numRegions/10000)`
as a stated rule; we need the equivalent.

**Risk.** A warp large enough to be interesting can shear the tectonic story —
a trench sliding off the arc that belongs to it. Warp the composite height field
only, keep amplitude under feature width, and read `bun run preview crust`
afterwards, not just the geography views.

Estimated ~150–250k tokens.

## Step C — oriented mountain ridges — implemented

Today a belt is `opts.orogenyReliefM * r_orogeny[r]` (`tectonics.js:1877-1878`).
Orogeny is a scalar diffused inland, so a mountain range is a smooth dome with no
ridges, no strike and no grain.

**Mechanism: phasor ridges.** Sum directional Gabor kernels along the belt — each
a complex exponential under a Gaussian envelope — and take `atan2(Σsin, Σcos)`
per cell, giving a sawtooth ridge field. Bias it positive for asymmetric
thrust-like profiles and domain-warp the phase so ridgelines meander instead of
tracing clean small-circles. World Orogen uses 4000 kernels, a 180 km envelope, a
55 km wavelength and amplitude 0.5 (`elevation.js:1372`), decoupled from its noise
slider because it is structure, not texture.

**Where we can beat them.** They orient kernels from an *inferred* instantaneous
stress field, because they never integrate motion. We have the real thing: plates
are rigid bodies with Euler poles and actual convergence is computed at every
boundary on every step. Recording that direction at collision time gives ridges
oriented by real kinematics rather than a guess.

That needs a new `r_orogenyDir` field (tangent-plane direction, or an angle)
written in the collision branch where orogeny accumulates
(`tectonics.js:1246-1253`), advected with the crust exactly as `r_orogeny` is,
and consumed on the detail mesh.

Runs on the detail mesh, after A — a 55 km ridge wavelength is meaningless at
226 km per cell.

Estimated ~100–150k tokens.

## Step E — first-stage erosion — implemented

There is no erosion at all today. Slopes are noise, coasts have no drainage
logic, interiors are smooth domes, and `detailNoise` is uniform so a quiet craton
and an active belt have identical texture.

**Hydrology in two stages** — this is a deliberate scope change, see below:

- *Here, on the base:* priority-flood so every land cell drains to the sea; a few
  iterations of stream-power incision; talus/thermal diffusion; soil creep.
  Enough for valleys, dendritic coast texture, and slopes that came from
  somewhere.
- *Downstream, after diffusion:* real river networks, discharge, lakes and
  canyons at 90 m. terrain-diffusion redraws local statistics anyway (see
  [ref/terrain-diffusion.md](../ref/terrain-diffusion.md)), so fine erosion here
  would only be overwritten.

**Mechanism.** World Orogen's `erodeComposite` (`terrain-post.js:399`) interleaves
glacial → hydraulic → thermal per iteration. Hydraulic is Braun-Willett implicit
stream power, `h_new = (h + f·h_recv) / (1 + f)` with `f = K·A^m·dt/dist`;
priority-flood carve is `terrain-post.js:78`. Their defaults are 10 hydraulic,
1 thermal, 5 glacial iterations.

**Glacial is worth calling out**: latitude- and elevation-gated ice flow carves
fjords, which are the most recognisable coastline feature there is, and our
climate model already says where the ice belongs.

**Also here: modulate detail noise by terrain.** Quiet cratons subdued, active
belts rough — World Orogen does it with a per-cell `r_noiseAmp`
(`elevation.js:837`). Cheap, and it does a lot for the sense that the planet has
distinct regions.

**Cost.** Erosion is O(iterations × cells) with a sort per iteration, so at 1M
detail cells it is the most expensive stage in the generator. It is a bake-time
cost, not an interactive one — but the interactive preview will need a lower
detail mesh or a skip.

Estimated ~200k tokens.

## Order

```
simulation (unchanged, 10k-40k)
  → A  transfer to detail mesh → domain warp → coastal roughen → island crests
  → C  oriented ridges on the belts
  → E  priority-flood → stream power → thermal → glacial → soil creep
  → colormap / export
```

A first: it builds the mesh C and E both need. C before E so that erosion has
real ridgelines to cut into rather than a dome. Island crests sit inside A after
the warp, so the islands are warped, then ridged and eroded like any other land.

## Scope change

`CLAUDE.md` used to list "rivers, flow accumulation, or carving valleys into
the heightmap" as out of scope, and the pipeline notes placed hydrology after
diffusion. Step E splits that: **rough shaping here, real drainage later.** Both
documents were updated when E landed.

## What must not regress

Everything in [layout.md § Must not regress](../stages/layout.md#must-not-regress),
plus the properties these
steps are most likely to damage:

- global layout: clustered land, one large empty ocean, hemispheric asymmetry
- coasts interpolated from elevation, never tracing plate outlines
- crust type independent of the plate partition
- ocean floor age-graded away from its ridge, trenches at convergent margins
- plates remain single coherent bodies

Judge with `bun run sheet` (both globe and equirect) rather than one seed, and
read `bun run preview crust` after any change to A or C — the geography views
hide a sheared tectonic story.
