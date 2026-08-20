# planetgen

This repo generates a coarse planetary **base**: tectonic plates, a heightmap, and climate. Later stages add detail. Do not try to make a finished Earth in here.

## Downstream

1. **Hydrology** — rivers, erosion, drainage. Lives in a later sim, not this generator.
2. **[terrain-diffusion](https://github.com/xandergos/terrain-diffusion)** — fine-scale terrain on top of this heightmap.

Keep the base honest enough that those stages have something real to work with: continents from plates, mountain belts at collisions, abyssal plains, continental shelves. Leave river valleys, dendritic coasts, and eroded slopes to the later passes.

## In scope

- Tectonic plates and plate motion
- Elevation (land relief, ocean bathymetry)
- Climate (temperature, moisture, biomes) as fields on the sphere
- A globe view that shows those fields clearly

## Out of scope

- Rivers, flow accumulation, or carving valleys into the heightmap
- Mid-ocean "trench" ridges from fake coastline seeds; ocean plates should be shelf then a flat abyss
- Photographic globe effects (atmosphere, clouds, specular water) unless we are judging the base
- Integrating terrain-diffusion or the hydrology sim into this tree

## Visual check

The planet is a WebGL canvas. You cannot see it until you capture a PNG. Do not finish visual work from code alone.

```
bun run preview                 # globe 2x2 + equirect (default)
bun run preview globe
bun run preview equirect
bun run preview equirect --lon=90
```

Then read the **compare** sheet for that view if it exists, otherwise the latest capture.

| Capture | Files | What it shows | Use when |
| --- | --- | --- | --- |
| **globe** | `preview/planet.png`, `preview/compare.png` | 2×2 of longitudes 0°, 90°, 180°, 270° | 3D relief, hillshading, how land sits on the sphere, polar caps as seen from space, mesh/camera |
| **equirect** | `preview/equirect.png`, `preview/equirect-compare.png` | Full 2:1 map, north up, lon 0 at center (`--lon` shifts that) | Whole-world layout, continent arrangement, east–west wrap, climate belts, ice as latitude bands, land/ocean fraction |

After a geography / climate / colormap change, capture the default (both) and **read both**. A globe can hide the far side; an equirect can hide how the same land looks as a planet. For lighting, camera, or mesh work, globe is enough. For “where is everything” questions, equirect is enough — pass `--lon` if the feature you care about is split across the antimeridian.

Previous shots: `preview/planet-before.png`, `preview/equirect-before.png`, `preview/history/`.

Do not open the interactive app in any built-in agent browser (Simple Browser, MCP browser, Cursor browser, etc.). Tell the user they can run `bun run dev` and open `http://localhost:3000` themselves.
