# Full-planet bake: compute, resolution, ship size

Decided Aug 2026. Companion to [full-planet-pipeline.md](full-planet-pipeline.md)
(architecture and tool choices) and [preparing-for-diffusion.md](preparing-for-diffusion.md)
(regional sketch → `tiff-export`). The game-side package contract lives in
`~/dev/thalos` (`docs/world/mira_airless_mvp.md`, ADR-20260720T211046Z).

The whole planet is playable: landable and flyable everywhere. Aerial has to
read as real. Human-scale detail is analytic and lazy in the game. Pyros bodies
are about half Solar-System radius, so about a quarter of the surface area.

## Resolution — decided

Bake **90 m globally**. Do not bake a 30 m planet.

| Layer | Who | Scale | When |
|---|---|---|---|
| Landform statistics | terrain-diffusion 90 m | ridges, valley spacing, coast crenulation | offline bake |
| Drainage | hydrology on that DEM | real rivers, lakes; sub-cell carve if a 90 m channel is too wide | offline, after height freezes |
| Human scale | analytic octaves (HMF, biome/slope-conditioned) | ~90 m → ~0.5 m | lazy, in game |

Aerial is shape at 100 m–few km. That is the 90 m model's job, plus a drainage
pass so low flight is not rolling blobs. The 30 m model is “playable / local
variation” — 100–300 m gullies on approach — not the aerial picture. Spend it
only if low flight still looks soft after hydrology and conditioned octaves.

Human scale is never a diffusion bake. The runtime cascade already bottoms out
around 0.5 m. Walking and landing sit on that, plus materials and vegetation.

30 m globally is 9× the pixels: two weeks on the 4070 Ti, ~280 GB of height,
and the same hydrology and octaves still have to run. Tiny rocks (Kael, Xxirt)
are the other exception — do not think in 90 m; a 14 km body at 1 m is vanity.

## Compute — decided

Bake on the **home RTX 4070 Ti**. Do not rent for the Thalos 90 m job.

Thalos is half Earth's radius (`radiusKm: 3186`), a quarter of the surface:
~16 billion 90 m pixels, ~150k overlapping tiles, ~30 GB of int16 in the bake
(closer to 50 GB with overlap). That is **one to two days** on the 4070 Ti
(half a day if tiles are fast; three or four if not). Earth-scale was
single-digit GPU-days and ~600k tiles; Thalos is that number over four.

`WorldPipeline` is one process, one device, batches 1–16 tiles. That is an
implementation limit, not a data dependence. `get(i1, j1, i2, j2)` is a pure
function of `(seed, coords)` plus a bounded parent window — InfiniteDiffusion's
random access. Any partition of the tile list is a valid shard. N GPUs means N
processes on the same seed and conditioning. Shared parent latents at a cut are
recomputed or read from a shared tile store; either way the pixels match. No
generation-order constraint, no required seam blend. Cubesphere addressing maps
`(face, x, y)` onto those rectangles; it does not serialize them.

Two processes on the same 4070 Ti fight for 12 GB and lose. Hydrology waits on
the composed height, then can split by basin. Mixed GPU SKUs can drift by a ULP.

Training this stack already fits in 24 GB. Inference lives in 12 GB; if fp32 +
`torch.compile` + batch 16 OOMs, drop to batch 8 or `bf16` before renting 48 GB.
Wall-clock on one card is one to two days. Across K same-class cards it is that
over K, plus load. Worth renting when you want the desk back or a frozen
solar-system campaign.

| Card | Verdict |
|---|---|
| RTX 4070 Ti (home, 12 GB, Ada) | Right machine. CUDA + compile. Same ballpark as “a rented card.” |
| RTX A6000 (48 GB, Ampere) | Not faster at these batch sizes. Only win is VRAM. |
| L40 (48 GB, Ada) | Actually quicker, maybe 1.5–2×. Rent to free the home PC, not because the 4070 Ti cannot do it. |
| A100 80 GB | Training card. Not the U-Net inference win. |

Cloud is for measured VRAM overflow or a frozen campaign you do not want on
the desk — the same rule as Mira pilots. The cubesphere bake is still unwritten
(`@planetgen/bake` is a stub). Validate crops, one face, and one seam before
the 150k-tile job.

## What ships — decided

The bake is an authoring product. The game gets a **sparse cube-sphere residual
pyramid**, not a dense GeoTIFF. Schema v1 already encodes this: parent
predictor, per-node quantized `i16` residuals with a local scale, zstd per
blob, content-addressed, `(face, lod, x, y)`. Nodes stop when the parent is
good enough. Ocean, cratons, and mare die at 1–2 km. Coasts, belts, and crater
rims keep 90 m.

Do not ship latents (Q10 stays closed for distribution). Do not ship a global
`R16` range, float32 heights, a 90 m climate raster, or a planet-wide river
raster. Climate stays at the coarse cell (~23 km). Rivers ship as a reach/lake
graph. Analytic octaves are an algorithm plus a seed. Deleting the disk cache
must not change the planet.

Dense 90 m int16 for Thalos is ~30 GB. That is the bake, not the install.
After pruning, quantization, and zstd, Thalos should land around **2–3 GB**.
Climate is megabytes. Hydrology vectors are hundreds of megabytes. If one body
crosses ~5 GB, the prune threshold is wrong — 90 m got stored on plains.

The current Mira `29.6 MiB` file is the crater MVP, not the production number.

## Solar system — decided (budget)

Pyros solid area is about one Earth (~490 million km²). Dense 90 m for all of
that is ~120 GB and is not a product. Adaptive residuals put the **whole
system in about 10–20 GB**.

| Body | Role | Install |
|---|---|---|
| Thalos | home terrestrial | 2–3 GB |
| Ashara | larger terrestrial | 3–5 GB |
| Pelagos | ocean world | 1–2 GB |
| Mira-class moons | airless / ice | 0.2–0.8 GB each |
| Rocks (Selva, Nyx, Carpo, Theron) | small | tens of MB |
| Kael, Xxirt | 8–14 km | analytic or a few MB |
| Auron, Teros, Nereus | gas | no height package |

Home pair (Thalos + Mira) is a ~2.5 GB base. The other worlds are a
solar-system pack or on-demand bodies. One 15 GB system is a texture pack.

## What not to do

- Rent an A6000 or A100 for the Thalos 90 m bake
- Hand one `WorldPipeline` process an 8-wide machine — it will not see the other GPUs. Shard the tile list yourself.
- Bake 30 m for the whole planet, or 1 m for anyone
- `tiff-export` the 720×360 `world/` raster
- Ship the dense bake, latents, or 90 m ocean
- Treat 90 m windows as “the playable parts” — the whole planet is playable
