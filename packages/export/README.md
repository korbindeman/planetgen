# @planetgen/export

Writes the five-channel conditioning sketch terrain-diffusion reads (`heightmap`, `temperature`, `temperature_std`, `precipitation`, `precipitation_cv`).

The working CLI is still `bun run export:td` at the repo root. Regional crops only — do not run `tiff-export` on the whole-world raster.

This package is the home for that handoff. The rasterizers live on the Planet document (`mesh` + `map` of the visible layer).
