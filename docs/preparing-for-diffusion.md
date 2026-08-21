# Preparing for terrain-diffusion

Planetgen is the coarse planetary **base**: plates, a heightmap, and climate on the sphere. [terrain-diffusion](https://github.com/xandergos/terrain-diffusion) turns a **planar sketch** of that base into a high-resolution DEM. Hydrology and other post-processing run **after** that DEM exists. None of those later stages live in this repo.

This note is the handoff: what the model reads, how planetgen writes it, what actually works as a sketch, and what to do once you have 90 m (or 30 m) elevation.

## Pipeline

```
planetgen (sphere, ~220 km cells)
    → bun run export:td          regional GeoTIFF sketches
    → terrain-diffusion tiff-export     256× upsample DEM
    → hydrology / erosion        rivers, canyons, lakes
    → optional polish            fill sinks, lapse-rate climate, stitch tiles
```

Do not try to finish coasts, river valleys, or eroded slopes inside planetgen. The 1843 distance-field heightmap is supposed to stay a blobby continental sketch. Terrain-diffusion redraws local shape. Hydrology then cuts channels.

Sibling checkout (not vendored here): `~/dev/terrain-diffusion`. Weights: Hugging Face `xandergos/terrain-diffusion-90m` or `…-30m`.

## What terrain-diffusion expects

The model does **not** want a globe, an equirectangular planet, or a finished DEM. It wants a small **planar coarse map**: one pixel per conditioning cell, in Earth-like physical units. That sketch is noisy on purpose. You set how hard the model should lock to it.

### Models

| Model | Output | Coarse cell | Use |
| --- | --- | --- | --- |
| `xandergos/terrain-diffusion-90m` | 90 m/px | **23 km** | Large-scale worldbuilding. More coherent. Often “too expansive.” |
| `xandergos/terrain-diffusion-30m` | 30 m/px | **7.7 km** | Playable / local variation. Finer control. |

Planetgen’s mesh spacing at `N=10000` is on the order of **220 km**. Even the 90 m model’s 23 km cell is still interpolating our blobs. The sketch will look like large filled polygons, not terrain. That is correct.

### Upsample and size

`tiff-export` refines the sketch, then upsamples **256× on each axis**.

| Coarse (cells) | Output (px) | Coverage at 23 km/px |
| --- | --- | --- |
| 12 × 8 | 3072 × 2048 | ~276 × 184 km |
| 48 × 32 | 12288 × 8192 | ~1100 × 740 km |
| 720 × 360 (full equirect) | 184320 × 92160 | whole Earth — do not run this |

A 12×8 window takes a few minutes on Apple MPS. A 48×32 crop is a serious job. The full `world/` raster from `export:td` is for inspection only.

### Files and units

A conditioning folder is a directory of single-band **float32 GeoTIFFs**. Missing files fall back to Perlin. At least one file is required. Filenames are fixed:

| File | Channel | Units | Notes |
| --- | --- | --- | --- |
| `heightmap.tif` | 0 | meters | Sea level **= 0**. Negative = ocean. Out-of-bounds fill is −1000 m. |
| `temperature.tif` | 1 | °C | Mean air temperature. |
| `temperature_std.tif` | 2 | °C | Seasonal / inland variability. Internally stored as °C × 100. |
| `precipitation.tif` | 3 | mm / year | Annual total. |
| `precipitation_cv.tif` | 4 | % | Coefficient of variation. Dry climates ~60–80. |

GeoTIFF geotransform and CRS (planetgen writes WGS84) are copied onto the output. The output DEM is **int16 meters**, LZW tiled 256×256.

`temperature_std` is the only channel with a unit conversion inside `tiff_export` (multiply by 100). Write °C in the TIFF anyway.

### Padding

The importer pads every raster by **64 coarse cells** with `mode="edge"`, so the U-Net has context at the crop border. Padding is stripped from the output.

Consequences:

- A 12×8 map becomes 136×140 of conditioning. Most of that is **repeated rim**.
- Features that exist only as a thin anomaly in a tiny crop get healed. A hand-drawn canyon one or two cells wide does not survive.
- Prefer windows where the landform of interest is a **large fraction** of the crop, or use a bigger crop.

### SNR (how hard to lock the sketch)

`--snr` is five comma-separated values, one per channel:

```
ELEV, TEMP, T_STD, PRECIP, P_CV
```

Higher = less noise on that channel = the coarse model stays closer to your pixels. Lower = the model is free to redraw.

Azgaar default, and a good starting point for planetgen:

```
0.2, 0.2, 1.0, 0.2, 1.0
```

That is **weak** elevation and precipitation, **strong** variability channels. Coasts, mountain texture, and local climate get invented. Continent-scale highs and lows, and the std/CV envelopes, are kept.

| Intent | SNR (approx.) |
| --- | --- |
| Default / Azgaar-like | `0.2, 0.2, 1.0, 0.2, 1.0` |
| Keep a dry climate | raise PRECIP (and maybe P_CV) toward `0.8–1.0` |
| Keep a large elevation ramp | ELEV around `0.25–0.4` |
| Force the sketch as a DEM | does **not** work — see below |

Very high elevation SNR (1.5+) on an out-of-distribution sketch (blocky trench, 5 km tableland with a one-cell slot) collapsed relief in tests. The coarse model is trained on Earth statistics. It will “correct” shapes it does not believe.

### How to run it

From the terrain-diffusion checkout. Prefer the inference module (the top-level `python -m terrain_diffusion tiff-export` CLI imports training deps):

```bash
cd ~/dev/terrain-diffusion
MPLBACKEND=Agg PYTORCH_ENABLE_MPS_FALLBACK=1 \
  .venv/bin/python -m terrain_diffusion.inference.tiff_export \
  xandergos/terrain-diffusion-90m \
  /path/to/crop-folder \
  /path/to/crop-folder/output.tif \
  --snr 0.2,0.2,1.0,0.2,1.0 \
  --no-compile --device mps --seed 88
```

On NVIDIA, `--device cuda` and compile can stay on. README claims Mac is CPU-only; MPS works with `--no-compile`. First `bind()` wants WorldClim/ETOPO stats; a dummy `data/global/synthetic_map_stats.json` in the terrain-diffusion tree avoids the download prompt for sketch tests.

`--seed` is the diffusion seed, independent of the planetgen seed.

## What planetgen writes

```
bun run export:td
bun run export:td --seed=88 --scale=23 --lon=90 --crops=3
```

Writes `preview/terrain-diffusion/` (gitignored):

| Path | Role |
| --- | --- |
| `examples.png` | World sketch + crop windows |
| `world/*.tif` | Full equirect, **inspection only** |
| `crop-coast/`, `crop-mountains/`, `crop-climate/` | 48×32 regional tiles at `--scale` km/px |
| `manifest.json` | Seed, bounds, suggested SNR |

Crops are picked at mid-latitudes for mixed land/ocean (coast), high relief (mountains), and climate range. They are **not** the whole planet.

### Unit mapping

Planetgen fields are not meters or °C. `exportTerrainDiffusion` converts:

| Planetgen | TIFF |
| --- | --- |
| elevation `e ≥ 0` | `5500 * e^1.35` m |
| elevation `e < 0` | `−4200 * (−e)^1.4` m |
| temperature `t` | `clamp(40*t − 15, −40, 40)` °C |
| moisture `m` | `60 + 3400 * m^1.55` mm/yr |
| `temperature_std` | derived from latitude + inland dryness (~2–16 °C) |
| `precipitation_cv` | derived from dryness + seasonality (~16–74 %) |

Sea stays at 0. Peaks sit around 5.5 km, abyss around −4.2 km — Earth-like enough for a model trained on ETOPO/WorldClim.

Do **not** flatten ocean basins or floor continental plates before export. Coasts in this generator come from the 1843 elevation blend crossing sea level. A crust mask or land floor makes coasts snap to plate edges; the diffusion model then inherits that lie.

### Climate honesty

This generator is not a hot-desert world. On seed 88, land precipitation’s 10th percentile was ~150 mm/yr and dry interiors were ~16–18 °C. You get rain-shadow / steppe, not Sahara. If a later pass needs arid plateaus, overwrite `precipitation.tif` (and usually raise PRECIP SNR) on the crop. That is a conditioning edit, not a planetgen climate rewrite.

## What works well as input

Think **Azgaar-style painted map**, not SRTM.

**Do give the model**

- Continent-scale land vs ocean, with sea at 0 m.
- Mixed land and water **inside** a plate. Irregular coasts from the elevation blend.
- Broad mountain belts and high plateaus as **smooth ramps**, hundreds of km across.
- A real **base-level drop** where you want dissection: high land next to a low basin, shelf, or trench (kilometres of relief across the window).
- Climate as large blobs: wet coasts, drier interiors, cold poles. Values in Earth ranges (precip tens to a few thousand mm; temps roughly −40 to 40 °C).
- Variability channels that match the biome story (high CV in drylands, high temp std inland / mid-latitude).

**Do not give the model**

- A finished 90 m DEM, river networks, or hand-carved canyons at coarse resolution. It treats one-cell trenches as mistakes and heals them.
- A pancake (almost no relief). You get rias and the model often **eats land** (low-coast test: land fraction dropped ~55% → 34%).
- A mostly-ocean window with a trench. It invents islands and spends the budget on bathymetry.
- The whole planet as one `tiff-export` job.
- Polar-only crops if you care about usable land; mid-latitude windows match training data better.
- Elevation SNR high enough to freeze a blocky sketch. Let ELEV stay low–moderate and put the structure in a **ramp**, not a slot.

### Landforms you can expect (90 m, planetgen sketches)

| Sketch | Typical 90 m result |
| --- | --- |
| Wet alpine, ~5 km relief | Tight dendritic gorges, sharp ridges |
| High plateau draining to near sea, kept dry (~100 mm) | Smooth bajada + dissected rim (canyon country, not a single Colorado trench) |
| Dry tableland, little drop (~90 mm, ~1 km relief) | Muted basin, faint washes |
| Low-relief coast | Soft rias; coastline will move |
| Steep range into a trench, wet | Alpine into abyss; still wet valleys |

Canyons in the Grand Canyon sense need **relief + concentrated drainage + dryness**. Diffusion will etch dendritic gorges into an escarpment. It will not invent a master canyon on a flat.

## Hydrology pass (after diffusion)

This is the stage that **actually cuts rivers**. It does not belong in planetgen (mesh too coarse) and it is not what `tiff-export` does (that only paints drainage *texture*).

Run it on the **90 m / 30 m DEM**, sea level still at 0.

A useful split:

1. **Fill or breach sinks** so flow can reach the ocean (priority-flood; terrain-diffusion already has `fill_depressions_priority_flood` in `inference/postprocessing.py`). Cap fill depth if you want real endorheic basins.
2. **Route flow** (D8 or similar) and accumulate contributing area. Same file has `d8_flow` / `flow_accumulation`. Ocean (`z <= 0`) is the sink.
3. **Incise** along the network. Stream-power style: carve more where area × slope is high. This is the river / gorge / canyon step.
4. **Hillslope** (optional): mild diffusion or debris-slope on steep walls so you do not keep infinitely sharp slots. Weak diffusion in dry rock keeps canyon walls; strong diffusion in wet soil opens V-valleys.

Canyons vs ordinary valleys is a ratio, not a flag:

- **Canyon:** channel cuts down faster than slopes wear back. Needs a high surface draining to a much lower base, a trunk stream with real area, and incision ≫ hillslope smoothing.
- **Valley:** same process, more smoothing or less drop.
- **Wash:** dryness and no drop. Hydrology will not turn the pancake interior into Grand Canyon.

A single Colorado-style trench needs one master river capturing a large plateau while the rims stay high. Equal carving of every tributary gives a dissected plateau (closer to what diffusion already sketches). You can bias the trunk (pour point, extra area, higher K on one path) if you want that look.

Do **not** carve on planetgen’s ~220 km mesh. Valleys would be hundreds of kilometres wide.

After incision, elevation has changed. Recompute temperature with a lapse rate if climate must stay consistent. Moisture / biomes may need a pass too; the diffusion TIFF climate channels are the **sketch**, and `tiff-export` currently writes elevation only (`with_climate=False`).

## Other post-processing

Rough order after hydrology. Skip what you do not need.

**DEM cleanup**

- `smooth_river_bumps` (in terrain-diffusion postprocessing): flatten small upslope glitches in channels without melting steep walls.
- Optional thermal erosion / talus on cliffs.
- Coastline policy: the coarse model **will** move the shoreline at low elevation SNR. If the planetgen coast must be law, raise ELEV SNR a bit or mask ocean before hydrology. If you want dendritic coasts, leave it.

**Climate on the fine DEM**

- Lapse-rate temperature from the new elevation.
- Orographic precipitation if you have wind; otherwise keep the coarse precip blob.
- Biomes from temp + precip + elevation, not from hillshade color.

**Full-planet strategy**

`tiff-export` is a **rectangle**. A full planet is many overlapping planar windows (or an infinite `WorldPipeline` with periodic conditioning — a different integration).

Practical tiling:

- Conditioning cell size must match the model (23 km or 7.7 km).
- Tile in the 12×8 to 24×16 cell range unless you have a big GPU budget.
- Overlap by more than the 64-cell pad so seams are generated, not just edge-repeated.
- Blend DEMs in the overlap (elevation; optionally match river mouths).
- Poles: either skip, use a polar stereographic sketch, or accept that equirect cells are a lie.

Do not upsample the 720×360 `world/` raster in one shot.

**Resolution / delivery**

- Stay on 90 m for worldbuilding; switch to 30 m where a game camera needs local noise.
- `coarse_pooling` in `WorldPipeline` compresses horizontal space and intensifies terrain; that is a generation knob, not a planetgen export.
- Downstream consumers (game mesh, Minecraft mod, hydrology sim) should read the int16 GeoTIFF, not the planetgen canvas.

**What not to do in planetgen**

- Rivers, flow accumulation, valley carving.
- Flattened shelves, continental land floors, blob-grown crust.
- Photographic globe (clouds, atmosphere) as a substitute for judging the base.

Those fight the later passes or snap coasts to plates.

## Quick commands

```bash
# planetgen: write regional sketches
bun run export:td --seed=88 --scale=23

# then, in ~/dev/terrain-diffusion, 90 m DEM from one crop (or a subwindow)
python -m terrain_diffusion.inference.tiff_export \
  xandergos/terrain-diffusion-90m \
  /Users/korbin/dev/planetgen/preview/terrain-diffusion/crop-mountains \
  /tmp/mountains.tif \
  --snr 0.2,0.2,1.0,0.2,1.0 --no-compile --device mps --seed 88
```

Judge the **heightmap**, not the green hillshade. Diffusion does not paint biomes; dryness only shows up if you color by climate or use an arid ramp.
