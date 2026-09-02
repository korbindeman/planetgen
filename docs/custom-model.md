# Custom model

A later **Terrain**: two learned grains with **Hydrology** between them.

This file is a vision. Nothing here is built. The current bake is
terrain-diffusion. That sprint is [terrain.md](stages/terrain.md). Do
not rewrite that order to match this one.

## What it is not

It is not a rename of **Discover** or **Finish**. Search stays Layout
only. There is no Shape sheet.

It does not move Climate before Shape. `climate.js` already runs in
Layout. A bake-time GCM still wants finished height. See
[climate.md](stages/climate.md).

It is not a reason to put rivers before the 90 m pass while
terrain-diffusion is the bake. [Carve — hydrology](stages/carve-hydrology.md)
stays after Terrain until a model can read a reach graph.

## The later Finish

Discover is unchanged: **body** buckets, Layout, Shape. Shape would
also write a **feature list**. Height would still drop one-cell cones.

Finish would then run:

1. Optional GCM on the finished height. Skip if the sketch keeps
   `climate.js`.
2. A learned **1 km landscape** on the whole sphere, including the
   seafloor. Minutes. Bathymetry would finish here. Earth's seafloor is
   known to about a kilometre. There is nothing finer to learn from.
3. **Hydrology** on that 1 km sphere. Every cell routes downhill. Water
   reaches the sea or a real closed basin. The output is a reach / lake
   graph for the planet. Those rivers are law for the next grain.
4. A learned **90 m residual** on land and the shelf: above about 200 m
   depth, a band around any sea level Climate chose, and any deep
   feature flagged on its own. About a third of an Earth-like sphere.
   The abyss stays at 1 km. The model would read the story maps, the
   feature list, and the river graph. Valleys would go around rivers
   that exist.
5. A sea-level cut at the level Climate chose. Drowned troughs become
   fjords. Drowned hills become archipelagos. Raising or lowering the
   sea later would be a re-cut if the 90 m pass already covered that
   band, not a re-bake.
6. [Export](stages/export.md): the residual pyramid, climate at the
   coarse cell, rivers as a graph.

Runtime stays analytic below 90 m. A one-step 90 m → 10 m model in
the game would reopen Export's decided line that human scale is never
a diffusion bake. That trial is not run.

## Four inversions

These are the changes. Everything else is a field or a bucket.

**Terrain splits, and Hydrology moves between the two halves.** Today
one bake goes 23 km → 90 m. Then Carve reconciles rivers on an already
dissected DEM. Diffusion owns landform statistics. Hydrology owns
drainage. The later model inverts that: rivers exist before valleys.

terrain-diffusion cannot do this. It reads height plus four climate
channels. It has never seen a reach graph, a hotspot age, or a
collision strike. A thin channel cut into a 1 km height will get
healed. The model already eats one-cell anomalies. See
[ref/terrain-diffusion.md](ref/terrain-diffusion.md).

**Shape writes a feature list, not a taller mesh.** Most islands are
smaller than 23 km. The list would hold every edifice: kind, age,
trail. Carve stamps would read it now. The later 1 km and 90 m models
would dress it. The list must not enter `r_meters`. If it does, this
model heals the cones and Carve has nothing to stamp. Layout already
has the peak / age / strike triples. The missing product is discrete
features, not a fifth Layout field.

**Sea level is a late cut.** Today **water** is a body fact and sea
sits at 0 m from Layout onward. Shape's ice pass drowns a 23 km cell
and that is not a fjord. Climate would emit ice history and
sea-surface temperature. The 90 m pass would cover a band around the
chosen level. Flooding after the valleys exist is what makes fjords,
skerries, and drowned karst.

**A learned step in the game, 90 m → 10 m.** Export has this as
decided: analytic octaves, seed, done. Reopen only with a picture
that walking still looks soft after hydrology and those octaves.

## What Discover would grow

Needed by the current bake's stamps and by this later Terrain.

- A **feature list** on the sketch. Same planet. Same Save. Height
  still drops one-cell cones. Schema is **open**.
- Sea-surface temperature, and ice as history rather than a Shape
  gene. Climate does not ship either. See
  [climate.md § Open](stages/climate.md#open).
- **Body** buckets Initialize does not have: how active, how icy.
  Gravity and tilt already exist and start pinned. Genes already steer
  vigour. Do not add those buckets on this sprint.
- Lithology is not in [Layout's contract](stages/layout.md#hands-on).
  A Florida swamp and a Grand Canyon are hydrology-plus-rock products.
  Do not add a Layout field until a picture fails.

The story maps are already richer than Terrain uses. The gap is not
Layout. Finish only forwards five TIFFs. See
[ref/terrain-diffusion.md](ref/terrain-diffusion.md).

## Two orders

The order that trains this later Terrain:

1. Earth's residual pyramid, with the story maps attached. Training
   data, install format, and answer key in one artifact.
   `check:earth` locks a stats report. That is not a pyramid.
2. The 90 m residual model.
3. Hydrology at 1 km, so the residual can be told where the rivers
   are.
4. The 1 km landscape model.

The order that gets a planet on screen with the model we have is
already in [terrain.md § Open](stages/terrain.md#open): cubesphere,
one face, one seam, cheap whole-planet pass, then 90 m, then Carve.

Those two orders can run in parallel. They must not share one stage
doc.

## Cost

[bake-compute.md](ref/bake-compute.md) is the terrain-diffusion
figure: a dense 90 m Thalos bake is one to two days on the home
4070 Ti. That number stays true until the model changes.

A distilled 90 m residual on land and shelf, plus a 1 km whole-sphere
pass, would aim at hours for a full planet and minutes for the 1 km
landscape plus its river graph. Those times are a target. They have
not been measured.

## What stays

- Coasts from a continuous field, never plate outlines. Do not raise
  `N` for detail.
- Moisture advected, never painted on by latitude.
- Preview tiles as a Shape tool. Artifacts under
  `preview/<project>/v/<id>/`.
- Do not vendor terrain-diffusion.
- A **system** is several **projects**. A moon is not a variant of
  Thalos. An airless body would be a different point in the same
  space: fluvial channels off, craters on. That grain is
  [systems.md](systems.md).

[Carve — landforms](stages/carve-landforms.md) would shrink as the
later model starts to honour the feature list. It does not vanish on
the first day.

## Status

**open**. Not this sprint. Do not split [terrain.md](stages/terrain.md).
Do not rewrite [carve-hydrology.md](stages/carve-hydrology.md) to put
rivers first.
