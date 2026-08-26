# planetgen

This repo generates a coarse planetary **base**: tectonic plates, a heightmap, and climate. Later stages add detail. Do not try to make a finished Earth in here.

**Start at [`docs/README.md`](docs/README.md).** The generator is a pipeline of stages and there is one doc per stage; that index says which one you want. Do not restate a stage doc here or in `.cursor/rules/` — those are pointers and invariants, the stage doc is the source.

## Earth-like

The goal is a generator that, given a new seed, produces another plausible Earth-like planet. "Earth-like" means the general physical rules that make a planet of this kind look right: plate tectonics, isostasy, half-space cooling, moisture advection, Hadley cells, land that clusters instead of spreading evenly. It does not mean Earth's particular continents, ocean layout, mountain names, or any other accident of this planet's history.

Earth is a reference for *kinds* of outcomes, not a scoreboard. A seed shuffle should yield another believable world. Judge a change from the pictures — capture, compare, crop in — on whether most seeds *look* like planets that could exist, not on whether a metric moved toward Earth's numbers.

Do not hard-code this planet's geography into the model. Do not pin a Pacific, a Sahara, or an Andes at a named longitude. Do not grow continents toward a reconstruction of Pangaea or today's landmasses. If a rule only works because it copies Earth, it is the wrong rule.

## The pipeline

| Stage | Grain | Doc | The one rule |
| --- | --- | --- | --- |
| **Layout** | ~10k cells | [docs/layout.md](docs/layout.md) | Coasts are interpolated from a continuous field, never stamped from plate outlines. Raising `N` makes it worse. |
| **Shape** | 23 km sketch | [docs/shape.md](docs/shape.md) | A body is at least two cells. Do not finish coasts or drainage here. |
| **Climate** | 23 km fields | [docs/climate.md](docs/climate.md) | Moisture is advected downwind, never painted on by latitude. |
| **Terrain** | 90 m DEM | [docs/terrain.md](docs/terrain.md) | Do not vendor terrain-diffusion. Do not `tiff-export` the whole world. |
| **Carve** | 90 m DEM | [hydrology](docs/carve-hydrology.md), [landforms](docs/carve-landforms.md) | Diffusion owns landform statistics; hydrology owns drainage. Different knobs. |
| **Export** | residual pyramid | [docs/export.md](docs/export.md) | Ship the pyramid, never the dense bake. |

**Discover** is Layout and Shape; **Finish** is Climate through Export. The harness — projects, variants, what a Save is — is [`docs/studio.md`](docs/studio.md), canonical. The words are [`CONTEXT.md`](CONTEXT.md).

`tectonics.js`, `climate.js` and `detail.js` are kept free of WebGL and DOM so captures and the headless helpers share one model.

## Projects and variants

Work is done in a **project**. There are two shipped: Thalos (the default, the world being discovered) and Earth (the present-day reference fixture, `--earth` / `--project=earth`, no tree). A **variant** is a saved snapshot — layout seed, shape seed, body, genes, pins, ranges — not a saved seed. Every Save writes a new snapshot; the name decides which line it joins. Artifacts belong to a variant: `preview/<name>/v/<id>/`.

Loading a project *assigns* the authored bag rather than merging it — otherwise a knob the new file does not name keeps the last value and the planet belongs to neither. `params.js` is the registry of every parameter with its unit and range; it validates project files and throws if a parameter is added without being registered. `world.js` holds the body — radius, gravity, day, tilt, age, water — separate from the model parameters because all three models read it. Every derivation there is a ratio against Earth and is exactly 1 at Earth's defaults.

Details: [`docs/studio.md`](docs/studio.md).

## Visual check

This is an aesthetic pursuit. The planet is a WebGL canvas. **You cannot see it until you capture a PNG.** Do not finish visual work from code or from a number. Read the picture, crop in on the feature you are judging, compare before and after.

