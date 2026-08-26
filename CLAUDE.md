# planetgen

This repo generates a coarse planetary **base**: tectonic plates, a heightmap, and climate. Later stages add detail. Do not try to make a finished Earth in here.

## Earth-like

The goal is a generator that, given a new seed, produces another plausible Earth-like planet. "Earth-like" means the general physical rules that make a planet of this kind look right: plate tectonics, isostasy, half-space cooling, moisture advection, Hadley cells, land that clusters instead of spreading evenly. It does not mean Earth's particular continents, ocean layout, mountain names, or any other accident of this planet's history.

Earth is a reference for *kinds* of outcomes, not a scoreboard. A seed
shuffle should yield another believable world. Judge a change from the
pictures — capture, compare, crop in — on whether most seeds *look* like
planets that could exist, not on whether a metric moved toward Earth's
numbers. `bun run stats` and `bun run climate` are optional helpers when a
picture looks collapsed; they are not the verdict.

Do not hard-code this planet's geography into the model. Do not pin a Pacific, a Sahara, or an Andes at a named longitude. Do not grow continents toward a reconstruction of Pangaea or today's landmasses. If a rule only works because it copies Earth, it is the wrong rule.

The tectonic model lives in `tectonics.js`, kept free of WebGL and DOM so
captures and the optional headless helpers share one model:

```
bun run preview                              # globe + equirect — start here
bun run preview plates                       # plate shapes and motion
bun run preview crust                        # ridges, trenches, sea-floor age
bun run preview climate                      # moisture field on its own
bun run preview relief                       # hypsometric tint and hillshade
bun run crop preview/thalos/equirect.png --x=800 --y=200 --w=600 --h=400
bun run sheet                                # 12 seeds in one contact sheet, preview/thalos/seed-sheet.png
bun run sheet --count=9 --view=globe --overlay=plates
bun run preview --earth                      # Earth project (present-day fixture)
bun run check:projects                       # projects resolve, and loading one clears the last
```

`bun run stats`, `bun run climate`, and `bun run check:earth` exist if a
picture looks wrong and you want a hint, or if the Earth fixture drifted.
Do not lead with them, and do not treat a green number as done.

The climate model lives in `climate.js`, also browser-free. Moisture is
carried downwind from the sea rather than painted on by latitude, which is
what gives continents a wet and a dry coast instead of one dry girdle; see
`.cursor/rules/climate.mdc`.

Judge how the planets *look* from captures and from `sheet` — a failure
mode that hits every seed reads as a bad roll if you only ever capture one.
Continents are seeded as aggregates of welded cratonic blocks, not a noise threshold. A plate is a rigid
body made of sites that rotate with it, so its boundaries are arcs meeting at
triple junctions and it stays one coherent body; each has a stable id, a
generated name, a birth time and a parent, and keeps them through rifts and
collisions. Plates rotate about Euler poles in a no-net-rotation frame; the crust carries a type, age and thickness that the plates advect over ~200 Myr; ocean depth comes from half-space cooling on sea-floor age and land height from isostasy on crustal thickness. See `.cursor/rules/plates-elevation.mdc` for what must not regress.

## Downstream

