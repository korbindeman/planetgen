# Climate

**Live heuristic, shipping. Second tier researched, untried.**

## What it does

Puts temperature and moisture on the sphere, which decide biomes, where
ice belongs, and four of the five channels terrain-diffusion reads.

Two tiers, and they sit at different points in the pipeline:

- **`climate.js`** — the in-loop model. Runs during [Layout](layout.md)
  on the ~10k mesh and is resampled onto the sketch by
  [Shape](shape.md). Fast, browser-free, iterated on constantly. This is
  what ships today.
- **Bake-time climate** — a real GCM on the finished height, run once in
  Finish. **Recommended, not built.** Skipped entirely if the sketch keeps
  `climate.js`.

The stage table calls Climate a Finish stage because that is where the
second tier would run. The first tier is already inside Discover. That is
a wrinkle in the enumeration, not a bug.

## Reads

| Input | From | Used for |
| --- | --- | --- |
| `meters` / `r_meters` | Layout, then Shape | land vs sea, orographic lift, lapse rate |
| body — tilt, day length, radius | the variant | season swing, wind band spacing |
| climate genes | the variant's ranges | rain-out rate, recycling, season shift |

**Wishes** — nothing outstanding from upstream. What this stage needs is
better physics, which is [§ Open](#open).

## Hands on

| Field | Type | Units | Consumed by |
| --- | --- | --- | --- |
| `r_temperature` | f32 | model units, mapped to °C on export | Shape (ice), biomes, Terrain channel 1 |
| `r_moisture` | f32 | model units, mapped to mm/yr on export | biomes, Terrain channel 3 |

Terrain needs five channels and climate supplies four. The two it does
not store — `temperature_std` and `precipitation_cv` — are **derived at
export time** from latitude, inland dryness and seasonality. That is the
weakest join in the pipeline: they are heuristics standing in for a
seasonal cycle nothing here actually simulates. A GCM would drop all four
out of a 12-month climatology instead. Mapping in
[ref/terrain-diffusion.md](../ref/terrain-diffusion.md#unit-mapping).

Climate ships to the game at the **coarse cell (~23 km)**, never as a
90 m raster.

## Must not regress

**Moisture is advected, never painted on by latitude.** Air picks up
water over the sea, travels downwind, rains some out at every step, and
arrives inland already depleted. Latitude only sets how readily air rains
out — the Hadley circulation — not how much water is there.

This is not decoration. It is the only way to get the thing that most
distinguishes Earth's climate map from a set of stripes: the subtropical
dry belt is not a girdle. The Sahara and the Namib are dry while Florida
and south-east China, at the same latitude, are wet. In the trade-wind
belt the wind is easterly, so a continent's east coast gets fresh
maritime air and its west coast gets air that has already crossed the
land; under the westerlies it reverses. Rain shadows fall out of the same
mechanism.

Do not:

- Replace advection with a distance-to-ocean falloff, or add one on top
- Drop `recycling`. Land returns about half its rain to the passing air —
  half the Amazon's rainfall is water the forest itself evaporated.
  Without it every continental interior becomes desert no matter what
  else is tuned.
- Drop the two-season solve. A single fixed wind field leaves big
  landmasses uniformly arid; averaging the two solstices is what a
  monsoon is.
- Shift the wind bands as far as the rain belt. `windSeasonShift` is
  deliberately smaller than `seasonShift`: Earth's ITCZ swings much
  further than the trades do, and moving the wind bands the full amount
  averages a subtropical cell over both trade and westerly regimes,
  cancelling the asymmetry that is the whole point.

`colormap.js` is part of this. Its middle row is savanna and tropical
grassland; those entries have to stay clearly greener than the desert row
above them, or any land of middling moisture reads as sand.

## How it works today

`climate.js` holds the whole model, free of WebGL and DOM. Advected
moisture against latitude-banded winds, solved at two solstices and
averaged, with land recycling. Temperature is latitude plus elevation.

It is a heuristic, and that is the right choice for something that reruns
on every shuffle. It is not where final realism should come from.

**This generator is not a hot-desert world.** On seed 88 land
precipitation's 10th percentile was ~150 mm/yr and dry interiors were
~16–18 °C. You get rain-shadow and steppe, not Sahara. If a later pass
needs arid plateaus, overwrite the conditioning channel on that crop —
that is a conditioning edit, not a climate rewrite.

## Open

**Bake-time climate: ExoPlaSim — recommended, needs one trial.**

Run a real GCM on the finished heightmap and derive the conditioning
channels from physics instead of from latitude heuristics.

- ExoPlaSim is PlaSim (Univ. Hamburg intermediate-complexity GCM) wrapped
  for arbitrary planets. `pip install exoplasim`, custom topography and
  land/sea mask as `.sra`, `Model.configure(topomap=…, landmap=…)`,
  `runtobalance()` to energy equilibrium, monthly `tas`/`pr` out as
  netCDF. T42 = 64×128 Gaussian (~310 km), ~15 min per model year on 16
  cores; a whole run is an overnight CPU job, well under $50 on a cloud
  node. GPL-2, maintenance mode (v3.4.2, Jan 2025), needs gfortran;
  Apple Silicon untested — run it on Linux.
- **All four channels** drop out of the 12-month climatology: mean temp,
  temp std, annual precip, precip CV. That replaces the two derived
  heuristics outright.
- Downscale T42 → 23 km with a CHELSA-V2-style pass (nothing
  off-the-shelf handles a planet with no weather stations): interpolate
  monthly fields, correct temperature by lapse rate — ideally diagnosed
  per-cell/month from the GCM's own vertical levels — and redistribute
  precipitation by a windward/leeward orographic index from the GCM winds
  against the fine heightmap. `koppenpasta`
  (github.com/hersfeldtn/koppenpasta) already does the lapse-rate-only
  variant on ExoPlaSim output and is the reference.

Why bother: real circulation — Hadley cells, monsoons, rain shadows,
wet-west/dry-east asymmetry — and it plugs terrain-diffusion's one
structural blind spot. **The model's training data was clipped to ±60°
latitude, so its worlds are statistically mid-latitude everywhere.**
Physics-derived channels pinned at high SNR are what make the output read
as a planet with tropics and poles rather than endless temperate terrain.

**The trial:** one T21 run (minutes per year) on a planetgen heightmap,
eyeball precip and temp against `climate.js`. If ExoPlaSim's fields are
not clearly more believable, drop the stage and keep exporting from
`climate.js`. Cheapest stage in the pipeline, biggest realism swing, zero
coupling to the hard engineering — worth doing first.

When it graduates, `export:td` grows a mode that takes bake-time rasters
instead of deriving channels.

**Also open:** after Carve incises, elevation has changed. Temperature
should be recomputed with a lapse rate if climate must stay consistent,
and biomes may need a pass. See [carve-hydrology.md](carve-hydrology.md).

## How to judge it

```sh
bun run preview climate   # the moisture field on its own
```

Crop in on a continent that should show a wet and a dry coast. That
asymmetry is the whole point and you should be able to *see* it.

**Do not judge from the finished biome map.** The biome table needs
moisture well above 0.5 before land stops looking arid, so a real
improvement in moisture can leave the finished map looking unchanged.
Rendering the biome colours and reasoning backwards about what the
moisture must have been is how you end up tuning the wrong subsystem.

`bun run climate` can confirm the sign if a picture is ambiguous. It is
not the verdict.
