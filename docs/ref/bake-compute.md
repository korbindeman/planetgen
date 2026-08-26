# Reference — bake compute and resolution

Decided Aug 2026. What the planet-scale bake costs and why 90 m. What
ships to the game is [export.md](../export.md); the engineering is
[terrain.md](../terrain.md).

The whole planet is playable: landable and flyable everywhere. Aerial has
to read as real. Human-scale detail is analytic and lazy in the game.
Pyros bodies are about half Solar-System radius, so about a quarter of
the surface area.

## Resolution — decided

Bake **90 m globally**. Do not bake a 30 m planet.

| Layer | Who | Scale | When |
| --- | --- | --- | --- |
| Landform statistics | terrain-diffusion 90 m | ridges, valley spacing, coast crenulation | offline bake |
| Drainage | hydrology on that DEM | rivers, lakes, large meander belts and oxbows; creeks stay a reach graph | offline, after height freezes |
| Human scale | analytic octaves (HMF, biome/slope-conditioned) | ~90 m → ~0.5 m | lazy, in game |

Aerial is shape at 100 m–few km. That is the 90 m model's job, plus a
drainage pass so low flight is not rolling blobs. The 30 m model is
"playable / local variation" — 100–300 m gullies on approach — not the
aerial picture. Spend it only if low flight still looks soft after
hydrology and conditioned octaves.

30 m globally is 9× the pixels: two weeks on the 4070 Ti, ~280 GB of
height, and the same hydrology and octaves still have to run. Tiny rocks
(Kael, Xxirt) are the other exception — do not think in 90 m; a 14 km
body at 1 m is vanity.

## Compute — decided

Bake on the **home RTX 4070 Ti**. Do not rent for the Thalos 90 m job.

Thalos is half Earth's radius (`radiusKm: 3186`), a quarter of the
surface: ~16 billion 90 m pixels, ~150k overlapping tiles, ~30 GB of
int16 in the bake (closer to 50 GB with overlap). That is **one to two
days** on the 4070 Ti — half a day if tiles are fast, three or four if
not. Earth-scale was single-digit GPU-days and ~600k tiles; Thalos is that
number over four.

Sharding is free: any partition of the tile list is valid, because
`get(i1,j1,i2,j2)` is a pure function of `(seed, coords)` plus a bounded
parent window. N GPUs means N processes on the same seed and
conditioning. Cubesphere addressing maps `(face, x, y)` onto those
rectangles; it does not serialize them.

Two processes on the same 4070 Ti fight for 12 GB and lose. Hydrology
waits on the composed height, then can split by basin. Mixed GPU SKUs can
drift by a ULP.

Training this stack already fits in 24 GB. Inference lives in 12 GB; if
fp32 + `torch.compile` + batch 16 OOMs, drop to batch 8 or `bf16` before
renting 48 GB.

| Card | Verdict |
| --- | --- |
| RTX 4070 Ti (home, 12 GB, Ada) | Right machine. CUDA + compile. Same ballpark as "a rented card." |
| RTX A6000 (48 GB, Ampere) | Not faster at these batch sizes. Only win is VRAM. |
| L40 (48 GB, Ada) | Actually quicker, maybe 1.5–2×. Rent to free the home PC, not because the 4070 Ti cannot do it. |
| A100 80 GB | Training card. Not the U-Net inference win. |

Cloud is for measured VRAM overflow or a frozen campaign you do not want
on the desk — the same rule as Mira pilots.

Validate crops, one face, and one seam before the 150k-tile job.

## What not to do

- Rent an A6000 or A100 for the Thalos 90 m bake
- Hand one `WorldPipeline` process an 8-wide machine — it will not see
  the other GPUs. Shard the tile list yourself.
- Bake 30 m for the whole planet, or 1 m for anyone
- `tiff-export` the 720×360 `world/` raster
- Treat 90 m windows as "the playable parts" — the whole planet is
  playable
