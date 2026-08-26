# Features we do not make yet

A list to grow. Not a plan, not agent context. Search here when something
is missing from the planet and you want to know whether that is known.

- **Atolls and other sub-23 km oceanic landforms.** No coral-reef rings,
  guyots, fringing reefs, or Klein-Curaçao-class islets. The sketch cannot
  hold a ring, and terrain-diffusion will not invent one from a coarse cell.
  Stamp them on the 90 m DEM in **Carve**, with rivers and fjords. Deferred.
- **Fjords.** The detail pass drowns glaciated high-latitude coasts, but a
  cell is ~50 km, and a real fjord is 1–6 km across. What you get is one
  drowned cell, not a Norway coast.
- **Shape's 23 km claim (locked).** Warp, crests, belt grain, and first-stage
  erosion exist and still look wrong. Missing or wrong at this grain: young
  hotspot islands, old/weak arc ribbons (Curaçao), plume-on-ridge plateaus
  (Iceland), the forearc trough, drowned-margin islands, ria inlets, and
  fracture-zone scars. Drop isolated 1-cell cones; those wait for **Carve**.
  Not this list: abyssal hills, a second shelf pass, large lakes, grabens.
  Explicit Shape action, cached — see [studio.md](studio.md). No search sheet.
- **Authored editing.** Raise land, drain basins, and other hand edits to a
  generated sketch. Implementation is still open. [World
  Orogen](https://orogen.studio) already does this; read that codebase when
  we get to it. Not Earth's authored fixture knobs. Same planet; Save is a
  child node.
- **Content-addressed preview bakes.** Preview tiles live under the variant
  folder. Address each tile by a hash of the local sketch it was baked
  from, so a tile whose ground did not change is kept when a sibling
  snapshot is saved. Surgical edits elsewhere on the planet then do not
  invalidate still-correct tiles.
- **Advanced, and the 1843 toggles.** Layout still folds mesh `N`, shape
  spacing, jitter, and the 1843 path (live tectonics, merge ocean plates,
  one world ocean). Those toggles are mostly unused and should likely go.
  Give Advanced another look; keep improving the tectonic model itself.
- **Post-diffusion hydrology (open).** Carve after the 90 m bake is how
  the planet gets rivers that reach the sea and a trunk you can follow —
  a large part of whether it feels believable. Diffusion already looks
  eroded (Earth DEMs) but is not hydrologically coherent. How hard to
  cut without wrecking those landform statistics is unsolved. Do not
  rerun Shape's stream-power recipe on the bake. Notes:
  [preparing-for-diffusion.md](preparing-for-diffusion.md).
- **Meander belts and oxbows.** In scope, not made. A 90 m cell cannot
  hold a creek loop; it can hold a real river. Wavelength is ~10–12×
  bankfull width, so a loop train needs λ ≳ 1 km (width ≳ 70–100 m).
  Those belts and their oxbow lakes are aerial geology. Creeks stay a
  reach graph / runtime spline. D8 incision across a floodplain is a
  cutoff — it straightens the belt. Keep what diffusion already drew;
  synthesize on alluvial reaches that came out too straight. Bedrock
  gorges stay dendritic. Notes:
  [preparing-for-diffusion.md](preparing-for-diffusion.md).
