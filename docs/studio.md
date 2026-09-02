# How the studio works

Canonical for the **harness**: phases, the tree, and what a Save is. If
another doc disagrees about those, this one wins.

What each stage actually *does* is one file per stage — start at
[README.md](README.md). Language lives in [../CONTEXT.md](../CONTEXT.md).

## Two phases

**Discover** — Layout then Shape. Search, Save, iterate. The tree lives
here. The artifact is a **sketch** at the terrain model's grain (23 km
today).

**Finish** — Climate → Terrain → Carve → Export. Overnight and GPU
work on a variant you already kept. Not another place you shuffle.

Do not call Finish "the pipeline" or "the bake." The whole product is the
pipeline. Terrain is the bake. Finish is the phase.

Finish runs on a variant you already kept — whichever node you name.
There is no Adopt/Commit step. Earth has no variants.

## New project

The picker is **Projects**, then a workspace. **New project** is a real
step: name the world, then pick **body** buckets (size, age, day, water).
Each bucket is a named interval with a real body next to it. Picking
Small clamps radius; it does not write 3186. Gravity and tilt start at
Earth and are pinned until you free them.

Create writes `preview/<name>/project.json` with those buckets and no
**adopted body**. The globe is a **working planet** drawn from the
buckets. Explore samples the still-free body from that box. **Save**
writes a **variant** with its own body. The project can sit in that
state — accepted variants, size still in play.

An **adopted body** is later, and optional. It becomes the default for
new working planets. Old variants are not rewritten.

Earth is not created this way. It is the fixture on the picker.

Thalos and Earth stay shipped modules. A name that slugs to `thalos` or
`earth` is refused.

## Stages

| Stage | Phase | Done means | Doc |
| --- | --- | --- | --- |
| **Layout** | Discover | This variant's plates and continents are kept. | [layout.md](stages/layout.md) |
| **Shape** | Discover | Detail + later sculpting frozen as the sketch. | [shape.md](stages/shape.md) |
| **Climate** | Finish | Bake-time climate on that height (ExoPlaSim). Skip if the sketch keeps `climate.js`. | [climate.md](stages/climate.md) |
| **Terrain** | Finish | Whole-planet diffusion (cheap pass then 90 m). Cube faces and seams are internal. | [terrain.md](stages/terrain.md) |
| **Carve** | Finish | Rivers, fjords, and stamps on that DEM. Hydrology is the drainage work inside it. | [hydrology](stages/carve-hydrology.md), [landforms](stages/carve-landforms.md) |
| **Export** | Finish | Residual pyramid for the game. | [export.md](stages/export.md) |

Preview tiles are a Shape **tool**, not a stage. They read the sketch.
Pick them on the cubesphere grid, bake, drape. Cubesphere, conditioning,
and "coarse planet" are not stages. Layout has no tile picker.

There is no Progress panel. The UI flow *is* the progression: Layout,
then Shape. Those two are tabs. The Shape tab still runs Shape when the
variant has no sketch or the working planet is dirty.
A variant's place in the pipeline sits on that node in the tree — the
only place you read per-variant progress.

The current Discover stage **is** the globe. Layout is the 10k sim.
Shape is the sketch. The Shape tab is on only when that mesh is up —
not because a variant is marked shaped, and not because you clicked
the tab. Opening a shaped **head** loads the sketch; the Shape tab
comes on when the load is on the globe. **Save** writes an unshaped
**child**, so the globe returns to Layout. You can still return to
Layout to change plates; that work is uncommitted until **Save**. The
parent keeps its sketch. Finish is not something you browse to from
here.

The workspace shell is always: back to projects, the project name,
**Save**, and **Variants**. The globe and look stay on the canvas. Workspace chrome is Preact; the
canvases and generator are not.
The look bar is Surface, Relief, Climate, then Plates. Climate is the
moisture field on the same shaded globe as Surface. Plates opens Color
or Floor, plus Motion and Boundaries. Floor hides Boundaries. Tiles
appear on Surface after Shape.
**Measure** is a HUD tool. Click two points for the great-circle distance in kilometres. Click again to add a leg. Escape clears.
**Save** is a shell action on the working planet, not a control inside
the tree. The name field next to it shows the active variant. Save
continues that name. Change the name and Save starts another variant,
keeping the ranges you were on. Save never opens **Variants**. Layout's panel is the layout seed, **body** (with **pins**),
tectonics genes, `climate.js` genes, and Explore. Advanced folds
on Layout only: mesh `N`, shape spacing, jitter, the 1843 toggles —
shipped values, not genes. Shape's panel is the shape seed, shape genes
(warp, ridges, erosion, ice), and preview tiles.

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
The Layout tab is Layout of this variant. Lineage of earlier
saves sits on the card, not as a second variant. Shape reuses that
variant's layout: plates and `climate.js` do not rerun when you Shape,
shuffle the shape seed, or move a shape gene.

