# Real Earth climate benchmark

The benchmark imports measured Earth geography into the seasonal solver's
existing land-fraction/land-height representation. It compares the result with
a published coupled GCM and with WorldClim. It never opens a saved project,
rewrites a variant, starts terrain generation, or connects to a bake worker.

The authored `--project=earth` fixture is useful for visual regression but is
not measured topography. This benchmark deliberately has a separate input.
The seasonal algorithm and its contract remain in [Climate](../stages/climate.md).

## Sources and representation

- **Input:** [WorldClim 2.1 elevation](https://www.worldclim.org/data/worldclim21.html),
  10 arc minutes (about 18.5 km north–south), WGS84, metres. Valid elevation
  pixels supply the land mask. This includes surface elevation over ice sheets;
  the sibling `etopo_10m.tif` is bedrock and must not be used as an ice surface.
  Inland water follows the source mask. Negative land stays land but its height
  is clamped to zero to fit the current nonnegative land-height contract.
- **GCM reference:** NOAA-GFDL **GFDL-ESM4**, CMIP6 `historical`, `r1i1p1f1`,
  `gr1/v20190726`. Monthly `Amon/tas` (K) and `Amon/pr` (kg m⁻² s⁻¹),
  plus fixed `orog` (m) and `sftgif` (%). These are raw published model output,
  not reanalysis or statistically downscaled observations. The benchmark uses
  the **1970–2000** monthly climatology. See [GFDL CMIP](https://www.gfdl.noaa.gov/cmip/)
  and [Pangeo's public CMIP6 archive](https://pangeo-data.github.io/pangeo-cmip6-cloud/accessing_data.html).
- **Observational cross-check:** WorldClim 2.1 BIO1, BIO4, BIO12 and BIO15,
  nominal period 1970–2000, from the sibling checkout's existing 10-arc-minute
  files. Temperature SD is BIO4 divided by 100. This comparison excludes core
  land with at least 5% GCM glacier coverage; polar and sparse-station estimates
  remain uncertain. WorldClim is not a second GCM.

Only elevation, land fraction and Earth's radius, gravity, rotation and tilt
enter the simulation. No observed temperatures, rainfall, winds, named
deserts or ocean currents are supplied to it. Source checksums and full GCM
metadata are retained. GFDL's data and derived reference maps retain their
**CC-BY-SA 4.0** license and attribution, separate from the repository's code
license; the source's full license is in `reference/provenance.json`.

The importer assigns each 10-arc-minute pixel's spherical area to its nearest
solver cell and calculates fractional land cover and mean land elevation.
This is finite pixel quadrature over approximate Voronoi cells, not exact
intersection with the solver's barycentric dual cells. The default input has
10,001 circulation cells. Its sampled land fraction is 30.239%; the solver's
dual-area-weighted land fraction is 30.232%. About 0.44% of source land has a
negative height and is clamped. The source's shoreline and inland-water mask
are part of this boundary condition, not a target for tuning geography.

## Comparing like with like

Both models' monthly fields are averaged onto aligned **5° cells**, weighted
by spherical area. The GCM starts at 1° latitude × 1.25° longitude; our output
is sampled with the same fine pixel-to-solver mapping as the input. The
comparison has global, ocean-core (at most 5% land), land-core (at least 95%
land), and non-glaciated-land scores. Coastal mismatch remains a limitation.

GFDL uses a no-leap 365-day calendar. We compare monthly mean rain **rates**
converted to 30-day totals, then sum twelve months: annual precipitation is
always a **360-day equivalent**, matching the seasonal solver. Annual
temperature is the unweighted mean of the twelve monthly means. For GCM
comparison, temperature SD and rainfall CV are computed from those remapped
months, using the production sample-SD and `mean(P) + 1 mm` convention.

WorldClim supplies local bioclimatic summaries. Its BIO4/BIO15 are spatially
averaged and compared with spatially averaged **local** model SD/CV. This
avoids confusing seasonality of an area mean with mean local seasonality.
BIO12 is multiplied by `360/365.2425`; published BIO15 retains civil-month
length effects, so its CV comparison is approximate.

Scores include area-weighted bias, MAE, RMSE and spatial correlation, monthly
error, and regional diagnostics. None is an "accuracy percentage." Inspect
the equirectangular maps, seasonal reversals and four globe views alongside
the scores. A close global rain total can conceal misplaced wet and dry regions.

## Run it

The Python tools need `numpy`, `scipy`, `rasterio`, `matplotlib`, `numcodecs`
and `cftime`. Use a dedicated environment, or the existing sibling Python
with missing packages installed into `work/earth-climate/python` using
`pip --target`; the reference reader adds that directory to its import path.
Do not install into or update a running bake's environment. No GPU is used.

```powershell
# Set a Python interpreter with those dependencies.
$env:PLANETGEN_CLIMATE_PYTHON = (Resolve-Path ../terrain-diffusion/.venv/Scripts/python.exe).Path

# First run: fetch public reference data, import Earth, solve, compare.
bun run benchmark:climate --fetch --name=baseline

# Later runs use the downloaded reference. No network required.
bun run benchmark:climate

# A parameter experiment reuses exactly the same imported Earth.
bun run benchmark:climate run --name=lower_transport '--options={"climateHeatTransport":0.4}'
& $env:PLANETGEN_CLIMATE_PYTHON scripts/earth-climate-benchmark.py compare --runs baseline lower_transport

# Offline comparison checks; no climate model or reference download needed.
& $env:PLANETGEN_CLIMATE_PYTHON scripts/check-earth-climate-benchmark.py
```

Runs receive a timestamp name unless `--name=...` is supplied. Reusing a name
fails before solving so a later experiment cannot overwrite its baseline.
The defaults write exclusively to `work/earth-climate/`; `--out=...` selects
another benchmark directory, and `--worldclim=...` selects the four BIO TIFFs.
`--fetch` caches roughly 240 MB of compressed public data, selecting only the
two time chunks needed per monthly variable. Download metadata, checksums,
calendar, missing values, repeated months and units are checked. Failed
numerical readiness writes diagnostics and refuses a usable climate artifact.

The pieces can also run separately:

```powershell
bun run benchmark:climate grid
& $env:PLANETGEN_CLIMATE_PYTHON scripts/earth-climate-benchmark.py prepare
bun run benchmark:climate run
& $env:PLANETGEN_CLIMATE_PYTHON scripts/earth-climate-benchmark.py compare
```

Outputs include `input.json`, `input-report.json`, a normal schema-1
`<run>/climate.json`, `<run>/comparison.png`, `seasons.png`, `globes.png`,
`comparison.npz`, `run.json`, and a combined `report.json` / `README.md`.
Comparing two or more runs also writes `before-after.png`, showing the first
and last run plus GFDL on the same scales for all four terrain inputs.
`run.json` records runtime, convergence, options, source identity and code
hashes. Reference data is separate from the simulation input.

## First baseline

The first baseline solve took **45 seconds**, converging after ten annual
cycles. On 629 land-core comparison cells, annual temperature MAE was
**4.76 °C** and annual rain MAE **436 mm per 360 days**, with rain pattern
correlation **0.52**. Over non-glaciated core land, temperature MAE was
**3.17 °C** against GFDL and **3.45 °C** against WorldClim. The latter's
rain pattern correlation was only **0.40**.

The pictures show excessive zonal ocean rain bands, insufficient subtropical
drying, and weak East Asian rainfall. Polar land averaged about **12 °C too
warm** against this GCM. Annual temperature and broad land/ocean seasonality
are closer than regional hydrology. This is useful evidence about what to
improve, not validation of an "80% realistic" claim.

Two isolated sensitivity runs tested existing options. Neither justified a
production change:

| Experiment | GCM land rain MAE, mm/360 days | GCM land rain correlation | WorldClim non-ice land temperature MAE |
| --- | ---: | ---: | ---: |
| Baseline: heat transport 0.55, monsoon strength 1 | 436 | 0.52 | 3.45 °C |
| Heat transport 0.40 | 452 | 0.48 | 4.23 °C |
| Monsoon strength 2 | 456 | 0.33 | 3.53 °C |

Lower heat transport reduces the large polar error but cools other land too
much. Stronger thermal winds worsen regional rainfall. These are two local
sensitivity tests, not an optimization or evidence that all parameter tuning
will fail. Their comparison maps and complete metrics are retained alongside
the baseline. Neither parameter change was adopted.

## First physics improvement

The production solver now increases effective heat transport with atmospheric
moisture capacity and includes evaporative cooling in the thermal wind driver.
Cold air carries less latent heat; warm air carries more. Neglecting evaporation
in the wind driver made land/sea albedo differences produce excessive tropical
land highs. The existing latent coupling supplies the cooling strength; no
new tuning parameter or observed geographical correction was introduced.
The heat mechanism is inspired by [Siler, Roe and Armour (2018)](https://faculty.washington.edu/karmour/papers/Siler_etal_JClim2018.pdf)
and the [moist energy-balance formulation in CH2O-CHOO TRAIN](https://gmd.copernicus.org/articles/16/5515/2023/).
This approximation does not inherit those models' scientific validation.

The same imported Earth input produced the following area-weighted MAEs.
GFDL uses 629 core-land cells, including ice; WorldClim uses 411 non-glaciated
core-land cells. Lower is better.

| Reference / model | Annual temperature, °C | Annual rain, mm/360 days | Temperature SD, °C | Rain CV, percentage points |
| --- | ---: | ---: | ---: | ---: |
| GFDL / baseline | 4.76 | 436 | 1.70 | 22.70 |
| GFDL / improved | 4.03 | 419 | 1.81 | 21.86 |
| WorldClim / baseline | 3.45 | 492 | 1.89 | 24.40 |
| WorldClim / improved | 3.04 | 497 | 1.87 | 22.74 |

Rain pattern correlation improves from **0.52 to 0.67** against GFDL and
**0.40 to 0.58** against WorldClim. Non-glaciated land temperature MAE against
GFDL falls from 3.17 to 2.75 °C; polar-land mean warm bias falls from 12.1 to
9.1 °C. This is a useful improvement, with visible costs: mean land rain
becomes too high (894 versus GFDL's 763 mm/360 days), WorldClim rain MAE rises
about 1%, and GFDL temperature-seasonality MAE rises about 7%. Ocean annual
temperature MAE also increases slightly, from 4.58 to 4.70 °C. The model still
misses much of the desert/monsoon contrast and spatial ocean structure.

The revised measured-Earth run converged after eleven cycles in **76 seconds**
while other CPU validation ran; Rill took **8 seconds**. These timings include
the climate solve, not geography generation, drawing or terrain synthesis.
Baseline and improved artifacts, code hashes and comparison maps are retained.

Experiments with stronger evaporative thermal winds reached rain correlation
near 0.74 but overshot wet-region amounts. More selective humidity thresholds
and latitude-dependent eddy mixing improved some deserts while worsening other
rain and seasonality fields. A convergence-driven condensation experiment
failed the annual-cycle readiness gate. These candidates were not promoted.

For a matched-geography generated-world comparison, record the previous solver
source, then run:

```powershell
bun scripts/climate-regression-sheet.mjs --before=work/earth-climate/seasonal-before.js --project=quarter --out=work/climate/improved-quarter
bun scripts/climate-regression-sheet.mjs --before=work/earth-climate/seasonal-before.js --project=thalos --seeds=1,5,9 --out=work/climate/improved-thalos
```

These runs generate each geography once, solve both versions on the same
land/height input, and retain globe and equirectangular comparison sheets.
They exercise generalization without tuning continents toward Earth.

Keep sensitivity experiments separate from production defaults. A new
parameter choice should improve multiple fields and regions against both
references, then survive generated-seed and body-scale checks. Latitude-only
means should not hide misplaced rainfall; named-Earth corrections are not
allowed. Ocean heat transport, sea-ice insulation, circulation/moisture
convergence and monsoon response remain approximations worth testing.

This equilibrium model has fixed effective radiation and no prescribed
permanent ice mask; the reference has transient historical forcing, different
orography, dynamic oceans and more complete atmospheric physics. One GCM,
one Earth and a 5° comparison cannot establish performance for other worlds,
fine rain shadows or the downstream terrain bake. The benchmark makes those
differences visible without waiting for a new GCM run.
