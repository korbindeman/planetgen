# planetgen

This repo generates a coarse planetary **base**: tectonic plates, a heightmap, and climate. Later stages add detail. Do not try to make a finished Earth in here.

Work is done in a **project**. Thalos is the default (development). Earth is the fixture (`--earth` / `--project=earth`), not a tree. A project file holds the adopted body. A **variant** is a saved snapshot — layout seed, shape seed, body, genes, pins, ranges, parent — not a saved seed. Every Save is a child of head. Artifacts live under `preview/<name>/v/<id>/`. How the studio works: `docs/studio.md`.

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
```

`bun run stats` and `bun run climate` exist if a picture looks wrong and
you want a hint. Do not lead with them, and do not treat a green number as
done.

The climate model lives in `climate.js`, also browser-free. Moisture is
carried downwind from the sea rather than painted on by latitude, which is
what gives continents a wet and a dry coast instead of one dry girdle; see
`.cursor/rules/climate.mdc`.

Judge how the planets *look* from captures and from `sheet` — a failure
mode that hits every seed reads as a bad roll if you only ever capture one.
Continents are seeded as cratons, not a noise threshold. A plate is a rigid
body made of sites that rotate with it, so its boundaries are arcs meeting at
triple junctions and it stays one coherent body; each has a stable id, a
generated name, a birth time and a parent, and keeps them through rifts and
collisions. Majors and minors are seeded differently: the majors tile the
sphere, the minors are carved out of the boundaries between them, stretched
along the margin the way the Caribbean and Cocos are — never dropped into a
major's interior, and a plate whose whole edge touches one neighbour (an
enclave, which Earth does not have) is absorbed on sight. Plates rotate about Euler poles in a no-net-rotation frame; the crust carries a type, age and thickness that the plates advect over ~200 Myr; ocean depth comes from half-space cooling on sea-floor age and land height from isostasy on crustal thickness. Subduction acts on
the plates themselves: sites overridden at a converging margin are consumed
(density decides which side sinks — continents never do, they collide), ridges
get those sites back as new ones, and trenches calve back-arc microplates so
the census Earth keeps is kept here too. See `.cursor/rules/plates-elevation.mdc` for what must not regress.

## Downstream

1. **Hydrology** — real river networks, discharge, lakes and canyons. The detail pass does a first-stage shaping (priority-flood, stream power, glacial fjords) so slopes and coasts have drainage texture; the fine network is cut after diffusion.
2. **[terrain-diffusion](https://github.com/xandergos/terrain-diffusion)** — fine-scale terrain on top of the sketch. Preview tiles are a Discover tool (pick on the cubesphere grid, bake, drape). CLI: `bun run export:td` writes `preview/<name>/`. Do not vendor the model; do not `tiff-export` the whole-world raster. What the model expects: [`docs/preparing-for-diffusion.md`](docs/preparing-for-diffusion.md). How the studio works: [`docs/studio.md`](docs/studio.md).

Keep the base honest enough that those stages have something real to work with: continents carried by plates, mountain belts at collisions, ocean floor that deepens away from its ridge, and coasts that come from elevation interpolation rather than plate outlines. The detail pass roughs in valleys and fjords; leave the real river network to the later pass.

Do not flatten ocean basins, floor continental plates, or grow land as blobs that fill a plate. That is what made coasts snap to plate edges. Crust type is seeded from noise, independent of the plate partition, so a plate can carry a continent and an ocean at once.

The original 1843 distance-field blend is still available for comparison: the **Simulate tectonics** toggle, or `bun run preview --no-tectonics`. Merging adjacent ocean plates and connecting all water into one world ocean are optional UI toggles (off by default).

## In scope

- Tectonic plates, plate motion, and the tectonic history that shapes them
- Elevation (land relief, ocean bathymetry)
- Climate (temperature, moisture, biomes) as fields on the sphere
- A globe view that shows those fields clearly
- Regional terrain-diffusion preview tiles, overlaid on the project (a Discover tool, not a Progress stage)
- Pipeline status: Layout, Shape, Climate, Terrain, Hydrology, Export

## Out of scope

- Real river networks, discharge, lakes and canyons (those wait for the post-diffusion hydrology pass)
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

After a geography / climate / colormap change, capture the default (both) and **read both**. After a plate or plate-motion change, also run `bun run preview plates` and **read both plate captures**. After a change to the simulation itself, read `bun run preview crust` — ridges, trenches, age — not a stats dump. A globe can hide the far side; an equirect can hide how the same land looks as a planet. For lighting, camera, or mesh work, globe is enough. For “where is everything” questions, equirect is enough — pass `--lon` if the feature you care about is split across the antimeridian. Crop in rather than guessing from a thumbnail.

Previous shots: `preview/thalos/planet-before.png`, `preview/thalos/equirect-before.png`, `preview/thalos/plates-before.png`, `preview/thalos/equirect-plates-before.png`, `preview/thalos/history/`. `--earth` writes the same files under `preview/earth/`.

Do not open the interactive app in any built-in agent browser (Simple Browser, MCP browser, Cursor browser, etc.). Tell the user they can run `bun run dev` and open `http://localhost:3000` themselves.
