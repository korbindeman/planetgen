# planetgen docs

```
docs/
  studio.md    the harness: Discover/Finish, projects, variants, what a Save is
  stages/      one file per pipeline stage
  ref/         lookup for external tools and formats
  history/     dated decisions. Do not update these files
```

Language — every term, and what not to call it — is
[../CONTEXT.md](../CONTEXT.md).

## The pipeline

The generator is a **pipeline of stages**. Each stage owns one grain.
Each stage reads what the stage before it handed on. Then it hands on
data that the next stage can use.

Most work in this project deepens one stage, or widens the contract
between two stages.

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

**Discover** is Layout and Shape. Search, save, iterate. **Finish** is
Climate through Export. Overnight and GPU work on a variant you kept.

| Stage | Grain | State | Doc |
| --- | --- | --- | --- |
| Layout | ~10k cells (~113 km on Thalos) | Live | [stages/layout.md](stages/layout.md) |
| Shape | 23 km/px sketch | Live | [stages/shape.md](stages/shape.md) |
| Climate | 23 km fields | Live heuristic. Bake-time GCM not tried | [stages/climate.md](stages/climate.md) |
| Terrain | 90 m/px | Regional tiles work. Planet-scale bake not built | [stages/terrain.md](stages/terrain.md) |
| Carve — hydrology | 90 m/px | Not started. Method open | [stages/carve-hydrology.md](stages/carve-hydrology.md) |
| Carve — landforms | 90 m/px | Not started | [stages/carve-landforms.md](stages/carve-landforms.md) |
| Export | sparse pyramid | Schema decided. Bake not written | [stages/export.md](stages/export.md) |

You should not have to read another stage file to know what you can do in
this stage.

## How a stage doc is laid out

Seven sections, same order, every file:

1. **What it does** — the job, and at what grain.
2. **Reads** — what it takes from upstream, what it does with it, and
   **what it wishes it had**. That last list is the research backlog for
   the *upstream* stage. This stage found those gaps.
3. **Hands on** — the contract. If you add a field, add a row.
   Downstream stages link here. They do not restate the contract.
4. **Must not regress** — invariants, and the things that were tried and
   reverted. Do not delete a line here without a picture that shows why.
5. **How it works today** — the mechanism.
6. **Open** — unresolved questions, measured dead ends, what to try next.
7. **How to judge it** — the capture, the command, what to look for.

Sections 2 and 3 are how the pipeline improves. A stage gets better
mostly from more context from upstream, not from tuning of this stage.
Layout began to emit history maps because the Shape wishes list asked for
them. **If a wish is granted, move it to a row in section 3 upstream.**
Do not leave it in both places.

Almost every stage is open. Export is the exception. `bun run check:docs`
holds the structure: links and anchors resolve, contract tables match
the field lists in the code, and every stage has its seven sections. It
also prints the open wishes across the pipeline.

**One file per stage, until it earns a folder.** If the open questions of
a stage each grow their own working notes, promote that stage.
`stages/layout.md` becomes `stages/layout/README.md` with siblings beside
it, and §6 links down to them. Sections 3 and 4 stay on the front page.
The contract and the invariants stay where every other doc points at
them. Do not promote a stage before it needs a folder.

## Status words

Used in every stage doc, with these meanings:

- **decided** — settled. Reopen only with a picture that shows why.
- **recommended** — researched. Needs one trial before you commit.
- **open** — known problem. No chosen answer.
