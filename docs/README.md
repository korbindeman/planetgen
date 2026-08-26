# planetgen docs

The generator is a **pipeline of stages**. Each stage owns one grain, reads
what the stage before it handed on, and hands on something the next stage
can use. Most of the interesting work in this project is deepening one
stage, or widening the contract between two.

One file per stage. That file is where its research, its decisions, and its
open questions live. If you are working on a stage, you should not have to
read any other stage's file to know what you are allowed to do.

## The pipeline

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
Climate through Export — overnight and GPU work on a variant you kept. The
harness around both is [studio.md](studio.md).

| Stage | Grain | State | Doc |
| --- | --- | --- | --- |
| Layout | ~10k cells (~113 km on Thalos) | Live, improving | [layout.md](layout.md) |
| Shape | 23 km/px sketch | Live, improving | [shape.md](shape.md) |
| Climate | 23 km fields | Live heuristic; bake tier untried | [climate.md](climate.md) |
| Terrain | 90 m/px | Regional tiles work; planet scale open | [terrain.md](terrain.md) |
| Carve — hydrology | 90 m/px | Not started; method open | [carve-hydrology.md](carve-hydrology.md) |
| Carve — landforms | 90 m/px | Not started | [carve-landforms.md](carve-landforms.md) |
| Export | sparse pyramid | Schema decided; bake unwritten | [export.md](export.md) |

## How a stage doc is laid out

Every stage file has the same seven sections, in this order:

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
7. **How to judge it** — the capture, the command, what you are looking for.

Sections 2 and 3 are the ones that make the pipeline improve. A stage
gets better mostly by being handed more context, not by being tuned:
Layout began emitting history maps because Shape's wishes list asked for
them. When a wish is granted it becomes a row in section 3 upstream.

Section 6 is the point of this repo. Almost every stage is open. A doc
that reads as finished is either wrong or about Export.

**One file per stage, until it earns a folder.** When a stage's open
questions each grow their own working notes, promote that stage —
`layout.md` becomes `layout/README.md` with siblings beside it, and §6
links down to them. Sections 3 and 4 never leave the front page: the
contract and the invariants stay where every other doc points at them.
Do not promote a stage before it needs it; one file is what keeps the
skeleton usable.

## Not a stage

- [studio.md](studio.md) — the harness: Discover/Finish, projects,
  variants, what a Save is. Canonical for all of that.
- [../CONTEXT.md](../CONTEXT.md) — the words. Every term, and what not to
  call it.

## Reference

Stable lookup. These change when an external tool changes, not when we
learn something.

- [ref/terrain-diffusion.md](ref/terrain-diffusion.md) — what the model
  reads: channels, units, SNR, padding, how to run it.
- [ref/cubesphere.md](ref/cubesphere.md) — six faces, tile addressing,
  seams, the scale bound.
- [ref/bake-compute.md](ref/bake-compute.md) — 90 m vs 30 m, which GPU,
  how long, how big.

## History

Decisions as they were made, kept because the reasoning is worth more
than the outcome. Do not update these — they are dated on purpose.

- [history/shape-detail-pass-2026-08.md](history/shape-detail-pass-2026-08.md) — how
  Shape's three steps were chosen and what they replaced.
- [history/layout-base-survey-2026-08.md](history/layout-base-survey-2026-08.md) — why
  planetgen and not World Orogen, GPlates, ASPECT, or tectonics.js.

## Status words

Used in every stage doc, and they mean this:

- **decided** — settled. Reopen only with a picture that says why.
- **recommended** — researched, needs one trial before committing.
- **open** — known problem, no chosen answer.