1. **Carve** — rivers, lakes, canyons, fjords, and sub-23 km stamps (atolls, reefs, islets) on the baked DEM. Hydrology is the drainage work inside it. The detail pass only roughs drainage texture on the sketch; the fine network is cut after Terrain.
2. **[terrain-diffusion](https://github.com/xandergos/terrain-diffusion)** — fine-scale terrain on top of the sketch. Preview tiles are a Shape **tool**: pick them on the cubesphere grid, bake, drape. CLI: `bun run export:td` writes `preview/<name>/`. Do not vendor the model; do not `tiff-export` the whole-world raster. How Discover and Finish fit together: [`docs/studio.md`](docs/studio.md).

   Tiles are picked on the **cubesphere grid** (`src/cubesphere.js`), the same
   grid the planet-scale bake will use: six equal-angle faces, a quadtree per
   face, a tile addressed by `(face, level, i, j)` and nothing else. Hold
   shift over the canvas to see the grid and a ghost of the tile under the
   cursor; click a tile, or drag across several; each picked tile becomes its
   own bake job. Because levels nest, picking a coarse tile still picks whole
   bake tiles. `bun run check:tiles` holds the grid to being a real partition
   — every direction in exactly one tile, centres round-tripping, levels
   nesting — and pins the equal-angle scale ratio at √2.

   What lands on the map is `output.elev`, the DEM in raw float metres,
   coloured in the browser with the globe's own surface look. Not
   `output.png`: that was coloured once at bake time and could never follow
   the map. Do not reintroduce a lon/lat crop box — a box centred on wherever
   the mouse was is what the grid replaced.

   The grid draws **unconditionally** — every face, every line, fixed
   subdivision, at every viewpoint. Do not add a visibility probe, a
   minimum-cell-size threshold, or view-dependent subdivision to make it
   cheaper. Each of those turns a smoothly varying measurement into a binary
   draw/skip, and the grid flickers as the view moves; all three were tried
   and reverted. Cull only on things that do not depend on the viewpoint: the
   globe's back-face test, and an antimeridian break measured in **longitude**
   (never in screen pixels — at high zoom one ordinary segment exceeds half
   the canvas, which silently chopped the grid to pieces).

Keep the base honest enough that those stages have something real to work with: continents carried by plates, mountain belts at collisions, ocean floor that deepens away from its ridge, and coasts that come from elevation interpolation rather than plate outlines. The detail pass roughs in valleys and fjords; leave the real river network to the later pass.

Do not flatten ocean basins, floor continental plates, or grow land as blobs that fill a plate. That is what made coasts snap to plate edges. Crust type is seeded from noise, independent of the plate partition, so a plate can carry a continent and an ocean at once.

The original 1843 distance-field blend is still available for comparison: the **Simulate tectonics** toggle, or `bun run preview --no-tectonics`. Merging adjacent ocean plates and connecting all water into one world ocean are optional UI toggles (off by default).

## In scope

- Tectonic plates, plate motion, and the tectonic history that shapes them
- Elevation (land relief, ocean bathymetry)
- Climate (temperature, moisture, biomes) as fields on the sphere
- A globe view that shows those fields clearly
- Regional terrain-diffusion preview tiles, overlaid on the project (a Shape tool, not a Progress stage)
- Pipeline status: Layout, Shape, Climate, Terrain, Carve, Export

## Out of scope

- Real river networks, discharge, lakes, canyons, fjords, atolls (those wait for **Carve**)
- Photographic globe effects (atmosphere, clouds, specular water) unless we are judging the base
- Vendoring terrain-diffusion or the hydrology sim into this tree. The studio orchestrates the sibling checkout.

## Visual check

This is an aesthetic pursuit. The planet is a WebGL canvas. You cannot see
it until you capture a PNG. Do not finish visual work from code or from a
number. Read the picture, crop in on the feature you are judging, compare
before and after.

```
bun run preview                 # globe 2x2 + equirect
bun run preview globe
bun run preview equirect
bun run preview equirect --lon=90
bun run preview plates          # plates + motion arrows (globe and equirect)
bun run preview plates equirect
bun run preview crust           # sea-floor age, orogeny, boundary types
bun run preview climate         # the moisture field on its own
bun run preview relief          # hypsometric tint and hillshade
bun run preview --no-tectonics  # the 1843 blend, for comparison
```

Then read the **compare** sheet for that view if it exists, otherwise the latest capture. Crop in when the feature is small on the full frame (`bun run crop preview/thalos/equirect.png --x=800 --y=200 --w=600 --h=400` → `preview/thalos/crop.png`).

| Capture | Files | What it shows | Use when |
| --- | --- | --- | --- |
| **globe** | `preview/thalos/planet.png`, `preview/thalos/compare.png` | 2×2 of longitudes 0°, 90°, 180°, 270° | 3D relief, hillshading, how land sits on the sphere, polar caps as seen from space, mesh/camera |
| **equirect** | `preview/thalos/equirect.png`, `preview/thalos/equirect-compare.png` | Full 2:1 map, north up, lon 0 at center (`--lon` shifts that) | Whole-world layout, continent arrangement, east–west wrap, climate belts, ice as latitude bands, land/ocean fraction |
| **plates** | `preview/thalos/plates.png`, `preview/thalos/equirect-plates.png` (and their `-compare` sheets) | One color per plate, darker = underwater, named, with motion arrows and time since the plate formed | Plate size and shape, mixed land/ocean on a plate, relative motion |
| **crust** | `preview/thalos/crust.png`, `preview/thalos/equirect-crust.png` (and their `-compare` sheets) | Sea floor pale = young to dark = old; land red = orogeny; orange = ridge, cyan = trench, yellow = transform | What the simulation is doing: ridge systems and the age gradient beside them, subduction zones, transform segments |
| **climate** | `preview/thalos/climate.png`, `preview/thalos/equirect-climate.png` (and their `-compare` sheets) | Moisture alone: sand = arid, olive = steppe, green = forest, teal = saturated | Judging moisture. The biome colours compress the middle of the range, so a real change can look like no change on the finished map |
| **relief** | `preview/thalos/relief.png`, `preview/thalos/equirect-relief.png` (and their `-compare` sheets) | Hypsometric tint + hillshade: blue ocean, green lowlands, brown mountains, white peaks | Judging elevation. Surface biomes hide belts and basin shape; this look does not |

`bun run check:earth` locks the Earth fixture's `stats` report to a checked-in
baseline (`scripts/earth-baseline.txt`) so a model change cannot drift Earth
unnoticed. It is a tripwire, not a taste test: if it fails, look at the
Earth captures, decide whether the picture moved the right way, then
`bun run check:earth --update` to accept the new numbers.

The planet's physical properties live in `world.js` — radius, gravity, land
fraction, day length, tilt, age — separate from the model parameters because all
three models read them. Every derivation there is a ratio against Earth and is
exactly 1 at Earth's defaults, so a default run is bit-identical to one from
before they existed. `landFraction` is solved for exactly by shifting sea level
after the run (`solveSeaLevel`), so it is what you get rather than what you aim
at; null leaves sea level where the crust puts it.

Work is done in a **project**. There are two: Thalos (the default, the world
being discovered) and Earth (the present-day reference fixture). A project
file holds the adopted **body**. Earth is the **fixture**: authored knobs and
a seed token, no tree. A **variant** is a saved snapshot (layout seed, shape
seed, body, genes, body pins, ranges, parent). Every Save writes a child of
head. Search is layout only; Shape is an explicit cached pass. Finish
runs on the variant you name. How this works: `docs/studio.md`.
Captures, crops and preview tiles belong to a variant and live in
`preview/<name>/v/<id>/` (Earth and a project with no variant still use
`preview/<name>/`). Loading one *assigns* the authored bag rather than
merging it — otherwise a knob the new file does not name keeps the last
value and the planet belongs to neither. Headless scripts follow the same
default: `bun run preview` is Thalos, `--earth` / `--project=earth` is
Earth. `params.js` is the registry of all parameters with their units and
ranges; it validates project files and throws if a parameter is added
without being registered.

After a geography / climate / colormap change, capture the default (both) and **read both**. After a plate or plate-motion change, also run `bun run preview plates` and **read both plate captures**. After a change to the simulation itself, read `bun run preview crust` — ridges, trenches, age — not a stats dump. A globe can hide the far side; an equirect can hide how the same land looks as a planet. For lighting, camera, or mesh work, globe is enough. For “where is everything” questions, equirect is enough — pass `--lon` if the feature you care about is split across the antimeridian. Crop in rather than guessing from a thumbnail.

Previous shots: `preview/thalos/planet-before.png`, `preview/thalos/equirect-before.png`, `preview/thalos/plates-before.png`, `preview/thalos/equirect-plates-before.png`, `preview/thalos/history/`. `--earth` writes the same files under `preview/earth/`.

Do not open the interactive app in any built-in agent browser (Simple Browser, MCP browser, Cursor browser, etc.). Tell the user they can run `bun run dev` and open `http://localhost:3000` themselves.