The Shape tab loads the cached sketch. An added story map still
loads: the old height stays, the new map is empty. A file this
generator cannot apply stays on disk. **Regenerate** reruns the pass
on this variant and replaces the cache. Same seed, same genes. It
does not write a new snapshot. A code change that does not touch the
file format still needs **Regenerate** if you want the new pass.

Save also writes the 10k sim onto that snapshot (`layout.json`).
Opening the card loads that cache. The recipe (layout seed, genes,
body) is how **Regenerate** remakes it. A later Layout-code change
does not rewrite saved plates. **Regenerate** on Layout reruns the
sim on this variant and replaces the cache. Same seed, same genes.
It does not write a new snapshot. If this variant had a sketch, that
sketch is dropped. It was sampled from the old plates.

Layout keeps the tectonic story Shape and Finish need, not only the
last height. Present strength is not enough: an extinct arc and an old
hotspot track must still be on the map after the volcanoes stop. Shape
reads those maps and adds 23 km features. A body here is at least two
cells. Shape already does coast warp, volcanic crests, belt grain, and
drainage texture. It also claims: young hotspot islands, old/weak arc
ribbons, plume-on-ridge plateaus, the forearc trough, drowned-margin
islands, ria inlets, and fracture-zone scars. Isolated 1-cell cones,
atolls, reefs, islets, and real fjords wait for **Carve**. A **feature
list** would name those edifices without putting them in height. Schema
open. See [shape.md § Open](stages/shape.md#open). Not Shape:
abyssal hills, a second continental-shelf pass, large lakes, rift
grabens. Finish reads the same maps on the sketch for stamps below that
grain in **Carve**. Each stage adds only what belongs at its scale. Do
not ask terrain-diffusion to invent a landform the sketch never marked.
The cached sketch stores those maps with the height, not height and
climate alone.

The current Layout handoff is compact maps: present strength, peak,
age since last refresh, and strike. Not a step log. Iceland plateaus
and drowned-margin islands are derived from those maps plus crust,
elevation, and the live boundary — no extra Layout field until a
picture fails. That set, and what **Carve** actually does, are still
open. Layout, Shape, and Carve will keep changing for realism.

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
(`preview/<project>/v/<id>/`) belong to that id. A snapshot's Layout
sim and Shape sketch do not go stale: a later save is a different
snapshot. The new snapshot starts with its own Layout cache. It is
unshaped until you run Shape on it.

Every **Save** writes a **new snapshot**. Its id is UTC unix time.
Uncommitted work stays on the working planet until Save. Likes still
write **ranges** to the active snapshot without saving. Shape, and a
save with no new name, continue the active name. A new name is another
card; the previous name stays.

On disk: the catalog is `preview/<project>/variants.json` and a
variant's folder is `preview/<project>/v/<id>/`. Layout's sim is
`layout.json` in that folder. The sketch is `shape.json`. Earth, and
a project with no variant yet, stay at `preview/<project>/` —
`preview/earth/`. Listing without a variant id does not walk `v/`.
User projects live at `preview/<name>/project.json`; Thalos and Earth
stay shipped modules.

The catalog is **append-only**. Delete marks a snapshot (`deleted`).
The id stays. A badge offers **Undo**. A load merges disk with the
local cache by id; a write does the same. If the globe is a checkout
that is missing from the file, it is written back onto the list.

The name, not the seed or a parent pointer, decides which card a save
joins. The UI word is **Save**, never Update.

## Finish reads the sketch

Climate, Terrain, Carve, and export consume the 23 km sketch on that
variant. They do not re-run Shape. Preview tiles run from Shape, still
keyed to the variant, so they do not follow you onto the next candidate.

The current bake is terrain-diffusion. That sprint is
[terrain.md](stages/terrain.md). A later Terrain would split into two
learned grains with Hydrology between them. That file is
[custom-model.md](custom-model.md). Finish stays one button on a kept
variant either way.

## Open

**Advanced needs another look.** Layout still folds mesh `N`, shape
spacing, jitter, and the 1843 path (live tectonics, merge ocean plates,
one world ocean) behind Advanced. Those toggles are mostly unused and
should likely go. They are shipped application values, not genes — the
1843 blend earns its place only as a comparison
([layout.md](stages/layout.md#the-1843-path)).

**Body buckets for activity and ice — open.** Initialize has size, age,
day, and water. Gravity and tilt start pinned. A later Finish wants
how active the crust is and how much ice there has been recently.
Genes already steer vigour. Do not add those buckets on this sprint.
See [custom-model.md](custom-model.md).

**Systems are a later harness grain.** A **system** is the star and the
**situation** of several **projects**. Not scheduled. Do not add a picker
layer or a system file for this. → [systems.md](systems.md)
