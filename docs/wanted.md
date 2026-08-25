# Features we do not make yet

A list to grow. Not a plan, not agent context. Search here when something
is missing from the planet and you want to know whether that is known.

- **Atolls.** No coral-reef rings, no lagooned volcanic remnants.
- **Fjords.** The detail pass drowns glaciated high-latitude coasts, but a
  cell is ~50 km, and a real fjord is 1–6 km across. What you get is one
  drowned cell, not a Norway coast.
- **Detail pass / Shape.** Warp, island crests, oriented ridges, first-stage
  erosion exist. The pass still needs to look better. It is an explicit
  Shape action on a variant, cached, at the sketch grain (23 km) — see
  [studio.md](studio.md). No search sheet: a 16-up cannot show the coasts
  you are judging, and sixteen sketches would be too slow.
- **Authored editing.** Raise land, drain basins, and other hand edits to a
  generated sketch. Implementation is still open. [World
  Orogen](https://orogen.studio) already does this; read that codebase when
  we get to it. Not Earth's authored fixture knobs. Same planet; Save is a
  child node.
- **Content-addressed preview bakes.** Preview tiles live under the variant
  folder. Address each tile by a hash of the local sketch it was baked
  from, so a tile whose ground did not change is kept when a sibling
  snapshot is saved. Surgical edits elsewhere on the planet then do not
  invalidate still-correct tiles.
