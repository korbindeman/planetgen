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

The globe is a WebGL canvas. After any change that affects how the planet looks:

```
bun run preview
```

Then read `preview/planet.png`. It is a 2x2 of longitudes 0°, 90°, 180°, and 270°. Do not finish visual work from code alone.

```
bun run dev
```

opens the interactive globe at `http://localhost:3000`.
