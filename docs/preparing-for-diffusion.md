# Preparing for terrain-diffusion

Planetgen is the planetary **base**: plates, a heightmap, and climate on the sphere. Discover writes a **sketch** (Shape) at this model's grain. [terrain-diffusion](https://github.com/xandergos/terrain-diffusion) turns a **planar** crop of that sketch into a high-resolution DEM. Fine hydrology (real river networks, discharge, lakes) and other post-processing run **after** that DEM exists. Studio model: [studio.md](studio.md).

This note is the handoff: what the model reads, how planetgen writes it, what actually works as a sketch, and what to do once you have 90 m (or 30 m) elevation.

## Pipeline

```
planetgen layout (~10k) then Shape (23 km sketch)
    → bun run export:td          regional GeoTIFF sketches
    → terrain-diffusion tiff-export     256× upsample DEM
    → hydrology / erosion        rivers, canyons, lakes
    → optional polish            fill sinks, lapse-rate climate, stitch tiles
```

Do not try to finish coasts, river valleys, or eroded slopes inside planetgen. The 1843 distance-field heightmap is supposed to stay a blobby continental sketch. Terrain-diffusion redraws local shape. Hydrology then makes drainage coherent — it does not re-erode that shape. How hard is open.

Sibling checkout (not vendored here): `~/dev/terrain-diffusion`. Weights: Hugging Face `xandergos/terrain-diffusion-90m` or `…-30m`.

## What terrain-diffusion expects

The model does **not** want a globe, an equirectangular planet, or a finished DEM. It wants a small **planar coarse map**: one pixel per conditioning cell, in Earth-like physical units. That sketch is noisy on purpose. You set how hard the model should lock to it.

### Models

| Model | Output | Coarse cell | Use |
| --- | --- | --- | --- |
| `xandergos/terrain-diffusion-90m` | 90 m/px | **23 km** | Large-scale worldbuilding. More coherent. Often “too expansive.” |
| `xandergos/terrain-diffusion-30m` | 30 m/px | **7.7 km** | Playable / local variation. Finer control. |

Planetgen’s layout mesh at `N=10000` is ~226 km on Earth and ~113 km on Thalos. Shape resamples onto the model’s sketch grain (**23 km**), derived from radius, before export. The 90 m model still interpolates that sketch. That is correct.

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

Cube-grid preview tiles do not use that edge-repeat. The exporter rasterizes 64 cells of real neighbouring ground (including across a face edge) and `scripts/td-bake.py` feeds that pad to WorldPipeline at a face-grid origin, so adjacent tiles **on one face** share coordinates at the seam instead of each starting at (0, 0). A cube fold is a 90° turn in that plane, so those jobs also generate a one-cell halo past the edge; when the neighbour is already baked, the new tile's DEM is resampled and blended against that halo. Isolated lon/lat crops still go through `tiff-export`.

**Needs a real bake.** `bun run check:tiles` proves the warp on a spherical field, not 90 m noise. Pick two tiles that share a **cube edge** (not two on the same face), bake both, and crop the join from orbit and at Maps-style zoom. Same-face pairs are a different path (shared origin). A cube corner (three faces) is the ugly case and still unchecked.

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

Writes `preview/<name>/` (gitignored):

| Path | Role |
| --- | --- |
| `examples.png` | World sketch + crop windows |
| `world/*.tif` | Full equirect, **inspection only** |
| `crop-coast/`, `crop-mountains/`, `crop-climate/` | 16×12 regional tiles at `--scale` km/px |
| `manifest.json` | Project, seed, bounds, suggested SNR |

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

## Hydrology pass (after diffusion) — open

This pass is how the planet gets **believable drainage**: rivers that reach the sea, lakes in real basins, a trunk you can follow. Diffusion cannot give that. It is trained on Earth DEMs, so local landform statistics (ridge sharpness, valley spacing, crenulation) already look eroded. What it does not have is non-local coherence — a catchment, a mouth, a hanging valley that actually joins the next. That is why Carve exists, and it is a large part of whether the finished planet feels interesting.

