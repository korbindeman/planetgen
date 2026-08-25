# @planetgen/export

Writes the five-channel conditioning sketch terrain-diffusion reads (`heightmap`, `temperature`, `temperature_std`, `precipitation`, `precipitation_cv`).

`bun run export:td` writes regional crops under `preview/<name>/`. In the
app, pick tiles on the cubesphere grid (a Discover tool, not a Progress
stage). Do not run `tiff-export` on the whole-world raster.

The rasterizers live on the Planet document (`mesh` + `map` of the visible layer).