```
bun run preview                 # globe 2x2 + equirect — start here
bun run preview plates          # plate shapes and motion
bun run preview crust           # ridges, trenches, sea-floor age
bun run preview climate         # the moisture field on its own
bun run preview relief          # hypsometric tint and hillshade
bun run preview equirect --lon=90
bun run preview --no-tectonics  # the 1843 blend, for comparison
bun run preview --earth         # the Earth fixture
bun run sheet                   # twelve seeds on one contact sheet
bun run crop preview/thalos/equirect.png --x=800 --y=200 --w=600 --h=400
```

Then read the **compare** sheet for that view if it exists, otherwise the latest capture.

| Capture | Files | What it shows | Use when |
| --- | --- | --- | --- |
| **globe** | `preview/thalos/planet.png`, `compare.png` | 2×2 of longitudes 0°, 90°, 180°, 270° | 3D relief, hillshading, how land sits on the sphere, polar caps, mesh/camera |
| **equirect** | `equirect.png`, `equirect-compare.png` | Full 2:1 map, north up, lon 0 centred (`--lon` shifts) | Whole-world layout, continent arrangement, east–west wrap, climate belts, land/ocean fraction |
| **plates** | `plates.png`, `equirect-plates.png` (+ `-compare`) | One colour per plate, darker = underwater, named, motion arrows, age | Plate size and shape, mixed land/ocean on a plate, relative motion |
| **crust** | `crust.png`, `equirect-crust.png` (+ `-compare`) | Sea floor pale = young to dark = old; land red = orogeny; orange ridge, cyan trench, yellow transform | What the simulation is actually doing |
| **climate** | `climate.png`, `equirect-climate.png` (+ `-compare`) | Moisture alone: sand arid → teal saturated | Judging moisture. Biome colours compress the middle, so a real change can look like none |
| **relief** | `relief.png`, `equirect-relief.png` (+ `-compare`) | Hypsometric tint + hillshade | Judging elevation. Surface biomes hide belts and basin shape |

Read **both** globe and equirect after a geography, climate or colormap change. After a plate or plate-motion change, read **both plate captures**. After a change to the simulation itself, read `crust`. A globe hides the far side; an equirect hides how the same land looks as a planet. For lighting, camera or mesh work, globe is enough.

Judge the **batch**, not one seed: a failure mode that hits every seed reads as a bad roll if you only ever capture one. That is what `sheet` is for. Previous shots are `*-before.png` and `preview/thalos/history/`.

`bun run stats` and `bun run climate` are optional hints when a picture looks collapsed. Do not lead with them and do not treat a green number as done.

`bun run check:earth` locks the Earth fixture's `stats` report to `scripts/earth-baseline.txt` so a model change cannot drift Earth unnoticed. It is a tripwire, not a taste test: if it fails, look at the Earth captures, decide whether the picture moved the right way, then `--update`. Also: `check:projects`, `check:search`, `check:tiles`, `check:pipeline`, `check:td`.

**Do not open the interactive app in any built-in agent browser** (Simple Browser, MCP browser, Cursor browser). Tell the user they can run `bun run dev` and open `http://localhost:3000` themselves.

## In scope

- Tectonic plates, plate motion, and the tectonic history that shapes them
- Elevation (land relief, ocean bathymetry)
- Climate (temperature, moisture, biomes) as fields on the sphere
- A globe view that shows those fields clearly
- Regional terrain-diffusion preview tiles, overlaid on the project (a Shape tool, not a stage)
- Pipeline status: Layout, Shape, Climate, Terrain, Carve, Export

## Out of scope

- Real river networks, discharge, lakes, canyons, fjords, atolls — those wait for **Carve**, after the 90 m bake
- Photographic globe effects (atmosphere, clouds, specular water) unless we are judging the base
- Vendoring terrain-diffusion or the hydrology sim into this tree. The studio orchestrates the sibling checkout at `~/dev/terrain-diffusion`.

## Origin

Forked from [Amit Patel's 1843 planet generation experiment](https://www.redblobgames.com/x/1843-planet-generation/). The original distance-field blend is still available for comparison behind the **Simulate tectonics** toggle.
