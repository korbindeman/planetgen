# Export

## What it does

Export turns the baked planet into what the game installs. **The bake is
an authoring product. The install is not the bake.**

Schema v1 is decided. The cubesphere bake that would feed it is not
written.

## Reads

The carved 90 m DEM ([hydrology](carve-hydrology.md),
[landforms](carve-landforms.md)), the 23 km climate fields, and the river
graph.

**Wishes** — none. Export takes what the pipeline made.

## Hands on

A **sparse cube-sphere residual pyramid**, not a dense GeoTIFF. Schema v1:

- parent predictor, per-node quantized `i16` residuals with a local scale
- zstd per blob, content-addressed
- addressed `(face, lod, x, y)`
- When the parent is good enough, nodes stop. Ocean, cratons and mare
  die at 1–2 km. Coasts, belts and crater rims keep 90 m.

Alongside it: climate at the coarse cell (~23 km, megabytes), rivers as a
reach/lake graph (hundreds of MB for a planet), and analytic octaves as
an algorithm plus a seed.

| Body | Role | Install |
| --- | --- | --- |
| Thalos | home terrestrial | 2–3 GB |
| Ashara | larger terrestrial | 3–5 GB |
| Pelagos | ocean world | 1–2 GB |
| Mira-class moons | airless / ice | 0.2–0.8 GB each |
| Rocks (Selva, Nyx, Carpo, Theron) | small | tens of MB |
| Kael, Xxirt | 8–14 km | analytic or a few MB |
| Auron, Teros, Nereus | gas | no height package |

Dense 90 m int16 for Thalos is ~30 GB. After pruning, quantization and
zstd it should land at **2–3 GB**. Home pair (Thalos + Mira) is a ~2.5 GB
base. The rest is a solar-system pack or on-demand bodies. The whole
system fits in about **10–20 GB** — a texture pack. Dense 90 m for all of
Pyros' solid area (~one Earth, ~490 million km²) would be ~120 GB. That
is not a product.

**If one body crosses ~5 GB, the prune threshold is wrong.** Then 90 m
got stored on plains.

The current Mira `29.6 MiB` file is the crater MVP, not the production
number. The game-side package contract lives in `~/dev/thalos`
(`docs/world/mira_airless_mvp.md`, ADR-20260720T211046Z).

## Must not regress

Do not ship:

- the dense bake
- latents (Q10 stays closed for distribution)
- a global `R16` range, or float32 heights
- a 90 m climate raster — climate stays at the coarse cell
- a planet-wide river raster — rivers are a graph

And: **deleting the disk cache must not change the planet.** Anything
below 90 m is an algorithm and a seed, not a stored artifact.

## How it works today

Schema v1 exists. Mira has a crater-MVP package. The cube-sphere bake
that would feed a real package is not written. `@planetgen/bake` is a
named slot.

### Below 90 m — decided, runtime

The model floor is 90 m. Ground-level gameplay needs ~1 m. That layer is
**non-ML amplification**. The game evaluates it lazily from residual,
slope, biome and seed: erosion-aware detail noise, slope and material
displacement, bottoming out around 0.5 m.

Do not bake it. Human scale is never a diffusion bake. 30 m globally is
a measurement we might take later. It is not the global bake. See
[ref/bake-compute.md](../ref/bake-compute.md). A one-step 90 m → 10 m
model in the game would reopen this line. That trial is not run. See
[custom-model.md](../custom-model.md).

The whole planet is playable: landable and flyable everywhere. Do not
treat 90 m windows as "the playable parts."

## Open

- The bake itself, which is [Terrain](terrain.md#open)'s open
  engineering.
- Prune thresholds per terrain class have a stated target (ocean and
  craton at 1–2 km, coasts and rims at 90 m). They have not been measured
  against a real planet.
- **Earth's residual pyramid.** Schema v1 with Earth's real DEM and
  the story maps attached. That artifact would be training data, the
  install format, and the answer key. `check:earth` locks a stats
  report. That is not a pyramid. This trial is not run. See
  [custom-model.md](../custom-model.md).
- A **system** would author the solar-system pack named above. Not built.
  See [systems.md](../systems.md).

## How to judge it

Install size against the table above, and a visual diff of the
reconstructed pyramid against the dense bake at several LODs. A prune
threshold that is too aggressive shows up as terracing on a slope, not as
a number.
