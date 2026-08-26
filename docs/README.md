# planetgen docs

```
docs/
  studio.md    the harness: Discover/Finish, projects, variants, what a Save is
  stages/      one file per pipeline stage — the research lives here
  ref/         stable lookup: external tools and formats
  history/     decisions as they were made, dated, never updated
```

Language — every term and what not to call it — is
[../CONTEXT.md](../CONTEXT.md).

## The pipeline

The generator is a **pipeline of stages**. Each stage owns one grain,
reads what the stage before it handed on, and hands on something the next
stage can use. Most of the work in this project is deepening one stage, or
widening the contract between two.

```
Layout    ~10k cells        plates, continents, tectonic history
  ↓
Shape     23 km sketch      coasts, islands, belt grain, drainage texture
  ↓
Climate   23 km fields      temperature, moisture, seasonality
  ↓
Terrain   90 m DEM          terrain-diffusion, per cubesphere face
  ↓
Carve     90 m DEM          drainage, then sub-23 km stamps
  ↓
Export    residual pyramid  what the game installs
  ↓
(runtime) ~0.5 m            analytic octaves, never baked
```

**Discover** is Layout and Shape — search, save, iterate. **Finish** is
Climate through Export — overnight and GPU work on a variant you kept.

| Stage | Grain | State | Doc |
| --- | --- | --- | --- |
| Layout | ~10k cells (~113 km on Thalos) | Live, improving | [stages/layout.md](stages/layout.md) |
| Shape | 23 km/px sketch | Live, improving | [stages/shape.md](stages/shape.md) |
| Climate | 23 km fields | Live heuristic; bake tier untried | [stages/climate.md](stages/climate.md) |
| Terrain | 90 m/px | Regional tiles work; planet scale open | [stages/terrain.md](stages/terrain.md) |
| Carve — hydrology | 90 m/px | Not started; method open | [stages/carve-hydrology.md](stages/carve-hydrology.md) |
| Carve — landforms | 90 m/px | Not started | [stages/carve-landforms.md](stages/carve-landforms.md) |
| Export | sparse pyramid | Schema decided; bake unwritten | [stages/export.md](stages/export.md) |

If you are working on a stage, you should not have to read another
stage's file to know what you are allowed to do.

## How a stage doc is laid out

Seven sections, same order, every file:

1. **What it does** — the job, and at what grain.
2. **Reads** — what it takes from upstream, what it does with it, and
   **what it wishes it had**. That last list is the research backlog for
   the *upstream* stage, discovered here.
3. **Hands on** — the contract. Authoritative: if you add a field, add a
   row. Downstream stages link here rather than restating it.
4. **Must not regress** — invariants, and the things that were tried and
   reverted. Do not delete a line here without a picture that says why.
5. **How it works today** — the mechanism.
6. **Open** — unresolved questions, measured dead ends, what to try next.
7. **How to judge it** — the capture, the command, what you are looking
   for.

Sections 2 and 3 are what make the pipeline improve. A stage gets better
mostly by being handed more context, not by being tuned: Layout began
emitting history maps because Shape's wishes list asked for them. **When
a wish is granted it becomes a row in section 3 upstream** — move it, do
not leave it in both places.

Section 6 is the point of this repo. Almost every stage is open. A doc
that reads as finished is either wrong or about Export.

`bun run check:docs` holds all of that: links and anchors resolve,
contract tables match the field lists in the code, every stage has its
seven sections. It also prints the open wishes across the pipeline.

**One file per stage, until it earns a folder.** When a stage's open
questions each grow their own working notes, promote that stage —
`stages/layout.md` becomes `stages/layout/README.md` with siblings beside
it, and §6 links down to them. Sections 3 and 4 never leave the front
page: the contract and the invariants stay where every other doc points
at them. Do not promote a stage before it needs it.

## Status words

Used in every stage doc, and they mean this:

- **decided** — settled. Reopen only with a picture that says why.
- **recommended** — researched, needs one trial before committing.
- **open** — known problem, no chosen answer.
