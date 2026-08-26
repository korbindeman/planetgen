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

Finish runs on a variant you already kept — whichever node you name.
There is no Adopt/Commit step. Earth has no variants.

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
planet" are not stages.

There is no Progress panel. The UI flow *is* the progression: Layout,
then Shape. Layout's forward action is Shape. Shape has a back to Layout.
A variant's place in the pipeline sits on that node in the tree — the
only place you read per-variant progress.

The current Discover stage is **derived** from how far the open variant
has got. Opening **head** lands you in Layout or Shape. You can still
return to Layout to change plates; that work is uncommitted until
**Save**, which writes a **child**. The parent keeps its sketch. Finish
is not something you browse to from here.

The workspace shell is always: back to projects, the project name,
**Save**, and **Variants**. The globe and look stay on the canvas. Workspace chrome is Preact; the
canvases and generator are not.
**Save** is a shell action on the working planet, not a control inside
the tree. The name field next to it shows the active variant. Save
continues that name. Change the name and Save starts another variant,
keeping the ranges you were on. Save never opens **Variants**. Layout's panel is the layout seed, **body** (with **pins**),
tectonics genes, `climate.js` genes, Explore, and Shape. Advanced folds
on Layout only: mesh `N`, shape spacing, jitter, the 1843 toggles —
shipped values, not genes. Shape's panel is the shape seed, shape genes
(warp, ridges, erosion, ice), preview tiles, and back to Layout.

**Explore** covers the globe with a sheet. The shell stays. Layout's
panel becomes next / back / Done and the range readout. Done returns to
the globe. Opening a tile closes the sheet onto that working planet — a
**different planet**, uncommitted. Save on a tile writes a child. Likes
write **ranges** to the active variant. Earth has no Explore.

Earth is the **fixture**. Same globe, look, Layout, Shape, and Advanced.
No Variants, Explore, Save, or name. Authored knobs in the file,
not pins. Back to projects still.

## Layout, then Shape

Search, shuffle, and explore run **layout only** (the 10k sim). Shape is
an explicit action on a saved variant. The first Shape writes a **child**
that becomes **head** of that lineage — same name, shape thumbnail —
and the layout snapshot stays behind it. Later Shape on a dirty head
does the same. Opening the card opens that head (the cached sketch).
Back on the Shape panel is Layout of this variant. Lineage of earlier
saves sits on the card, not as a second variant. Shape reuses that
variant's layout: plates and `climate.js` do not rerun when you Shape,
shuffle the shape seed, or move a shape gene.

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

## Variants

**Variants** is a modal. Each card is a **name**: a thumb and status.
Saves that share that name stay on that card. Earlier snapshots are
that line's history; you can open one and the globe follows. Status is
**Active** (the checkout, never HEAD) and Layout or Shape. Cards do
not indent under each other.

A **variant** snapshot still has its own id. Artifacts
(`preview/<project>/v/<id>/`) belong to that id. A snapshot's Shape
sketch does not go stale: a later save is a different snapshot and
starts unshaped until you run Shape on it.

Every **Save** writes a **new snapshot**. Its id is UTC unix time.
Uncommitted work stays on the working planet until Save. Likes still
write **ranges** to the active snapshot without saving. Shape, and a
save with no new name, continue the active name. A new name is another
card; the previous name stays.

The catalog is **append-only**. Delete marks a snapshot (`deleted`).
The id stays. A badge offers **Undo**. A load merges disk with the
local cache by id; a write does the same. If the globe is a checkout
that is missing from the file, it is written back onto the list.

The name, not the seed or a parent pointer, decides which card a save
joins. The UI word is **Save**, never Update.

## Finish reads the sketch

Climate, Terrain, hydrology, and export consume the 23 km sketch on that
variant. They do not re-run Shape. Preview tiles may run earlier, still
keyed to the variant, so they do not follow you onto the next candidate.
