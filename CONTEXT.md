# planetgen

The studio that discovers one complete planet. The generator is shared; the work is choosing a world in **Discover**, then **Finish**ing one **variant**. How that works: [docs/studio.md](docs/studio.md).

## Language

**Project**:
The named world being made. A project is an evolutionary tree of **variants**, plus an optional **adopted body**. It does not hold a seed or a gene range box. During **initialize** it holds **body** buckets. Thalos is the one being discovered.
_Avoid_: World (the generated body), seed, preset, Earth (that is the fixture)

**Fixture**:
A locked known planet used to test shaping on a base whose tectonics are already known. Earth is the only one. It is not a tree: no **search**, no **variants**, no seed to shuffle. Authored knobs live in its file, not as pins. Layout and Shape still run; there is no Save, Variants, or Explore.
_Avoid_: Project, variant, Earth-like (the generator's goal)

**Body**:
The catalogue properties of a planet: radius, gravity, day length, tilt, age, and **water**. Each **variant** stores its own. Model knobs (cratons, climate rates, continent fraction) are not body.
_Avoid_: World params, planet settings

**Water**:
How full the ocean basin is. A **body** fact. Initialize as buckets (dry, Earth seas, ocean world). Dry share is an output, not a parameter.
_Avoid_: landFraction, sea level percentage, ocean fraction

**Adopted body**:
A **body** the **project** has chosen as the default for new **working planets**. Existing variants are not rewritten. A variant whose body differs is a fork. Not set during **initialize**.
_Avoid_: Pin (the old project-wide lock)

**Initialize**:
The start of a **project**. Name it, then pick **body** buckets (size, age, day, **water**). Buckets are **ranges**, not exact values. The project stores those buckets until an **adopted body** is set. Each generate is a **working planet**. **Save** writes a **variant** with its own body.
_Avoid_: Wizard, setup, new planet (say new project)

**Bucket**:
A named interval on a **body** parameter, shown with a real body next to it. Picking Small clamps radius; it does not write 3186.
_Avoid_: Preset, exact value

**Discover**:
Layout then Shape. Search, Save, iterate. The tree lives here. The artifact is the **sketch**.
_Avoid_: Pipeline, authoring (too vague), base

**Finish**:
Climate → Terrain → Carve → Export on a kept **variant**. Overnight and GPU work. Not a place you shuffle.
_Avoid_: Pipeline, bake (Terrain is the bake), production, export chain

**Layout**:
The 10k sim: plates, continents, `climate.js`. Search and shuffle run here. **Body**, tectonics genes, and climate genes live here. The Layout tab is this map. A **variant** that has not entered Shape opens here. You can return here to change plates; **Save** writes a child, the parent keeps its **sketch**. Layout owes Shape the tectonic story — where trenches, arcs, plumes, and belts are, and how old they are — not only a height field. It keeps the history those maps need. Each later stage adds only the features that belong at its grain.
_Avoid_: Base, coarse, tectonics (the module), branch (that is a child in the tree)

**Shape**:
Explicit pass on a saved **variant** that writes the **sketch**. Reads Layout's story. Writes 23 km features: coasts, island bodies, belt grain, drainage texture. A body here is at least two cells; one-cell cones wait for **Carve**. Shape seed, shape genes (warp, ridges, erosion, ice), later sculpting, preview tiles. Cached on that node. **Regenerate** reruns Shape and overwrites that cache. A child starts unshaped. The Shape tab is this map. It is on only while the sketch is on the globe.
_Avoid_: Detail pass, regional DEM, 23 km (that is the grain, not the stage), mode (as something you pick)

**Carve**:
Cuts and stamps on the baked DEM after **Terrain**: rivers, lakes, canyons, fjords, atolls, reefs, islets. **Hydrology** is the drainage work inside it.
_Avoid_: Landforms, post-diffusion, polish, hydrology (as the stage)

**Hydrology**:
Drainage on that DEM: rivers, lakes, canyons. Lives inside **Carve**. A consistency pass on already-eroded 90 m terrain, not a second landscape-evolution. How hard to cut is open; see [docs/carve-hydrology.md](docs/stages/carve-hydrology.md).
_Avoid_: Calling the Finish stage this; treating it as Shape's erosion run again

**Sketch**:
The height, climate, and Layout story maps at the terrain model's grain (23 km today). Discover writes it. Finish reads it — including maps later stamps still need. Spacing is a shipped value, not a gene.
_Avoid_: Conditioning, coarse map, DEM, height-only

**Layout seed**:
RNG key for plates and continents. Shuffle this → a **different planet**.
_Avoid_: The seed, planet seed (say layout seed)

**Shape seed**:
RNG key for warp, islands, ridges, first-stage erosion. Shuffle this → the **same planet**. Defaults to the layout seed until shuffled.
_Avoid_: Detail seed, the seed

**Variant**:
One saved snapshot of a **project**: layout seed, shape seed, **body**, gene draws, **pins**, **ranges**. Its id is a UTC unix time. Artifacts belong to that id. Only an explicit Save writes one. Two snapshots can share a layout seed and still be different saves. A node's sketch does not go stale — a later save is a different snapshot.
_Avoid_: Version, saved seed, keep, favourite, like, working planet

**Save**:
Write the working planet as a **new snapshot**. The name field next to Save shows the **variant** you are on — that is the line a Save continues. Change the name and Save starts another variant, keeping the **ranges** you were on.
_Avoid_: Update, commit, branch, fork (as the identity split)

**Delete**:
Mark a **variant** so it leaves the list. The snapshot stays. A badge offers Undo, which clears the mark.
_Avoid_: Drop, destroy, erase

**Same planet**:
Same **layout seed**. Shape iteration, gene moves, and sculpting stay on this planet. Still a new snapshot on Save. The name, not the seed, decides which card it joins.
_Avoid_: Generation, in-place update, same variant id

**Different planet**:
New **layout seed**, or an explore tile. Save is still a snapshot. Give it a new name if it is another variant.
_Avoid_: Branch, save as

**Fork**:
Not a catalog operation. A new name on Save is another variant. The previous name stays.
_Avoid_: Calling every Save a fork

**Lineage**:
The saves that share one **name**, in time order. The Variants panel shows one card per name. The latest save is the head (thumbnail and open target). Shape with no new name continues the active name.
_Avoid_: Showing every snapshot as its own variant, History (the tectonic sim), nesting by parent or seed

**Head**:
The **variant** currently checked out. Shuffle, edits, and opened explore
tiles stay on head as uncommitted work until **Save**. The UI
word is **Active**.
_Avoid_: Current, selected (ambiguous with search), HEAD (in the UI)

**Pin**:
A **body** value a saved **variant** has locked. Children inherit it. Genes are not pinned — a tight **range** is how a line stays near a gene. A pin does not rewrite siblings or the rest of the project.
_Avoid_: Setting, override, default, adopted body, gene lock

**Working planet**:
The globe on screen. Same recipe shape as a **variant**. Shuffle, edits, and opened explore tiles are uncommitted work on **head** until Save.
_Avoid_: Unsaved seed, draft project, unsaved variant

**Range**:
The interval a still-free parameter may be drawn from. Stored on a **variant**. Search from that variant starts in its box. A **pin** removes that **body** parameter from the draw. A gene is constrained here, not by a pin. Layout search draws layout genes. Shape genes are sliders on the working planet, not a second sheet.
_Avoid_: Overlay, gene box, project character

**Like**:
A search-tile mark that reshapes the current **ranges** as you go and writes that box to the selected **variant**. It is not a save of the planet.
_Avoid_: Favourite, upvote, save

**Search**:
A sheet of **working planets** drawn from the selected **variant**: its **ranges**, minus its **pins**, starting from its **body**. Layout only. There is no Shape sheet — iterate Shape on the globe. Likes update those ranges on the variant immediately. Opening or saving a tile is a **different planet**. Earth has no search. The UI word is **Explore**.
_Avoid_: Shuffle (that only changes the layout seed), Shape search

**Refinement**:
How tight a **variant**'s **ranges** are versus the vouched intervals. That number sits on the node. What changed versus the parent sits on the edge. Siblings may differ — one line was searched longer. Read it off the stored box; do not store a separate score.
_Avoid_: Fitness, generation count, search depth

**Pipeline**:
Discover then Finish. Stages are Layout, Shape, Climate, Terrain, Carve, Export. The UI flow is that order. Preview tiles are a tool, not a stage.
_Avoid_: Build, export chain, cubesphere, regional DEM, coarse planet, conditioning, base (as a stage), Progress (as a workspace panel)

**Progress**:
Where a **variant** sits in the **pipeline**. Shown on that node in the tree. Not a workspace panel. Discover's screens are the flow.
_Avoid_: Pipeline widget, stage list, sidebar rows

## Flagged ambiguities

**Seed** is two keys. **Layout seed** is the planet identity. **Shape seed** is coasts. A variant includes both and is more than a seed. Do not say "save this seed" when you mean save a variant.

**Sketch** is not height alone. Finish still needs Layout's story maps (old tracks, extinct arcs) or later stamps have nowhere to go.

**The pipeline is not frozen.** Layout, Shape, **Carve**, and the rest will keep changing for realism. Compact story maps (present, peak, age, strike) are the current handoff, not a lock. Iceland and drowned-margin islands are derived from those maps plus crust and the live boundary; do not add a fifth Layout field until a picture fails.

**Base** is this repo's job (the generator), not a pipeline stage. The Discover stages are **Layout** and **Shape**.

**landFraction** is not a parameter. It was a post-hoc sea-level shift to hit a dry percentage. Author **water** and **continentFraction** instead; judge the dry share from the picture.

**continentFraction** is a gene: how much thick crust formed, not how much of it is dry.

**A generate is not a variant.** It has the same recipe shape, but it is a **working planet** until Save. Do not call the fleeting globe a variant.

## Example

— Thalos has three saved variants and no adopted body yet. Is that the planet?
— No. That is the **project** still initializing. Each **variant** already has its own **body**.

— I liked three tiles and kept two. Are those the same?
— No. The likes reshape the **ranges** on the current variant as you go. The two you saved are snapshots. Give a new name if that planet is another variant.

— One save looks barely narrowed and another is a sliver. Is that a bug?
— No. **Refinement** is per snapshot.

— I shuffled, tweaked tilt, shuffled again, and hit Save. What is in the catalog?
— The globe as it stood at Save. The in-between rerolls were uncommitted.

— I changed tilt on this layout seed and hit Save, no new name. What happened?
— Save wrote a new snapshot. The card keeps the name. The previous save is that line's history.

— I shuffled the shape seed and hit Save. What happened?
— A new snapshot under the same name. Layout did not rerun.

— I opened an older save on this line and hit Save. What happened?
— Another snapshot of that name. It is the new head.

— I named a save while standing on **interesting**. What happened?
— If the name is **interesting**, that line continues. If the name is new, that variant appears and **interesting** stays.

— I opened an older variant, liked a new seed, and named it. What happened?
— Explore is a **different planet**. The name labels that variant.

— I saved from a variant whose radius is pinned. What radius does it have?
— The pins on that snapshot. A pin is not a project rewrite.

— If I change radius on the working planet, do the old variants change?
— No. Each snapshot keeps the body it was saved with. Their bakes stay valid.

— I named a project, picked Small and Dry, and hit Create. What is in the file?
— The **project**: that name and those **buckets**. No **adopted body** yet. The globe is a **working planet** drawn from the buckets.

— I want an ocean world. Do I set land fraction to 5%?
— No. That is **water**: drowned. Land fraction is not a parameter.

— When do we run the 90 m bake?
— In **Finish**, on the variant you name. Preview tiles can run earlier, per variant, so they do not follow you onto the next candidate.

— Is Earth a root variant of a project?
— No. Earth is the **fixture**. We know its tectonics; it exists so shaping can be tested on that base.
