# @planetgen/export

Writes the five-channel conditioning sketch terrain-diffusion reads (`heightmap`, `temperature`, `temperature_std`, `precipitation`, `precipitation_cv`).

`bun run export:td` and the in-app **Bake previews** action both call `scripts/export-project.mjs`. Regional crops land in `preview/<name>/`. Do not run `tiff-export` on the whole-world raster.

The rasterizers live on the Planet document (`mesh` + `map` of the visible layer).
