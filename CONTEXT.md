# planetgen

The studio that discovers one complete planet. The generator is shared; the work is choosing a world and then one candidate of that world to take through the expensive pipeline.

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

**Variant**:
A saved candidate of a **project**: a seed, a **body**, gene draws, **pins**, **ranges**, and a parent. Artifacts belong to that variant. Only an explicit Save writes one. Two variants can share a seed and still be different planets.
_Avoid_: Saved seed, keep, favourite, like, working planet

**Lineage**:
The parent link between saved **variants**. Save from a variant adds a child. The catalog is this tree, not a list. The tree is the history of saves, not of rerolls.
_Avoid_: History (the tectonic sim), undo, variant list

**Pin**:
A **body** value a saved **variant** has locked. Children inherit it. Genes are not pinned — a tight **range** is how a branch stays near a gene. A pin does not rewrite siblings or the rest of the project.
_Avoid_: Setting, override, default, adopted body, gene lock

**Working planet**:
The globe on screen. Same recipe shape as a **variant**, but it is not in the tree. Rerolls and edits die unless you Save.
_Avoid_: Unsaved seed, draft project, unsaved variant

**Range**:
The interval a still-free parameter may be drawn from. Stored on a **variant**. Search from that variant starts in its box. A **pin** removes that **body** parameter from the draw. A gene is constrained here, not by a pin.
_Avoid_: Overlay, gene box, project character

**Like**:
A search-tile mark that steers the next generation of the current **search** session. It does not write the selected **variant**. It is not a save.
_Avoid_: Favourite, upvote, save

**Search**:
A sheet of **working planets** drawn from the selected **variant**: its **ranges**, minus its **pins**, starting from its **body**. Likes reshape the session box only. Save writes a child with that tile's recipe and the session's current ranges. The parent does not move. Earth has no search.
_Avoid_: Shuffle (that only changes the seed)

**Refinement**:
How tight a **variant**'s **ranges** are versus the vouched intervals. That number sits on the node. What changed versus the parent sits on the edge. Siblings may differ — one branch was searched longer. Read it off the stored box; do not store a separate score.
_Avoid_: Fitness, generation count, search depth

**Commit**:
Choosing one **variant** as the project's planet so the expensive pipeline stages run on that instance. Commit does not pin every remaining gene.
_Avoid_: Pin, bake, export

**Pipeline**:
The stages from the coarse base to the raw bake export. Cheap, repeatable stages run per **variant**. Expensive stages run after **commit**.
_Avoid_: Build, export chain

## Flagged ambiguities

**Seed** is the RNG key of one generate, not a saved planet. A variant includes a seed and is more than a seed. Do not say "save this seed" when you mean save a variant.

**Base** is both the first pipeline stage and "this repo's job." The stage is the coarse plates / heightmap / climate. The repo is also the studio that owns projects and variants.

**landFraction** is not a parameter. It was a post-hoc sea-level shift to hit a dry percentage. Author **water** and **continentFraction** instead; judge the dry share from the picture.

**continentFraction** is a gene: how much thick crust formed, not how much of it is dry.

**A generate is not a variant.** It has the same recipe shape, but it is a **working planet** until Save. Do not call the fleeting globe a variant.

## Example

— Thalos has three saved variants and no adopted body yet. Is that the planet?
— No. That is the **project** still initializing. Each **variant** already has its own **body**.

— I liked three tiles and kept two. Are those the same?
— No. The likes reshape the **search** session only. The two you saved are children; the parent still has the box it was saved with.

— One child looks barely narrowed and another is a sliver. Is that a bug?
— No. **Refinement** is per variant. The tree is how you see the asymmetry.

— I shuffled, tweaked tilt, shuffled again, and hit Save. What is in the tree?
— One **variant**: the globe as it stood at Save. The rerolls never existed.

— I saved a child from a variant whose radius is pinned. What radius does it have?
— The parent's. That **pin** is **lineage**, not a project rewrite.

— If I change radius on the working planet, do the old variants change?
— No. Each variant keeps the body it was saved with. Their bakes stay valid.

— I want an ocean world. Do I set land fraction to 5%?
— No. That is **water**: drowned. Land fraction is not a parameter.

— When do we run the 90 m bake?
— After **commit**. Preview crops can run earlier, per variant, so they do not follow you onto the next candidate.

— Is Earth a root variant of a project?
— No. Earth is the **fixture**. We know its tectonics; it exists so shaping can be tested on that base.
