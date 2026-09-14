# Reference — terrain-diffusion

What the model reads and how to run it. This changes when the model
changes, not when we learn something about planets. Stage context is
[terrain.md](../stages/terrain.md).

## Where it lives

Sibling checkout of this repo, never vendored — `../terrain-diffusion`,
next to `planetgen`. On the 4070 Ti box that is
`C:\Users\korbi\Documents\terrain-diffusion`. `TD_ROOT` overrides it;
`tdCheckout()` in `scripts/td-jobs.mjs` resolves it.

*Do not look in `~/dev/terrain-diffusion`.* Every doc said that until Sep
2026 and no such directory has ever existed. An agent that checked there
found nothing, concluded the model was not on this machine, and reported a
bake-side fix as unverifiable when both environments were sitting right
here.

There are **two** working environments, and which one you want depends on
what you are doing:

| | Path | Torch | Used for |
| --- | --- | --- | --- |
| **Native Windows** | `<checkout>/.venv/Scripts/python.exe` | 2.13.0+cu132 | The studio's in-app tile bakes. This is what `td-jobs.mjs` spawns. |
| **WSL2** | `~/td-env/bin/python` in distro `Thalos-Ubuntu` | 2.14.0+cu130, triton 3.8.0 | Campaign bakes. ~1.4× faster because `torch.compile` works. |

The WSL distro reads the *same* Windows checkout cross-mount, at
`/mnt/c/Users/korbi/Documents/terrain-diffusion`. There is no second copy of
the source. Setup, pinned versions and the bench are
[wsl-bake-env.md](wsl-bake-env.md).

To reach the WSL env from a Windows agent shell (`Thalos-Ubuntu` is the
default distro, so `-d` is optional but worth being explicit about):

```powershell
wsl.exe -d Thalos-Ubuntu -- bash -lc '~/td-env/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available())"'
```

Weights: Hugging Face `xandergos/terrain-diffusion-90m` or `…-30m`. The WSL
env keeps its own cache at `~/td-hub` — do not point `HF_HUB_CACHE` at the
Windows one.

The model does **not** want a globe, an equirectangular planet, or a
finished DEM. It wants a small **planar coarse map**: one pixel per
conditioning cell, in Earth-like physical units. That sketch is noisy on
purpose. You set how hard the model should lock to it.

## Models

| Model | Output | Coarse cell | Use |
| --- | --- | --- | --- |
| `xandergos/terrain-diffusion-90m` | 90 m/px | **23 km** | Large-scale worldbuilding. More coherent. Often "too expansive." |
| `xandergos/terrain-diffusion-30m` | 30 m/px | **7.7 km** | Playable / local variation. Finer control. |

planetgen's layout mesh at `N=10000` is ~226 km on Earth and ~113 km on
Thalos. Shape resamples onto the model's grain (**23 km**), derived from
radius, before export. The 90 m model still interpolates that sketch.
That is correct.

## Upsample and size

`tiff-export` refines the sketch, then upsamples **256× on each axis**.

| Coarse (cells) | Output (px) | Coverage at 23 km/px |
| --- | --- | --- |
| 12 × 8 | 3072 × 2048 | ~276 × 184 km |
| 48 × 32 | 12288 × 8192 | ~1100 × 740 km |
| 720 × 360 (full equirect) | 184320 × 92160 | whole Earth — do not run this |

A 12×8 window takes a few minutes on Apple MPS. A 48×32 crop is a serious
job. The full `world/` raster from `export:td` is for inspection only.

## Files and units

A conditioning folder is a directory of single-band **float32 GeoTIFFs**.
Missing files fall back to Perlin. At least one file is required.
Filenames are fixed:

| File | Channel | Units | Notes |
| --- | --- | --- | --- |
| `heightmap.tif` | 0 | metres | Sea level **= 0**. Negative = ocean. Out-of-bounds fill is −1000 m. |
| `temperature.tif` | 1 | °C | Mean air temperature. |
| `temperature_std.tif` | 2 | °C | Seasonal / inland variability. Stored internally as °C × 100. |
| `precipitation.tif` | 3 | mm/yr | Annual total. |
| `precipitation_cv.tif` | 4 | % | Coefficient of variation. Dry climates ~60–80. |

