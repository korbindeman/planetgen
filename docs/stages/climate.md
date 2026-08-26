# Climate

## What it does

Climate puts temperature and moisture on the sphere. Those fields decide
biomes, where ice belongs, and four of the five channels
terrain-diffusion reads.

Two tiers. They sit at different points in the pipeline:

- **`climate.js`** — the in-loop model. Runs during [Layout](layout.md)
  on the ~10k mesh. [Shape](shape.md) resamples it onto the sketch. Fast,
  no browser, iterated on constantly. This is what ships today.
- **Bake-time climate** — a GCM on the finished height, run once in
  Finish. **Recommended, not built.** If the sketch keeps `climate.js`,
  this tier is skipped.

The stage table calls Climate a Finish stage because that is where the
second tier would run. The first tier is already inside Discover.

## Reads

| Input | From | Used for |
| --- | --- | --- |
| `meters` / `r_meters` | Layout, then Shape | land vs sea, orographic lift, lapse rate |
| body — tilt, day length, radius | the variant | season swing, wind band spacing |
| climate genes | the variant's ranges | rain-out rate, recycling, season shift |

**Wishes** — nothing outstanding from upstream. This stage needs better
physics. See [§ Open](#open).

## Hands on

| Field | Type | Units | Consumed by |
| --- | --- | --- | --- |
| `r_temperature` | f32 | model units, mapped to °C on export | Shape (ice), biomes, Terrain channel 1 |
| `r_moisture` | f32 | model units, mapped to mm/yr on export | biomes, Terrain channel 3 |

Terrain needs five channels. Climate supplies four. The two it does not
store — `temperature_std` and `precipitation_cv` — are **derived at
export time** from latitude, inland dryness and seasonality. Those two
are heuristics standing in for a seasonal cycle that nothing here
simulates. A GCM would drop all four out of a 12-month climatology
instead. Mapping in
[ref/terrain-diffusion.md](../ref/terrain-diffusion.md#unit-mapping).

Climate ships to the game at the **coarse cell (~23 km)**, never as a
90 m raster.

## Must not regress

**Moisture is advected, never painted on by latitude.** Air picks up
water over the sea. It travels downwind. It rains some out at every
step. It arrives inland already depleted. Latitude only sets how readily
air rains out — the Hadley circulation — not how much water is there.

This is the mechanism that keeps Earth's climate map from a set of
stripes. The subtropical dry belt is not a girdle. The Sahara and the
Namib are dry. Florida and south-east China, at the same latitude, are
wet. In the trade-wind belt the wind is easterly. A continent's east
coast gets fresh maritime air. Its west coast gets air that has already
crossed the land. Under the westerlies it reverses. Rain shadows fall
out of the same mechanism.

Do not:

- Replace advection with a distance-to-ocean falloff, or add one on top.
- Drop `recycling`. Land returns about half its rain to the passing air.
  Half the Amazon's rainfall is water the forest itself evaporated.
  Without recycling, every continental interior becomes desert no matter
  what else is tuned.
- Drop the two-season solve. A single fixed wind field leaves big
  landmasses uniformly arid. Averaging the two solstices is what a
  monsoon is.
- Shift the wind bands as far as the rain belt. `windSeasonShift` is
  smaller than `seasonShift` on purpose. Earth's ITCZ swings much
  further than the trades do. If the wind bands move the full amount, a
  subtropical cell is averaged over both trade and westerly regimes.
  That average cancels the wet-coast / dry-coast asymmetry.

`colormap.js` is part of this. Its middle row is savanna and tropical
grassland. Those entries must stay clearly greener than the desert row
above them. If they do not, any land of middling moisture reads as sand.

## How it works today

`climate.js` holds the whole model. It has no WebGL and no DOM. Advected
moisture against latitude-banded winds, solved at two solstices and
averaged, with land recycling. Temperature is latitude plus elevation.

It is a heuristic. That is the right choice for something that reruns on
every shuffle. It is not where final realism should come from.

This generator does not produce hot deserts. On seed 88, land
precipitation's 10th percentile was ~150 mm/yr. Dry interiors were
~16–18 °C. You get rain-shadow and steppe, not Sahara. If a later pass
needs arid plateaus, overwrite the conditioning channel on that crop.
That is a conditioning edit, not a climate rewrite.

## Open

**Bake-time climate: ExoPlaSim — recommended, needs one trial.**

Run a GCM on the finished heightmap. Derive the conditioning channels
from physics instead of from latitude heuristics.

- ExoPlaSim is PlaSim (Univ. Hamburg intermediate-complexity GCM) wrapped
  for arbitrary planets. `pip install exoplasim`, custom topography and
  land/sea mask as `.sra`, `Model.configure(topomap=…, landmap=…)`,
  `runtobalance()` to energy equilibrium, monthly `tas`/`pr` out as
  netCDF. T42 = 64×128 Gaussian (~310 km), ~15 min per model year on 16
  cores. A whole run is an overnight CPU job, well under $50 on a cloud
  node. GPL-2, maintenance mode (v3.4.2, Jan 2025), needs gfortran.
  Apple Silicon untested. Run it on Linux.
- **All four channels** would drop out of the 12-month climatology: mean
  temp, temp std, annual precip, precip CV. That would replace the two
  derived heuristics.
- Downscale T42 → 23 km with a CHELSA-V2-style pass. Nothing
  off-the-shelf handles a planet with no weather stations. Interpolate
  monthly fields. Correct temperature by lapse rate, ideally diagnosed
  per-cell/month from the GCM's own vertical levels. Then
  redistribute precipitation by a windward/leeward orographic index from
  the GCM winds against the fine heightmap. `koppenpasta`
  (github.com/hersfeldtn/koppenpasta) already does the lapse-rate-only
  variant on ExoPlaSim output. That is the reference.

A GCM can give real circulation: Hadley cells, monsoons, rain shadows,
wet-west / dry-east asymmetry. It can also fill terrain-diffusion's
structural gap. **The model's training data was clipped to ±60°
latitude.** Its worlds are statistically mid-latitude everywhere.
Physics-derived channels pinned at high SNR are what would make the
output read as a planet with tropics and poles, rather than endless
temperate terrain.

**The trial:** one T21 run (minutes per year) on a planetgen heightmap.
Compare precip and temp against `climate.js` by eye. If ExoPlaSim's
fields are not clearly more believable, drop the stage and keep
exporting from `climate.js`. This trial does not couple to the
cubesphere bake. It is worth doing first.

When it graduates, `export:td` grows a mode that takes bake-time rasters
instead of deriving channels.

**Also open:** after Carve incises, elevation changes. Temperature
should be recomputed with a lapse rate if climate must stay consistent.
Biomes may need a pass. See [carve-hydrology.md](carve-hydrology.md).

## How to judge it

```sh
bun run preview climate   # the moisture field on its own
```

Crop in on a continent that should show a wet coast and a dry coast. That
asymmetry is what this stage is for. You should be able to see it.

**Do not judge from the finished biome map.** The biome table needs
moisture well above 0.5 before land stops looking arid. A real
improvement in moisture can leave the finished map looking unchanged.
If you render the biome colours and reason backwards about the moisture,
you tune the wrong subsystem.

If a picture is ambiguous, `bun run climate` can confirm the sign. It is
not the verdict.
