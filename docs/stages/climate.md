# Climate

## What it does

Climate supplies temperature, rain and seasonality on the sphere. There are
three tiers:

- **Preview** (`src/climate.js`): the fast Discover model, retained during
  Layout and Shape. Two seasonal wind solves and normalized moisture.
- **Seasonal** (`src/seasonal-climate.js`): the default for a **new campaign**.
  A seasonal energy and water balance on the finished Shape, then conservative
  downscaling to its 23 km cells. It runs on CPU before the terrain worker starts.
- **ExoPlaSim**: an optional future GCM reference. Not integrated or required.

Seasonal is intended for plausible terrain conditioning in development bakes.
It is not a quantified “80% accurate” climate or a replacement for a validated
GCM. The CLI campaign uses it; Discover and regional Shape preview tiles keep
preview climate. Existing campaigns retain their saved recipe on resume.

## Reads

| Input | From | Used for |
| --- | --- | --- |
| `r_meters`, saved mesh | Layout and Shape artifacts | coast, land fraction, mountain lift, lapse correction |
| body radius, gravity, day length, tilt | saved variant | cell grain, water column, circulation, seasonal sunlight |
| Finish options | `params.js` / `seasonal-climate.js` | sunlight, heat transport, storage, timestep, convergence |
| preview climate genes | Discover only | fast moisture and temperature previews |

Seasonal reads the **saved** sculpted Shape, never a regeneration of its seed.
**Wishes** — star spectrum, eccentricity and atmosphere composition remain unmodeled; the
implicit forcing is an Earth-like atmosphere and circular orbit with a solar
constant of 1361 W/m². Systems will own those inputs later: [systems](../systems.md).

## Hands on

| Field | Type | Units | Consumed by |
| --- | --- | --- | --- |
| `r_temperature` | f32 | normalized preview units | Discover, Shape, preview tiles |
| `r_moisture` | f32 | normalized preview units | Discover, preview tiles |
| monthly `temperature` | f32, month-major | °C | seasonal summary, downscaling |
| monthly `precipitation` | f32, month-major | mm/month | seasonal summary, downscaling |
| monthly `winds` | f32, XYZ tangent vectors | m/s | fine relief exposure |
| monthly `evaporation`, `runoff` | f32 | mm/month | coarse diagnostics |
| monthly `snowCover`, `seaIce` | f32 | fraction | diagnostic seasonal fields |
| annual `temperature` | f32 | °C | Terrain channel 1 |
| annual `temperature_std` | f32 | °C | Terrain channel 2 |
| annual `precipitation` | f32 | mm/year | Terrain channel 3 |
| annual `precipitation_cv` | f32 | % | Terrain channel 4 |

