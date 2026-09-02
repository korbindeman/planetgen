# planetgen — the words

The studio that discovers one complete planet. The generator is shared;
the work is choosing a world in **Discover**, then **Finish**ing one
**variant**.

This file owns the **vocabulary**: what each thing is called, and what not
to call it. It does not own mechanics. How the stages work is
[docs/README.md](docs/README.md); how the studio around them works is
[docs/studio.md](docs/studio.md). If you want to know what a stage *does*,
follow the pointer — do not grow the entry here.

## Pipeline words

**Pipeline**:
Discover then Finish. The stages are Layout, Shape, Climate, Terrain,
Carve, Export, and the UI flow is that order. Preview tiles are a tool,
not a stage. → [docs/README.md](docs/README.md)
_Avoid_: Build, export chain, cubesphere, regional DEM, coarse planet, conditioning, base (as a stage), Progress (as a workspace panel)

**Discover**:
Layout then Shape. Search, Save, iterate. The tree lives here. The
artifact is the **sketch**.
_Avoid_: Pipeline, authoring (too vague), base

**Finish**:
Climate → Terrain → Carve → Export on a kept **variant**. Overnight and
GPU work. Not a place you shuffle.
_Avoid_: Pipeline, bake (Terrain is the bake), production, export chain

**Layout**:
The 10k sim: plates, continents, `climate.js`. Search and shuffle run
here. It owes Shape the tectonic story, not only a height field.
→ [docs/stages/layout.md](docs/stages/layout.md)
_Avoid_: Base, coarse, tectonics (the module), branch (that is a child in the tree)

**Shape**:
Explicit cached pass on a saved **variant** that writes the **sketch** at
23 km. A body here is at least two cells.
→ [docs/stages/shape.md](docs/stages/shape.md)
_Avoid_: Detail pass, regional DEM, 23 km (that is the grain, not the stage), mode (as something you pick)

**Climate**:
Temperature and moisture as fields. `climate.js` runs in Layout; the
bake-time tier is the Finish stage.
→ [docs/stages/climate.md](docs/stages/climate.md)
_Avoid_: Weather, biomes (those are a read of climate, not the stage)

**Terrain**:
The bake. Today that is whole-planet diffusion, cheap pass then 90 m,
per cubesphere face. A later Terrain would be two learned grains with
**Hydrology** between them. → [docs/stages/terrain.md](docs/stages/terrain.md),
[docs/custom-model.md](docs/custom-model.md)
_Avoid_: Diffusion (as the stage name), tiles, conditioning, Finish,
calling terrain-diffusion the custom model

**Carve**:
Cuts and stamps on the baked DEM after **Terrain**: rivers, lakes,
canyons, fjords, atolls, reefs, islets.
→ [hydrology](docs/stages/carve-hydrology.md), [landforms](docs/stages/carve-landforms.md)
_Avoid_: Landforms, post-diffusion, polish, hydrology (as the stage)

**Hydrology**:
The drainage work *inside* **Carve**. Today that is a consistency pass
on already-eroded 90 m terrain, after Terrain. A later Terrain would
route at 1 km and make those rivers law for the 90 m residual.
→ [docs/stages/carve-hydrology.md](docs/stages/carve-hydrology.md),
[docs/custom-model.md](docs/custom-model.md)
_Avoid_: Calling the Finish stage this; treating it as Shape's erosion
run again; putting rivers before the 90 m pass while terrain-diffusion
is the bake

**Export**:
The sparse residual pyramid the game installs. Not the bake.
→ [docs/stages/export.md](docs/stages/export.md)
_Avoid_: Ship, package (the game side owns that word), the bake

