# Carve — hydrology

## What it does

Hydrology cuts drainage into the baked 90 m DEM: rivers that reach the
sea, lakes in real basins, a trunk you can follow. It runs **after**
Terrain. Never as a substitute for it. A later Terrain would route at
1 km and make those rivers law for a 90 m residual. That file is
[custom-model.md](../custom-model.md). Do not rewrite this stage to
put rivers first while terrain-diffusion is the bake.

This stage is a large part of whether the finished planet feels
believable. Diffusion is trained on already-eroded Earth DEMs. Local
landform statistics — ridge sharpness, valley spacing, crenulation —
already look right. What it does not have is **non-local coherence**: a
catchment, a mouth, a hanging valley that actually joins the next one.
That gap is why this stage exists.

`@planetgen/hydrology` is a named slot. Nothing there runs yet. The
grain-independent drain lives in `src/route.js`. Shape uses a light
cut of that for valley texture and a drain tree. This stage would call
the same core on the 90 m cubesphere. It has not started.

## Reads

| Input | From | Used for |
| --- | --- | --- |
| the 90 m DEM | [Terrain](terrain.md#hands-on) | the surface to route on and cut into |
| `r_moisture`, `r_temperature` at 23 km | [Climate](climate.md#hands-on) | discharge, and which basins are endorheic |
| `r_boundary`, `r_orogeny` at 23 km | [Layout](layout.md#hands-on) via the sketch | bedrock vs alluvial character |
| face adjacency | [ref/cubesphere.md](../ref/cubesphere.md) | flow must cross face edges |

**Wishes** — unknown until a trial runs. Expect this list to be the most
active in the repo once the stage starts. Likely candidates: a lithology
or erodibility hint from Layout, and honest seasonality from Climate so
discharge is not a function of annual mean alone.

## Hands on

Two products. The split matters:

| Product | Form | Why |
| --- | --- | --- |
| edited DEM | 90 m int16, `z_out = z_diff + Δ` | only trunks and real canyons change height |
| reach / lake graph | vectors, hundreds of MB for a planet | order-1–3 streams, creek meanders, oxbow lakes |

**Most of the network never enters the DEM.** A 90 m cell is already a
wide river. Rivers ship to the game as a graph, never as a planet-wide
raster. See [export.md](export.md).

## Must not regress

Nothing to regress yet. These constraints are settled. The method is
not.

- **Do not rerun Shape's stream-power recipe on the bake.** That recipe
  is for a 23 km blob so the model sees valleys. A second
  landscape-evolution pass with a real hillslope `K` and uncapped
  incision will slot valley floors. It will round ridges. It will spend
  the high frequencies the U-Net just drew. **Diffusion owns landform
  statistics. Hydrology owns drainage. They must not use the same knobs.**
- **Do not carve on Layout's ~113–226 km mesh.** Valleys would be
  hundreds of kilometres wide.
- **Do not D8-carve a floodplain so it "drains."** Steepest descent
  through a meander belt is a cutoff. It straightens the belt.
- **Do not apply a global hillslope term to inherited terrain.** Optional
  hillslope is only for slots *this* pass just cut.

## How it works today

Nothing. What follows is the working stance and the candidate
operations. Structure only. Strength is open.

**Working stance:**

- **Consistency, not landform creation.** D8 on an already-dissected DEM
  follows the model's valleys. The defects are pits, hanging segments,
  false divides, a trunk that never reaches the sea. Measure those first.
  The carve budget is the defects, not "10 Fastscape steps."
- **Breach, do not fill**, except where a lake is the feature. Cap fill
  depth for endorheic basins. Filling a pit to the spill and painting a
  river across it is how the model's interior dies.
- **Incise to hydraulic geometry, then stop.** Target a channel
  depth/width from discharge. If the model's valley is already deeper,
  leave it. Most cells should take `Δz = 0`.
- **Mask.** `Δ` nonzero only on the channel, and maybe a one-cell bank.
- **The one heavy cut is a false divide** — a ridge the model treated as
  a watershed that hydrology says is a pass. Surgical, a few cells, not a
  planet-wide `K`.
- **Meanders are a floodplain process, not more incision.** Bedrock
  gorges stay dendritic. Alluvial valleys keep or get a planform.

**Candidate operations**, on the 90 m DEM with sea level still at 0:

1. **Fill or breach sinks** so flow can reach the ocean. Priority-flood.
   Terrain-diffusion already ships `fill_depressions_priority_flood` in
   `inference/postprocessing.py`. Prefer breach. If you want real
   endorheic basins, cap fill depth.
2. **Route flow** (D8 or similar) and accumulate contributing area. Same
   file has `d8_flow` / `flow_accumulation`. Ocean (`z <= 0`) is the sink.
   At planet scale this runs on the cubesphere adjacency graph. Rivers
   then cross face edges. Run at full resolution per drainage basin, or
   at an intermediate global level (~1 km) with carving applied to the
   fine tiles.
3. **Incise** along the network, only where the existing valley is
   shallower than the hydraulic target, or a saddle blocks a trunk.
   Stream-power style: carve more where area × slope is high.
4. **Hillslope** (optional, off on inherited slopes): mild diffusion or
   debris-slope on walls this pass just cut. Weak diffusion in dry rock
   keeps canyon walls. Strong diffusion in wet soil opens V-valleys.

**Canyon vs valley is a ratio, not a flag.** A canyon is a channel
cutting down faster than its slopes wear back. It needs a high surface
draining to a much lower base, a trunk with real area, and incision ≫
hillslope smoothing. A valley is the same process with more smoothing or
less drop. A wash is dryness and no drop. Hydrology will not turn a
pancake interior into the Grand Canyon. A single Colorado-style trench
needs **one** master river capturing a large plateau while the rims stay
high. Bias the trunk (pour point, extra area, higher `K` on one path).
Equal carving of every tributary gives a dissected plateau. That is
closer to what diffusion already sketches.

### Meanders and oxbows

In scope, not built. Stream-power does not grow them. Incision deepens.
It does not wander.

Meander wavelength is about **10–12× channel width**. A loop train that
reads as geology rather than noise wants λ ≳ 1 km, so bankfull width
≳ 70–100 m. That is a river. Oxbows are abandoned loops of that size. A
Mississippi-class cutoff is a 1–5 km lake, comfortably inside the 90 m
bake. A 30 m creek's meanders are not.

Three grains:

- **Aerial (90 m DEM).** Large meander belts and oxbow lakes. First keep
  what diffusion already drew. Earth 90 m DEMs are full of these and the
  U-Net paints them in low-gradient wet valleys. Hydrology follows that
  centerline. `Δz` only where the channel is hanging or blocked, and stay
  inside the existing belt. If alluvial reaches came out too straight
  (large area, low slope, not a bedrock canyon), synthesize a kinematic
  meander. Use a sine-generated curve, or Howard–Humber / Lancaster–Bras.
  Incise a narrow channel. Leave the floodplain from the bake. Oxbows are
  cutoffs. If a neck is thin, abandon the loop and leave it as a capped
  lake. **Graph edit plus a few metres of height, not another erosion
  pass.**
- **Approach (optional 30 m, local).** Medium rivers, wavelength a few
  hundred metres. If low flight still looks like a canal after the 90 m
  belt, use this. Not a global bake.
- **Walking (analytic, below 90 m).** Creek meanders as a centerline
  spline with displacement, draped at runtime.

### After the cut

- `smooth_river_bumps` (terrain-diffusion postprocessing) flattens small
  upslope glitches in channels without melting steep walls.
- Optional thermal erosion / talus on cliffs.
- **Coastline policy.** The coarse model *will* move the shoreline at low
  elevation SNR. If the sketch's coast must be law, raise ELEV SNR a
  little or mask ocean before hydrology. If you want dendritic coasts,
  leave it.
- **Climate on the fine DEM.** Elevation changes. Recompute
  temperature with a lapse rate. If you have wind, add orographic
  precipitation. Take biomes from temp + precip + elevation, not from
  hillshade colour.

## Open

The whole method. The concrete question: **how hard can this touch the
bake before it breaks the landform statistics diffusion just drew?**

Judge a trial the same way as everything else: crop a bake, run a light
pass, crop the same valley. **If the ridges moved, `K` is too high.**

Shape now writes a 23 km drain tree (`r_drainTo`, `r_discharge`). That
graph is a preview. Judge it with `bun run preview drainage`. Those
rivers do not constrain the 90 m pass. A drainage graph on Terrain's
cheap whole-planet pass would be another preview. The later inversion
— rivers before valleys — waits for
[custom-model.md](../custom-model.md).

## How to judge it

Crop the same valley before and after. Look for: a trunk that reaches the
sea, tributaries that join at sensible angles, lakes only where a basin
justifies one, and ridges that did not move.

At planet scale, follow one river from source to mouth across a face
edge. That is the test the cubesphere routing has to pass.