GeoTIFF geotransform and CRS (planetgen writes WGS84) are copied onto the
output. The sibling `tiff-export` command writes **int16 metres**, LZW
tiled 256×256. Our owned `td-bake.py` worker now writes **Float32 metres**
through raw and native TIFF paths, preserving sub-metre signs. Its precision
identity and legacy-campaign rules are in [Terrain](../stages/terrain.md#campaign-overlap-and-fine-mask-trial).

`tiff-export` currently writes **elevation only** (`with_climate=False`).
The climate channels are conditioning going in; nothing comes back out.
Anything downstream that needs climate on the fine DEM has to recompute
it — see [carve-hydrology.md](../stages/carve-hydrology.md#after-the-cut).

`temperature_std` is the only channel with a unit conversion inside
`tiff_export` (multiply by 100). Write °C in the TIFF anyway.

## Unit mapping

**Preview climate** uses normalized fields. `exportTerrainDiffusion` converts
them for regional Shape previews and legacy campaigns:

| planetgen | TIFF |
| --- | --- |
| elevation `e ≥ 0` | `5500 * e^1.35` m |
| elevation `e < 0` | `−4200 * (−e)^1.4` m |
| temperature `t` | `clamp(40*t − 15, −40, 40)` °C |
| moisture `m` | `60 + 3400 * m^1.55` mm/yr |
| `temperature_std` | derived from latitude + inland dryness (~2–16 °C) |
| `precipitation_cv` | derived from dryness + seasonality (~16–74 %) |

Sea stays at 0. Peaks sit around 5.5 km, abyss around −4.2 km —
Earth-like enough for a model trained on ETOPO/WorldClim. The last two
rows remain heuristics for that preview tier.

**New campaigns** use seasonal climate by default. Its temperatures are
already °C and rain is already mm/month. Annual mean temperature, sample
temperature SD, total precipitation, and `100 * SD(P) / (mean(P) + 1 mm)`
are computed from twelve months. `seasonal-td.js` rasterizes those four
physical fields directly on the same conformal face lattice; do not apply
the preview conversions. Temperature SD stays in °C in the TIFF: the sibling
importer multiplies by 100 internally. Elevation follows the existing sketch
mapping in both tiers. See [Climate](../stages/climate.md).

## Padding

The importer pads every raster by **64 coarse cells** with `mode="edge"`,
so the U-Net has context at the crop border. Padding is stripped from the
output.

Consequences:

- A 12×8 map becomes 136×140 of conditioning. Most of that is **repeated
  rim**.
- Features that exist only as a thin anomaly in a tiny crop get healed. A
  hand-drawn canyon one or two cells wide does not survive.
- Prefer windows where the landform of interest is a **large fraction**
  of the crop, or use a bigger crop.

Cube-grid preview tiles do not use that edge-repeat — planetgen
rasterizes 64 cells of real neighbouring ground instead. See
[terrain.md](../stages/terrain.md#preview-tiles-a-shape-tool) and
[cubesphere.md](cubesphere.md).

## SNR

`--snr` is five comma-separated values, one per channel:

```
ELEV, TEMP, T_STD, PRECIP, P_CV
```

Higher = less noise on that channel = the coarse model stays closer to
your pixels. Lower = the model is free to redraw.

Azgaar default, and a good starting point:

```
0.2, 0.2, 1.0, 0.2, 1.0
```

That is **weak** elevation and precipitation, **strong** variability
channels. Coasts, mountain texture and local climate get invented.
Continent-scale highs and lows, and the std/CV envelopes, are kept.

| Intent | SNR (approx.) |
| --- | --- |
| Default / Azgaar-like | `0.2, 0.2, 1.0, 0.2, 1.0` |
| Keep a dry climate | raise PRECIP (and maybe P_CV) toward `0.8–1.0` |
| Keep a large elevation ramp | ELEV around `0.25–0.4` |
| Force the sketch as a DEM | does **not** work |

Very high elevation SNR (1.5+) on an out-of-distribution sketch (blocky
trench, 5 km tableland with a one-cell slot) collapsed relief in tests.
The coarse model is trained on Earth statistics and will "correct" shapes
it does not believe.

## What works well as input

Think **Azgaar-style painted map**, not SRTM.

**Do give the model**

- Continent-scale land vs ocean, with sea at 0 m.
- Mixed land and water **inside** a plate. Irregular coasts from the
  elevation blend.
- Broad mountain belts and high plateaus as **smooth ramps**, hundreds of
  km across.
- A real **base-level drop** where you want dissection: high land next to
  a low basin, shelf or trench (kilometres of relief across the window).
- Climate as large blobs: wet coasts, drier interiors, cold poles. Values
  in Earth ranges (precip tens to a few thousand mm; temps roughly −40 to
  40 °C).
- Variability channels that match the biome story (high CV in drylands,
  high temp std inland / mid-latitude).

**Do not give the model**

- A finished 90 m DEM, river networks, or hand-carved canyons at coarse
  resolution. It treats one-cell trenches as mistakes and heals them.
- A pancake (almost no relief). You get rias and the model often **eats
  land** — low-coast test: land fraction dropped ~55% → 34%.
- A mostly-ocean window with a trench. It invents islands and spends the
  budget on bathymetry.
- The whole planet as one `tiff-export` job.
- Polar-only crops if you care about usable land; mid-latitude windows
  match training data better.
- Elevation SNR high enough to freeze a blocky sketch. Put the structure
  in a **ramp**, not a slot.

**Training clip:** the model's data was cut at ±60° latitude. Its worlds
are statistically mid-latitude everywhere. That is the structural blind
spot [climate.md](../stages/climate.md) is trying to plug.

## Tiling the planar path

`tiff-export` is a **rectangle**. The planet is baked on the
[cubesphere](cubesphere.md) instead, but if you are tiling planar windows
by hand:

- Conditioning cell size must match the model (23 km or 7.7 km).
- Stay in the 12×8 to 24×16 cell range unless you have a big GPU budget.
- Overlap by **more than the 64-cell pad**, so seams are generated rather
  than edge-repeated.
- Blend DEMs in the overlap; optionally match river mouths.
- Poles: skip them, use a polar stereographic sketch, or accept that
  equirect cells are a lie.

Do not upsample the 720×360 `world/` raster in one shot.

## Landforms you can expect

At 90 m, from planetgen sketches:

| Sketch | Typical 90 m result |
| --- | --- |
| Wet alpine, ~5 km relief | Tight dendritic gorges, sharp ridges |
| High plateau draining to near sea, kept dry (~100 mm) | Smooth bajada + dissected rim (canyon country, not a single Colorado trench) |
| Dry tableland, little drop (~90 mm, ~1 km relief) | Muted basin, faint washes |
| Low-relief coast | Soft rias; coastline will move |
| Steep range into a trench, wet | Alpine into abyss; still wet valleys |

Canyons in the Grand Canyon sense need **relief + concentrated drainage +
dryness**. Diffusion will etch dendritic gorges into an escarpment. It
will not invent a master canyon on a flat.

## How to run it

From the terrain-diffusion checkout ([where it lives](#where-it-lives)).
Prefer the inference module — the top-level `python -m terrain_diffusion
tiff-export` CLI imports training deps.

Native Windows, which is what the studio spawns:

```
cd <checkout>
MPLBACKEND=Agg PYTHONIOENCODING=utf-8 \
  .venv/Scripts/python.exe -m terrain_diffusion.inference.tiff_export \
  xandergos/terrain-diffusion-90m \
  /path/to/crop-folder \
  /path/to/crop-folder/output.tif \
  --snr 0.2,0.2,1.0,0.2,1.0 \
  --no-compile --device cuda --seed 88
```

WSL2, for a campaign bake. Run from the checkout dir: `bind()` resolves its
stats cache relative to cwd, and otherwise prompts for a WorldClim download
and hangs headless.

```
wsl.exe -d Thalos-Ubuntu -- bash -lc '
  cd /mnt/c/Users/korbi/Documents/terrain-diffusion &&
  PYTHONPATH=$PWD HF_HUB_CACHE=~/td-hub MPLBACKEND=Agg \
  ~/td-env/bin/python -m terrain_diffusion.inference.tiff_export ...'
```

On NVIDIA, `--device cuda` and compile can stay on. The README claims Mac
is CPU-only; MPS works with `--no-compile`. First `bind()` wants
WorldClim/ETOPO stats; a dummy `data/global/synthetic_map_stats.json` in
the terrain-diffusion tree avoids the download prompt for sketch tests.

`--seed` is the diffusion seed, independent of the planetgen seed.

## Which process bakes

Studio bakes go through `scripts/td-server.mjs` on port 3748; it spawns the
python above and then finishes the tile — `bakeBackOntoTile`, the fold
stitch, the paint. `bun run bake:tiles` calls the same code in-process, so it
is always the tree you are looking at. The server is not: `bun run dev`
reuses whatever already answers on 3748, and `bun --hot` reloads the page
only. A server started before your edits will happily keep baking.

So the two shake hands. `/health` returns a `version` — a sha256 over the
closure of the server's own sources, walked from `td-server.mjs`
(`scripts/td-version.mjs`; `bun run check:td` holds it to covering the bake
path and ignoring the page). `bun run dev` compares it against the tree:

- same version — reuse it, as before
- different, and the server is idle — stop it and start a current one
- different, and a bake is running — refuse, name the jobs, and exit 1,
  because those tiles are already being baked by that code

A server predating the handshake reports no version at all, which counts as
different. The tell after the fact is in `crop-<tile>/tile.json`: a bake
through the current server always writes `bakeStep`, `tileCells` and
`haloCells`. Without them the bake never came off the conformal plane —
`bun scripts/repair-tile-raster.mjs <variant-dir> <tile>...` puts it back
without re-baking.

## What planetgen writes

```bash
bun run export:td
bun run export:td --seed=88 --scale=23 --lon=90 --crops=3
```

Writes `preview/<name>/` (gitignored):

| Path | Role |
| --- | --- |
| `examples.png` | World sketch + crop windows |
| `world/*.tif` | Full equirect, **inspection only** |
| `crop-coast/`, `crop-mountains/`, `crop-climate/` | 16×12 regional tiles at `--scale` km/px |
| `manifest.json` | Project, seed, bounds, suggested SNR |

Crops are picked at mid-latitudes for mixed land/ocean (coast), high
relief (mountains), and climate range. They are **not** the whole planet.

Judge the **heightmap**, not the green hillshade. Diffusion does not
paint biomes; dryness only shows up if you colour by climate or use an
arid ramp.