**Sketch**:
The height, climate, and Layout story maps at the terrain model's grain
(23 km today). Discover writes it; Finish reads it. A **feature list**
would sit here too. Spacing is a shipped value, not a gene.
→ [docs/stages/shape.md](docs/stages/shape.md#hands-on)
_Avoid_: Conditioning, coarse map, DEM, height-only

**Feature list**:
Discrete edifices too small for a sketch cell: hotspot volcanoes, arc
volcanoes, reef platforms, seamounts. Shape would write it. Height
still drops one-cell cones. Not built.
→ [docs/stages/shape.md](docs/stages/shape.md#open)
_Avoid_: Island layer, stamp list, raising these into `r_meters`,
calling the story maps a feature list

**Custom model**:
A later **Terrain**: two learned grains with **Hydrology** between
them. Not built. The current bake is terrain-diffusion.
→ [docs/custom-model.md](docs/custom-model.md)
_Avoid_: Calling terrain-diffusion this; renaming Terrain; calling
Finish this

**Progress**:
Where a **variant** sits in the **pipeline**. Shown on that node in the
tree. Not a workspace panel — Discover's screens are the flow.
_Avoid_: Pipeline widget, stage list, sidebar rows

## Studio words

**Project**:
The named world being made: an evolutionary tree of **variants**, plus an
optional **adopted body**. It does not hold a seed or a gene range box.
Thalos is the one being discovered. → [docs/studio.md](docs/studio.md)
_Avoid_: World (the generated body), seed, preset, Earth (that is the fixture), system (that is several bodies)

**System**:
The star and the **situation** of each **project** in it. Several bodies
share one. Not built. → [docs/systems.md](docs/systems.md)
_Avoid_: Galaxy, universe, world (the generated body), calling the system a project, putting star class on a variant

**Situation**:
Where a body sits: parent and orbit. Derives flux, year, and whether the
body is locked. Would live with the project, not as a gene. Not built.
→ [docs/systems.md](docs/systems.md)
_Avoid_: Body (that is the rock), orbit as a gene, star class on the variant

**Fixture**:
A locked known planet used to test shaping on a base whose tectonics are
already known. Earth is the only one, and it is not a tree: no **search**,
no **variants**, no seed to shuffle.
_Avoid_: Project, variant, Earth-like (the generator's goal)

**Initialize**:
The start of a **project**: name it, then pick **body** buckets. The
project stores those buckets until an **adopted body** is set.
_Avoid_: Wizard, setup, new planet (say new project)

**Bucket**:
A named interval on a **body** parameter, shown with a real body next to
it. Picking Small clamps radius; it does not write 3186.
_Avoid_: Preset, exact value

**Body**:
The catalogue properties of a planet: radius, gravity, day length, tilt,
age, and **water**. Each **variant** stores its own. Model knobs
(cratons, climate rates, continent fraction) are not body.
_Avoid_: World params, planet settings, situation (that is where it sits)

**Water**:
How full the ocean basin is. A **body** fact. Dry share is an output, not
a parameter.
_Avoid_: landFraction, sea level percentage, ocean fraction

**Adopted body**:
A **body** the **project** has chosen as the default for new **working
planets**. Existing variants are not rewritten. Not set during
**initialize**.
_Avoid_: Pin (the old project-wide lock)

**Layout seed**:
RNG key for plates and continents. Shuffle this → a **different planet**.
_Avoid_: The seed, planet seed (say layout seed)

**Shape seed**:
RNG key for warp, islands, ridges, first-stage erosion. Shuffle this →
the **same planet**. Defaults to the layout seed until shuffled.
_Avoid_: Detail seed, the seed

**Variant**:
One saved snapshot of a **project**: layout seed, shape seed, **body**,
gene draws, **pins**, **ranges**, and the stage data on the globe
(Layout's sim, then the Shape **sketch** if it has run). Its id is a
UTC unix time. Artifacts belong to that id. Only an explicit Save
writes one.
_Avoid_: Version, saved seed, keep, favourite, like, working planet

**Save**:
Write the working planet as a **new snapshot**. The name field shows the
variant you are on — that is the line a Save continues.
_Avoid_: Update, commit, branch, fork (as the identity split)

**Delete**:
Mark a **variant** so it leaves the list. The snapshot stays, and a badge
offers Undo.
_Avoid_: Drop, destroy, erase

**Head**:
The **variant** currently checked out. The UI word is **Active**.
_Avoid_: Current, selected (ambiguous with search), HEAD (in the UI)

**Lineage**:
The saves that share one **name**, in time order. The Variants panel
shows one card per name; the latest save is the head.
_Avoid_: Showing every snapshot as its own variant, History (the tectonic sim), nesting by parent or seed

**Look**:
How the globe is coloured. Surface, Relief, and Climate are shaded
reads of the planet. Plates is a diagram. Its paints are Color and
**Floor**. Motion and Boundaries are Plates layers.
_Avoid_: Overlay (as the bar), view mode (that is globe vs map), Crust (as a look)

**Floor**:
The Plates paint for sea-floor age and boundary type. The sim still
says crust.
_Avoid_: Crust (in the look bar)

**Working planet**:
The globe on screen. Same recipe shape as a **variant**, but uncommitted
work on **head** until Save.
_Avoid_: Unsaved seed, draft project, unsaved variant

**Same planet**:
Same **layout seed**. Shape iteration, gene moves and sculpting stay on
this planet. Still a new snapshot on Save.
_Avoid_: Generation, in-place update, same variant id

**Different planet**:
New **layout seed**, or an explore tile. Give it a new name if it is
another variant.
_Avoid_: Branch, save as

**Fork**:
Not a catalog operation. A new name on Save is another variant; the
previous name stays.
_Avoid_: Calling every Save a fork

**Pin**:
A **body** value a saved **variant** has locked. Children inherit it.
Genes are not pinned — a tight **range** is how a line stays near a gene.
_Avoid_: Setting, override, default, adopted body, gene lock

**Range**:
The interval a still-free parameter may be drawn from. Stored on a
**variant**. A **pin** removes that **body** parameter from the draw; a
gene is constrained here instead.
_Avoid_: Overlay, gene box, project character

**Search**:
A sheet of **working planets** drawn from the selected **variant**.
Layout only — there is no Shape sheet. The UI word is **Explore**.
_Avoid_: Shuffle (that only changes the layout seed), Shape search

**Like**:
A search-tile mark that reshapes the current **ranges** as you go. It is
not a save of the planet.
_Avoid_: Favourite, upvote, save

**Refinement**:
How tight a **variant**'s **ranges** are versus the vouched intervals.
Read it off the stored box; do not store a separate score.
_Avoid_: Fitness, generation count, search depth

## Flagged ambiguities

**Seed** is two keys. **Layout seed** is the planet identity. **Shape seed** is coasts. A variant includes both and is more than a seed. Do not say "save this seed" when you mean save a variant.

**Sketch** is not height alone. Finish still needs Layout's story maps (old tracks, extinct arcs) or later stamps have nowhere to go.

**Base** is this repo's job (the generator), not a pipeline stage. The Discover stages are **Layout** and **Shape**.

**landFraction** is not a parameter. It was a post-hoc sea-level shift to hit a dry percentage. Author **water** and **continentFraction** instead; judge the dry share from the picture.

**continentFraction** is a gene: how much thick crust formed, not how much of it is dry.

**A generate is not a variant.** It has the same recipe shape, but it is a **working planet** until Save. Do not call the fleeting globe a variant.

**The pipeline is not frozen.** Layout, Shape, **Carve** and the rest will keep changing for realism. Every stage doc has an **Open** section, and that is where the argument belongs.

**A system is not a project.** Several bodies share a star. Each body is still its own project. That grain is a vision. → [docs/systems.md](docs/systems.md)

**The feature list is not height.** One-cell cones stay dropped from `r_meters`. Carve and a later Terrain read the list.

**Two Terrain orders.** The current bake is 23 km → 90 m, then Carve. A later Terrain routes water at 1 km between two learned grains. Those orders must not share one stage doc. → [docs/custom-model.md](docs/custom-model.md)

## Example

— Thalos has three saved variants and no adopted body yet. Is that the planet?
— No. That is the **project** still initializing. Each **variant** already has its own **body**.

— I liked three tiles and kept two. Are those the same?
— No. The likes reshape the **ranges** on the current variant as you go. The two you saved are snapshots. Give a new name if that planet is another variant.

— One save looks barely narrowed and another is a sliver. Is that a bug?
— No. **Refinement** is per snapshot.

— I shuffled, tweaked tilt, shuffled again, and hit Save. What is in the catalog?
— The globe as it stood at Save. The in-between rerolls were uncommitted.

— I named a save while standing on **interesting**. What happened?
— If the name is **interesting**, that line continues. If the name is new, that variant appears and **interesting** stays.

— I opened an older variant, liked a new seed, and named it. What happened?
— Explore is a **different planet**. The name labels that variant.

— I saved from a variant whose radius is pinned. What radius does it have?
— The pins on that snapshot. A pin is not a project rewrite.

— If I change radius on the working planet, do the old variants change?
— No. Each snapshot keeps the body it was saved with. Their bakes stay valid.

— I want an ocean world. Do I set land fraction to 5%?
— No. That is **water**: drowned. Land fraction is not a parameter.

— I made a homeworld and a moon. Are those two variants?
— No. They would be two **projects** that share a **system**. Each has its own variants. That grain is not built.

— When do we run the 90 m bake?
— In **Finish**, on the variant you name. Preview tiles can run earlier, per variant, so they do not follow you onto the next candidate.

— Is Earth a root variant of a project?
— No. Earth is the **fixture**. We know its tectonics; it exists so shaping can be tested on that base.
