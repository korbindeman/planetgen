# How the studio works

Canonical. Language lives in `CONTEXT.md`. This is the operational model:
phases, stages, the tree, and what a Save is. If another doc disagrees,
this one wins.

## Two phases

**Discover** — Layout then Shape. Search, Save, iterate. The tree lives
here. The artifact is a **sketch** at the terrain model's grain (23 km
today).

**Finish** — Climate → Terrain → Hydrology → Export. Overnight and GPU
work on a variant you already kept. Not another place you shuffle.

Do not call Finish "the pipeline" or "the bake." The whole product is the
pipeline. Terrain is the bake. Finish is the phase.

**Commit** (Adopt in the UI) chooses one variant as the project's planet
so Finish runs on that instance. It is not a Save.

## Stages

| Stage | Phase | Done means |
| --- | --- | --- |
| **Layout** | Discover | This variant's plates and continents are kept. |
| **Shape** | Discover | Detail + later sculpting frozen as the sketch. |
| **Climate** | Finish | Bake-time climate on that height (ExoPlaSim). Skip if the sketch keeps `climate.js`. |
| **Terrain** | Finish | Whole-planet diffusion (cheap pass then 90 m). Cube faces and seams are internal. |
| **Hydrology** | Finish | Rivers, lakes, canyons on that DEM. |
| **Export** | Finish | Residual pyramid for the game. |

Preview tiles are a Discover **tool**, not a stage. Pick them on the
cubesphere grid, bake, drape. Cubesphere, conditioning, and "coarse
planet" are not Progress rows.

## Layout, then Shape

Search, shuffle, and explore run **layout only** (the 10k sim). Shape is
an explicit action on a saved variant, then cached on that node. It
reuses that variant's layout: plates and `climate.js` do not rerun when
you Shape, shuffle the shape seed, or move a shape gene.

Shape always lands on the model's sketch grain, independent of planet
size. Cell count is derived: `N ≈ π (2r / spacingKm)²`. On Thalos at
23 km that is ~240k cells; on Earth ~1M. Layout `N` (10000) and shape
spacing (23 km) are shipped application values, behind Advanced. They
are not genes. If the terrain model later wants a different grain, change
the shipped spacing.

Layout seed and layout genes find a world. Shape seed, shape genes, and
later authored sculpting iterate coasts and islands on that world
without rerunning tectonics. There is no Shape search sheet — the
thumbnails would not show the grain you are judging, and sixteen
sketches would be too slow. Iterate on the globe.

## Two seeds

**Layout seed** — plates, continents. Shuffle this → a different planet.

**Shape seed** — warp, islands, ridges, first-stage erosion. Shuffle this
→ the same planet. Defaults to the layout seed until someone shuffles it.

Never say "the seed" alone.

## The tree

A **variant** is one saved snapshot. Artifacts (`preview/<project>/v/<id>/`)
belong to that id. A node's Shape sketch does not go stale: a child is a
different snapshot and starts unshaped until you run Shape on it.

Every **Save** writes a **new node**, child of head. Uncommitted work
stays on the working planet until Save. Likes still write **ranges** to
head without saving.

**Same planet** vs **different planet** is lineage, not whether the id is
reused:

- New **layout seed**, or an explore tile → different planet. Save is
  still a child. Commit/Adopt does not follow.
- Layout genes, shape seed, shape genes, sculpting, body, a name → same
  planet. Save is a child. Adopted follows that line when the save is on
  it.

A name labels a node. It is not what makes a child. The UI word is
**Save**, never Update.

## Finish reads the sketch

Climate, Terrain, hydrology, and export consume the 23 km sketch on that
variant. They do not re-run Shape. Preview tiles may run earlier, still
keyed to the variant, so they do not follow you onto the next candidate.