**Open research question.** How hard to touch the bake. A second landscape-evolution pass (Shape's stream-power recipe, a real hillslope `K`, uncapped incision on every high-area cell) will slot valley floors, round ridges, and spend the high frequencies the U-Net just drew. The bake table already splits the jobs: diffusion owns landform statistics; hydrology owns drainage. Those must not use the same knobs.

Working stance, not a settled method:

- Consistency, not landform creation. D8 on an already-dissected DEM follows the model's valleys. The defects are pits, hanging segments, false divides, a trunk that never reaches the sea. Measure those first. The carve budget is the defects, not “10 Fastscape steps.”
- Breach, do not fill, except where a lake is the feature. Cap fill depth for endorheic basins. Filling a pit to the spill and painting a river across it is how the model's interior dies.
- Incise to hydraulic geometry, then stop. Target a channel depth/width from discharge. If the model's valley is already deeper, leave it. Most cells should take `Δz = 0`.
- Mask. `z_out = z_diff + Δ` with `Δ` nonzero only on the channel (and maybe a one-cell bank). No global hillslope term on inherited terrain. Optional hillslope is only for slots *this* pass just cut.
- Most of the network never enters the DEM. A 90 m cell is already a wide river. Order-1–3 streams stay a reach graph. Only trunks and real canyons edit height. Creek meanders are that graph (a spline at runtime), not extra pixels.
- The one heavy cut is a false divide: a ridge the model treated as a watershed that hydrology says is a pass. Surgical, a few cells, not a planet-wide `K`.
- Meanders are a floodplain process, not more incision. Do not D8-carve a floodplain “so the river drains.” Steepest descent through a meander belt is a cutoff and straightens it. Bedrock gorges stay dendritic; alluvial valleys keep or get a planform.

Do not reuse Shape's priority-flood + stream-power recipe on the bake. That recipe is for a 23 km blob so the model sees valleys.

Judge a trial the same way as everything else: crop a bake, run a light pass, crop the same valley. If the ridges moved, `K` is too high.

Candidate operations (structure only; strength is the open part). Run on the **90 m / 30 m DEM**, sea level still at 0.

1. **Fill or breach sinks** so flow can reach the ocean (priority-flood; terrain-diffusion already has `fill_depressions_priority_flood` in `inference/postprocessing.py`). Prefer breach. Cap fill depth if you want real endorheic basins.
2. **Route flow** (D8 or similar) and accumulate contributing area. Same file has `d8_flow` / `flow_accumulation`. Ocean (`z <= 0`) is the sink.
3. **Incise** along the network, only where the existing valley is shallower than the hydraulic target, or a saddle blocks a trunk. Stream-power style: carve more where area × slope is high.
4. **Hillslope** (optional, and off on inherited slopes): mild diffusion or debris-slope on walls this pass just cut, so you do not keep infinitely sharp slots. Weak diffusion in dry rock keeps canyon walls; strong diffusion in wet soil opens V-valleys.

Canyons vs ordinary valleys is a ratio, not a flag:

- **Canyon:** channel cuts down faster than slopes wear back. Needs a high surface draining to a much lower base, a trunk stream with real area, and incision ≫ hillslope smoothing.
- **Valley:** same process, more smoothing or less drop.
- **Wash:** dryness and no drop. Hydrology will not turn the pancake interior into Grand Canyon.

A single Colorado-style trench needs one master river capturing a large plateau while the rims stay high. Equal carving of every tributary gives a dissected plateau (closer to what diffusion already sketches). Bias the trunk (pour point, extra area, higher `K` on one path) if you want that look — do not raise `K` everywhere.

### Meanders and oxbows

In scope. Stream-power does not grow them: incision deepens, it does not wander.

Meander wavelength is about **10–12× channel width**. A loop train that reads as geology, not noise, wants λ ≳ 1 km, so bankfull width ≳ 70–100 m. That is a river. Oxbows are abandoned loops of that size — a Mississippi-class cutoff is a 1–5 km lake, inside the 90 m bake. A 30 m creek’s meanders are not: they live on the reach graph and in the analytic octaves below 90 m.

Three grains:

- **Aerial (90 m DEM).** Large meander belts and oxbow lakes. First keep what diffusion already drew (Earth 90 m DEMs are full of these; the U-Net will paint them in low-gradient wet valleys). Hydrology follows that centerline. `Δz` only where the channel is hanging or blocked, and stay inside the existing belt. Then, on alluvial reaches that came out too straight (large area, low slope, not a bedrock canyon), synthesize a kinematic meander (sine-generated curve, or Howard–Humber / Lancaster–Bras) and incise a narrow channel; leave the floodplain from the bake. Oxbows are cutoffs: when a neck is thin, abandon the loop and leave it as a capped lake. Graph edit plus a few metres of height, not another erosion pass.
- **Approach (optional 30 m, local).** Medium rivers, wavelength a few hundred metres. Only if low flight still looks like a canal after the 90 m belt. Not a global bake.
- **Walking (analytic, 90 m → ~0.5 m).** Creek meanders as a centerline spline with displacement, draped at runtime.

Do not grow meanders with more 90 m stream-power. Do not store every creek as extra pixels. Do not D8-carve a floodplain so it “drains” — drainage there is the belt’s own path, plus a cutoff graph for oxbows.

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

- Stay on 90 m for the planet. 30 m is not the global bake; human-scale is analytic and lazy. Compute, ship size, and the 90 vs 30 call: [full-planet-bake.md](full-planet-bake.md).
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
  /Users/korbin/dev/planetgen/preview/thalos/crop-mountains \
  /tmp/mountains.tif \
  --snr 0.2,0.2,1.0,0.2,1.0 --no-compile --device mps --seed 88
```

Judge the **heightmap**, not the green hillshade. Diffusion does not paint biomes; dryness only shows up if you color by climate or use an arid ramp.