Annual temperature is the mean of twelve monthly means. Annual precipitation
is the sum of twelve totals. Seasonality uses **sample** standard deviation
(divisor 11); precipitation CV is `100 * SD(P) / (mean(P) + 1 mm)`, matching
[WorldClim's linked dismo implementation](https://raw.githubusercontent.com/rspatial/dismo/master/R/biovars.R).
The terrain importer converts temperature SD from °C to its internal °C×100.
Do not scale that TIFF twice. [Unit mapping](../ref/terrain-diffusion.md#unit-mapping).

`climate/seasonal-<key>.json` is an independent schema-1 artifact inside a
variant's output directory. It stores the coarse monthly fields, land/height,
body, options, source fingerprint and diagnostics. The key covers saved inputs,
body, settings and climate implementation files. Loading checks identity,
array sizes, physical field bounds and numerical readiness. The fine fields
are derived again from that artifact and the saved Shape. Layout and Shape
schemas are unchanged. Climate remains a coarse field, not a 90 m raster.
The current `.planet` package contains elevation; packaging climate for runtime
is still open.

## Must not regress

**Moisture is advected downwind, never supplied by a latitude paint.** Latitude
sets circulation and condensation propensity. Evaporation is the water source;
land recycling draws from finite soil storage. A dry planet must lose its
initial water instead of receiving artificial humidity from land.

Every shared edge conserves transported water and exchanged heat. Rain enters ocean, soil or
snow; runoff and permanent ice accumulation are explicit sinks. Each month's
downscaling preserves the coarse precipitation volume. Temperature receives
only the residual elevation correction: do not apply the coarse lapse twice.

A bake requires a repeating annual cycle and passing numerical budgets.
Unconverged results must fail before launching terrain generation. Existing
campaigns without a climate stamp mean **preview**; never silently upgrade
one, including with `--force`. Changed climate or Shape requires a new variant.
All face imports and tile conditioning copies must use the same climate key.

Keep `climate.js`, normalized preview mappings, and existing saved fields intact.
Judge a batch of maps and globes. Never add named geography to make Earth match.

## How it works today

The circulation grid has approximately `10000 * (radius / 6371 km)^2` cells,
with a 1000-cell minimum, plus its closing pole. Earth uses about 10k cells;
a quarter-radius body uses about 1k. The 23 km Shape remains the bake grain.

1. Aggregate land fraction and land height by spherical area.
2. Integrate a 360-day year in two-day steps, with twelve monthly mean solar
   declinations. Daily-mean sunlight handles polar day and night. An implicit
   energy balance mixes heat horizontally. Its effective diffusivity grows
   with moisture capacity in warm air and weakens in cold air; a single frozen
   coefficient on each shared edge conserves heat. Land and mixed-layer ocean
   have different heat capacities. Snow, dry ground and sea ice affect albedo.
3. Parameterize trades, westerlies and meridional flow from latitude and day
   length. Broad land/sea temperature anomalies add thermal winds, accounting
   for radiation and evaporative cooling at the existing latent coupling.
   The wind driver excludes condensation heating aloft, which otherwise
   attracts still more rain without a solved momentum equation. This is a
   mean circulation prescription, not a solved momentum equation.
4. Evaporate from ocean and finite soil water; transport vapor and cloud water
   conservatively with mean wind and unresolved eddy mixing. Condensation
   responds to humidity, circulation and mountain lift. Smooth humidity
   dependence represents moist eddies within a monthly mean cell. Rain,
   snow, melt, runoff and sea ice advance with the energy balance.
5. Require two successive stable years after at least six: monthly temperature
   RMS change below 0.12 °C and annual rain change below 1.5% (or 0.1 mm on a
   nearly dry planet). Stop after 30 years and reject nonconvergence. Numerical
   gates bound the water budget, iterative transport correction and thermal
   solver residual.
6. Interpolate monthly temperatures and correct residual height at 6 °C/km.
   Smooth fine residual slopes, then redistribute each source cell's rain by
   bounded wind exposure. Recompute all four terrain channels from the months.

The broad approach belongs to the energy/moisture balance family; see
[GREB hydrology](https://gmd.copernicus.org/articles/12/425/2019/).
This implementation does not import GREB's prescribed Earth winds, geography
or reanalysis corrections. Its orographic pass is a bounded approximation,
not a full cloud-resolving or Smith–Barstad solver. Only a fraction of column
latent heating couples to its effective surface layer; free-tropospheric
convection is unresolved.

The heat coefficient follows the temperature derivative of `cp*T + Lv*q`
at an assumed 80% relative humidity, normalized near 15 °C to retain the
existing transport scale. This is an effective diffusivity inspired by
[moist energy balance models](https://gmd.copernicus.org/articles/16/5515/2023/),
not a full moist-static-energy or atmospheric momentum solve. It adds no
water source and introduces no geography-specific correction or extra knob.

## Open

**Regional climate accuracy.** The [real Earth benchmark](../ref/climate-benchmark.md)
imports measured surface elevation and compares a CPU solve with published
GFDL-ESM4 historical output and WorldClim. Moisture-dependent heat transport
and evaporative cooling improve GFDL land annual temperature MAE from 4.76
to 4.03 °C and rain pattern correlation from 0.52 to 0.67. Non-glaciated land
temperature MAE improves from 3.17 to 2.75 °C. The tradeoffs remain explicit:
land rain increases too much in some regions, and GFDL temperature-seasonality
MAE rises from 1.70 to 1.81 °C. WorldClim temperature, rainfall pattern and
seasonality improve, but rain MAE rises slightly (492 to 497 mm/year).
Excessive ocean rain bands, weak East Asian rain, insufficient desert drying
and warm poles remain. No accuracy percentage or agreement with
[ExoPlaSim](https://arxiv.org/abs/2107.07685) has been measured. Snow and sea ice
are simple stores, not an ice-sheet or ocean model. One Earth comparison does
not validate other bodies or fine terrain conditioning.

**Scope of validation.** Default forcing, Earth-sized and quarter-radius
bodies, saved variants and a seed batch are exercised. Very slow/fast rotation,
extreme tilt or gravity, and unusual stellar flux require further validation;
registered option ranges are input bounds, not scientific calibration.

**Later stages.** Fine snow/ice fractions are interpolated coarse diagnostics.
Carve may require lapse updates after incision, and a runtime climate payload
still needs integration with Export. Discover's display intentionally remains
the cheap preview; use the seasonal captures to inspect the climate a campaign
will actually use.

## How to judge it

```sh
# Isolated validation; never starts terrain generation.
bun run preview:climate --project=quarter --variant=<id> --out=work/climate/review
bun run preview:climate --project=earth --out=work/climate/earth
bun run sheet:climate --project=quarter --out=work/climate/sheet
bun run check:climate

# Actual measured Earth, separate from the authored --project=earth fixture.
# Requires the benchmark Python dependencies and downloaded reference.
bun run benchmark:climate

# Prepare a saved variant's climate; still no terrain generation.
bun run finish:climate --project=quarter --variant=<id>

# Read-only campaign selection / resume check.
bun run bake:campaign --project=quarter --variant=<id> --level=3 --seam=symmetric --fine-mask --dry-run
```

Inspect `climate-map-compare.png`, `climate-globe-compare.png`, the annual
physical fields and seasonal maps. Large Earth captures use a 64k-cell drawing
mesh; computation and downscaling still use the full Shape. Crop mountain
slopes to look for speckling and rain shadows; inspect wet coasts, inland drying,
seasonal land/ocean contrast, poles and the longitude seam across the batch.
The measured-Earth benchmark adds GCM/observational errors and sensitivity
experiments; [setup, sources and comparison rules](../ref/climate-benchmark.md).

On this machine the revised solver took about **8 seconds on Rill** and
**76 seconds on measured Earth**, while other CPU validation ran; generation,
downscaling and drawing add time. These are
measured default climate solves, not a guaranteed total bake time.

Mechanism checks cover polar sunlight, water and heat conservation, dry-planet depletion,
seasonal storage, mountain response, timestep sensitivity, body-driven winds,
conservative downscaling, physical terrain units and cache/resume identity.
`validate-climate-td.mjs` prepares an isolated five-TIFF import;
`check-climate-td.py` validates the actual sibling importer and generates only
one 256×256 native terrain cell on CPU. It never attaches to a campaign worker.
The Rill trial checks all five importer units and produces a finite,
varied terrain patch. This establishes that the
conditioning path works; a single patch does not validate global landform quality.
The active campaign's saved inputs and worker sources can be audited separately
with `check-climate-integration.mjs --audit-active=<baseline-json>`.
