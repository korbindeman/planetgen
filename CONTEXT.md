# planetgen

The studio that discovers one complete planet. The generator is shared; the work is choosing a world in **Discover**, then **Finish**ing one **variant**. How that works: [docs/studio.md](docs/studio.md).

## Language

**Project**:
The named world being made. A project is an evolutionary tree of **variants**, plus an optional **adopted body**. It does not hold a seed or a range box. Thalos is the one being discovered.
_Avoid_: World (the generated body), seed, preset, Earth (that is the fixture)

**Fixture**:
A locked known planet used to test shaping on a base whose tectonics are already known. Earth is the only one. It is not a tree: no **search**, no **variants**, no seed to shuffle. Authored knobs live in its file, not as pins.
_Avoid_: Project, variant, Earth-like (the generator's goal)

**Body**:
The catalogue properties of a planet: radius, gravity, day length, tilt, age, and **water**. Each **variant** stores its own. Model knobs (cratons, climate rates, continent fraction) are not body.
_Avoid_: World params, planet settings

**Water**:
How full the ocean basin is. A **body** fact. Initialize as buckets (dry, Earth seas, ocean world). Dry share is an output, not a parameter.
_Avoid_: landFraction, sea level percentage, ocean fraction

**Adopted body**:
A **body** the **project** has chosen as the default for new **working planets**. Existing variants are not rewritten. A variant whose body differs is a fork.
_Avoid_: Pin (the old project-wide lock)

**Discover**:
Layout then Shape. Search, Save, iterate. The tree lives here. The artifact is the **sketch**.
_Avoid_: Pipeline, authoring (too vague), base

**Finish**:
Climate → Terrain → Hydrology → Export on a kept **variant**. Overnight and GPU work. Not a place you shuffle.
_Avoid_: Pipeline, bake (Terrain is the bake), production, export chain

**Layout**:
The 10k sim: plates, continents, `climate.js`. Search and shuffle run here only until Shape is asked for.
_Avoid_: Base, coarse, tectonics (the module)

**Shape**:
Explicit pass on a saved **variant** that writes the **sketch**. Shape seed, shape genes, later sculpting. Cached on that node. A child starts unshaped.
_Avoid_: Detail pass, regional DEM, 23 km (that is the grain, not the stage)

**Sketch**:
The height (+ climate channels) at the terrain model's grain (23 km today). Discover writes it. Finish reads it. Spacing is a shipped value, not a gene.
_Avoid_: Conditioning, coarse map, DEM

**Layout seed**:
RNG key for plates and continents. Shuffle this → a **different planet**.
_Avoid_: The seed, planet seed (say layout seed)

**Shape seed**:
RNG key for warp, islands, ridges, first-stage erosion. Shuffle this → the **same planet**. Defaults to the layout seed until shuffled.
_Avoid_: Detail seed, the seed

**Variant**:
One saved snapshot of a **project**: layout seed, shape seed, **body**, gene draws, **pins**, **ranges**, parent. Artifacts belong to that id. Only an explicit Save writes one. Every Save is a new node, child of **head**. Two variants can share a layout seed and still be different snapshots. A node's sketch does not go stale — a child is a different snapshot.
_Avoid_: Saved seed, keep, favourite, like, working planet, commit (that is Adopt)

**Save**:
Write the working planet as a **new node**, child of **head**. A new **layout seed** or an explore tile is a **different planet**; layout genes, shape seed, shape genes, sculpting, body, and a name stay the **same planet**. A name labels the node; it is not what makes a child.
_Avoid_: Update, commit, branch (the identity split is same vs different planet)

**Same planet**:
Same **layout seed**. Shape iteration, gene moves, and sculpting stay on this planet. Still a new tree node on Save.
_Avoid_: Generation, in-place update, same variant id

**Different planet**:
New **layout seed**, or an explore tile. Save is still a child. **Commit** does not follow.
_Avoid_: Branch (except as "child in the tree"), fork, save as

**Lineage**:
The parent link between saved **variants**. The catalog is this tree, not a list. See **Save**. What changed versus the parent sits on the edge.
_Avoid_: History (the tectonic sim), undo, variant list

**Head**:
The **variant** currently checked out. Shuffle, edits, and opened explore
tiles stay on head as uncommitted work until **Save**. Head is not the
**commit** unless that save was the first version on that line.
_Avoid_: Current, selected (ambiguous with search)

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
A sheet of **working planets** drawn from the selected **variant**: its **ranges**, minus its **pins**, starting from its **body**. Layout only. There is no Shape sheet — iterate Shape on the globe. Likes update those ranges on the variant immediately. Opening or saving a tile is a **different planet**. Earth has no search.
_Avoid_: Shuffle (that only changes the layout seed), Shape search

**Refinement**:
How tight a **variant**'s **ranges** are versus the vouched intervals. That number sits on the node. What changed versus the parent sits on the edge. Siblings may differ — one line was searched longer. Read it off the stored box; do not store a separate score.
_Avoid_: Fitness, generation count, search depth

**Commit**:
Choosing one **variant** as the project's planet so **Finish** runs on that instance. The UI word is **Adopt**. Commit does not pin every remaining gene. Not a Save.
_Avoid_: Pin, bake, export, Save

**Pipeline**:
Discover then Finish. Progress lists Layout, Shape, Climate, Terrain, Hydrology, Export. Preview tiles are a tool, not a stage.
_Avoid_: Build, export chain, cubesphere, regional DEM, coarse planet, conditioning, base (as a stage)

## Flagged ambiguities

**Seed** is two keys. **Layout seed** is the planet identity. **Shape seed** is coasts. A variant includes both and is more than a seed. Do not say "save this seed" when you mean save a variant.

**Base** is this repo's job (the generator), not a Progress stage. The Discover stages are **Layout** and **Shape**.

**landFraction** is not a parameter. It was a post-hoc sea-level shift to hit a dry percentage. Author **water** and **continentFraction** instead; judge the dry share from the picture.

**continentFraction** is a gene: how much thick crust formed, not how much of it is dry.

**A generate is not a variant.** It has the same recipe shape, but it is a **working planet** until Save. Do not call the fleeting globe a variant.

**Commit** is Adopt-for-Finish, not a Save. Do not call a tree node a commit.

## Example

— Thalos has three saved variants and no adopted body yet. Is that the planet?
— No. That is the **project** still initializing. Each **variant** already has its own **body**.

— I liked three tiles and kept two. Are those the same?
— No. The likes reshape the **ranges** on the current variant as you go. The two you saved are **children** — each tile is a **different planet**.

— One child looks barely narrowed and another is a sliver. Is that a bug?
— No. **Refinement** is per variant. The tree is how you see the asymmetry.

— I shuffled, tweaked tilt, shuffled again, and hit Save. What is in the tree?
— A child: the globe as it stood at Save, a **different planet** from the version you shuffled from. The in-between rerolls were uncommitted.

— I changed tilt on this layout seed and hit Save, no new name. What happened?
— Save wrote a child of **head**. **Same planet**. The parent still has its own sketch, if it had one.

— I shuffled the shape seed and hit Save. What happened?
— A child, **same planet**. Layout did not rerun. The new node needs Shape run (or you ran it before Save).

— I opened an older version, liked a new seed, and named it. What happened?
— Explore is a **different planet**. The name labels that child. **Head** moves there. The adopted **commit** stays.

— I saved a child from a variant whose radius is pinned. What radius does it have?
— The parent's. That **pin** is **lineage**, not a project rewrite.

— If I change radius on the working planet, do the old variants change?
— No. Each variant keeps the body it was saved with. Their bakes stay valid.

— I want an ocean world. Do I set land fraction to 5%?
— No. That is **water**: drowned. Land fraction is not a parameter.

— When do we run the 90 m bake?
— In **Finish**, after **commit**. Preview tiles can run earlier, per variant, so they do not follow you onto the next candidate.

— Is Earth a root variant of a project?
— No. Earth is the **fixture**. We know its tectonics; it exists so shaping can be tested on that base.
