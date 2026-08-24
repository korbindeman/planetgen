# Features we do not make yet

A list to grow. Not a plan, not agent context. Search here when something
is missing from the planet and you want to know whether that is known.

- **Atolls.** No coral-reef rings, no lagooned volcanic remnants.
- **Fjords.** The detail pass drowns glaciated high-latitude coasts, but a
  cell is ~50 km, and a real fjord is 1–6 km across. What you get is one
  drowned cell, not a Norway coast.
- **Detail pass.** The pass exists (warp, island crests, oriented ridges,
  first-stage erosion). It still needs to look better.
- **Detail seed.** Warp, island crests, phasor ridges and first-stage
  erosion share the planet seed today, so shuffling the planet also rerolls
  the coasts. Give the detail pass its own seed and a shuffle that only
  rerolls it (coastline warp, islands, and the rest of the pass) without
  regenerating plates or climate. That is the same planet, not a branch.
- **Authored editing.** Raise land, drain basins, and other hand edits to a
  generated planet. Implementation is still open. [World
  Orogen](https://orogen.studio) already does this; read that codebase when
  we get to it. Not Earth's authored fixture knobs.
- **Content-addressed preview bakes.** Preview tiles live under the variant
  folder and die when the version updates, because we cannot tell which
  tiles the new base still matches. Address each tile by a hash of the
  local base it was baked from, so a tile whose ground did not change is
  kept. Surgical edits elsewhere on the planet then do not invalidate
  still-correct tiles.
