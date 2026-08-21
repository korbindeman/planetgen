# planetgen

This repo generates a coarse planetary **base**: tectonic plates, a heightmap, and climate. Later stages add detail. Do not try to make a finished Earth in here.

The tectonic model lives in `tectonics.js`, kept free of WebGL and DOM so it can be measured without a browser:

```
bun run stats                                # compares the model against Earth
bun run stats --seeds=1,2,3 --steps=30       # any --option overrides a tectonics DEFAULTS key
bun run sheet                                # 12 seeds in one contact sheet, preview/seed-sheet.png
bun run sheet --count=9 --view=globe --overlay=plates
bun run stats --n=40000                      # the model should read the same at any mesh size
bun run climate                              # compares the climate model against Earth
```

The climate model lives in `climate.js`, also browser-free. Moisture is
carried downwind from the sea rather than painted on by latitude, which is
what gives continents a wet and a dry coast instead of one dry girdle; see
`.cursor/rules/climate.mdc`.

Run `stats` and `climate` before judging pictures, and `sheet` when judging how the planets
*look* — a failure mode that hits every seed reads as a bad roll if you only
ever capture one. Continents are seeded as cratons, not a noise threshold. A plate is a rigid
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

1. **Hydrology** — rivers, erosion, drainage. Lives in a later sim, not this generator.
2. **[terrain-diffusion](https://github.com/xandergos/terrain-diffusion)** — fine-scale terrain on top of this heightmap. Export Azgaar-style conditioning GeoTIFFs with `bun run export:td` (regional `crop-*` folders). Do not run `tiff-export` on the whole-world raster.

Keep the base honest enough that those stages have something real to work with: continents carried by plates, mountain belts at collisions, ocean floor that deepens away from its ridge, and coasts that come from elevation interpolation rather than plate outlines. Leave river valleys, dendritic coasts, and eroded slopes to the later passes.

Do not flatten ocean basins, floor continental plates, or grow land as blobs that fill a plate. That is what made coasts snap to plate edges. Crust type is seeded from noise, independent of the plate partition, so a plate can carry a continent and an ocean at once.

The original 1843 distance-field blend is still available for comparison: the **Simulate tectonics** toggle, or `bun run preview --no-tectonics`. Merging adjacent ocean plates and connecting all water into one world ocean are optional UI toggles (off by default).

## In scope

- Tectonic plates, plate motion, and the tectonic history that shapes them
- Elevation (land relief, ocean bathymetry)
- Climate (temperature, moisture, biomes) as fields on the sphere
- A globe view that shows those fields clearly

## Out of scope

- Rivers, flow accumulation, or carving valleys into the heightmap
- Photographic globe effects (atmosphere, clouds, specular water) unless we are judging the base
- Integrating terrain-diffusion or the hydrology sim into this tree

## Visual check

The planet is a WebGL canvas. You cannot see it until you capture a PNG. Do not finish visual work from code alone.

```
bun run preview                 # globe 2x2 + equirect
bun run preview globe
bun run preview equirect
bun run preview equirect --lon=90
bun run preview plates          # plates + motion arrows (globe and equirect)
bun run preview plates equirect
bun run preview crust           # sea-floor age, orogeny, boundary types
bun run preview climate         # the moisture field on its own
bun run preview --no-tectonics  # the 1843 blend, for comparison
```

Then read the **compare** sheet for that view if it exists, otherwise the latest capture.

| Capture | Files | What it shows | Use when |
| --- | --- | --- | --- |
| **globe** | `preview/planet.png`, `preview/compare.png` | 2×2 of longitudes 0°, 90°, 180°, 270° | 3D relief, hillshading, how land sits on the sphere, polar caps as seen from space, mesh/camera |
| **equirect** | `preview/equirect.png`, `preview/equirect-compare.png` | Full 2:1 map, north up, lon 0 at center (`--lon` shifts that) | Whole-world layout, continent arrangement, east–west wrap, climate belts, ice as latitude bands, land/ocean fraction |
| **plates** | `preview/plates.png`, `preview/equirect-plates.png` (and their `-compare` sheets) | One color per plate, darker = underwater, named, with motion arrows and time since the plate formed | Plate size and shape, mixed land/ocean on a plate, relative motion |
| **crust** | `preview/crust.png`, `preview/equirect-crust.png` (and their `-compare` sheets) | Sea floor pale = young to dark = old; land red = orogeny; orange = ridge, cyan = trench, yellow = transform | What the simulation is doing: ridge systems and the age gradient beside them, subduction zones, transform segments |
| **climate** | `preview/climate.png`, `preview/equirect-climate.png` (and their `-compare` sheets) | Moisture alone: sand = arid, olive = steppe, green = forest, teal = saturated | Judging moisture. The biome colours compress the middle of the range, so a real change can look like no change on the finished map |

After a geography / climate / colormap change, capture the default (both) and **read both**. After a plate or plate-motion change, also run `bun run preview plates` and **read both plate captures**. After a change to the simulation itself, run `bun run stats` first, then also read `bun run preview crust`. A globe can hide the far side; an equirect can hide how the same land looks as a planet. For lighting, camera, or mesh work, globe is enough. For “where is everything” questions, equirect is enough — pass `--lon` if the feature you care about is split across the antimeridian.

Previous shots: `preview/planet-before.png`, `preview/equirect-before.png`, `preview/plates-before.png`, `preview/equirect-plates-before.png`, `preview/history/`.

Do not open the interactive app in any built-in agent browser (Simple Browser, MCP browser, Cursor browser, etc.). Tell the user they can run `bun run dev` and open `http://localhost:3000` themselves.
