# planetgen

Planetgen builds a coarse planetary base: tectonic plates, a heightmap, and climate on a sphere. A new seed produces another Earth-like world. That means the physical rules that make a planet of this kind look right: plates, isostasy, ocean floor that deepens with age, and moisture carried by wind. It does not mean Earth's continents.

This repo stops at that base. Fine terrain comes from [terrain-diffusion](https://github.com/xandergos/terrain-diffusion). Rivers come after that. Later stages need a planet they can treat as real: continents carried by plates, mountain belts at collisions, and coasts that come from elevation.

Work happens in a **project**. Thalos is the default, the world being discovered. Earth is a present-day fixture used as a reference. A new project starts with a name and body buckets, then Discover (layout then shape). Finish is climate through export.

The generator is a pipeline of stages — Layout, Shape, Climate, Terrain, Carve, Export — with one doc per stage. **[docs/README.md](docs/README.md)** is the map; [docs/studio.md](docs/studio.md) is how the studio around them works.

## Run

Install [Bun](https://bun.sh), then:

```sh
bun install
bun run dev
```

Open http://localhost:3000. The page reloads when the code changes.

## Captures

```sh
bun run preview          # globe + equirectangular map
bun run preview plates   # plate shapes and motion
bun run preview crust    # ridges, trenches, sea-floor age
bun run preview climate  # moisture on its own
bun run preview relief   # hypsometric tint and hillshade
bun run preview --earth  # the Earth project
bun run sheet            # twelve seeds on one sheet
```

Files land in `preview/<project>/` (Thalos by default).

## Origin

Forked from [Amit Patel's 1843 planet generation experiment](https://www.redblobgames.com/x/1843-planet-generation/). Apache-2.0.
