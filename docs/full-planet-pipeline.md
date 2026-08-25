# The full-planet pipeline

Planetgen makes the coarse base. This note records the plan for everything after it: how one planetgen seed becomes a real-scale, pre-baked planet, which tools were chosen for each stage, and which alternatives were surveyed and rejected (Aug 2026). The regional sketch → diffusion handoff mechanics live in [preparing-for-diffusion.md](preparing-for-diffusion.md); this doc is the planet-scale architecture around it. Compute, 90 m vs 30 m, and what actually ships: [full-planet-bake.md](full-planet-bake.md).

Status labels: **decided** (settled), **recommended** (researched, needs a trial before committing), **open** (known problem, no chosen answer).

## Authoring — decided

The bake pipeline below runs on **one** planet. Getting to that planet is
**Discover**, and it is the studio's job. Canonical: [studio.md](studio.md).

```
adopted body                    optional project default
    → search from a variant     working planets; likes steer the session box
    → save variant              child of head: layout seed, shape seed, body, genes, pins
    → run Shape                 explicit; 23 km sketch, cached on that node
    → hand-author (later)       sculpt that variant's sketch
    → preview tiles             90 m crops, per variant — a tool, not a stage
    → commit (Adopt)            this instance is the project's planet
    → Finish                    climate, terrain, hydrology, export
```

A project is a tree of variants plus an optional adopted body. A variant
stores its own body. Pins are body-only and inherited down the lineage.
Commit chooses the instance — it does not pin every remaining gene.

Every Save is a new node. A node's sketch does not go stale; a child is a
different snapshot and starts unshaped. Preview tiles and later hand-edits
attach to a variant. Keying them to the project or to the seed alone is
what makes tiles follow you onto the next candidate.

On disk that is `preview/<project>/variants.json` for the catalog and
`preview/<project>/v/<id>/` for that variant's folder. Listing without a
variant id does not walk `v/`. Earth stays at `preview/earth/`.

Earth is the fixture: one locked planet, no search, no variants. Its
tectonics are known so shaping can be tested on that base.

## Shape of the pipeline

```
planetgen layout (~10k cells) then Shape (23 km/px sketch)
    → optional bake-time climate (ExoPlaSim)
    → terrain-diffusion (cheap pass, then 90 m per cubesphere face)
    → hydrology / erosion                             rivers, canyons, lakes
    → residual pyramid                                what the game ships
    → analytic octaves below 90 m                     lazy, in game
```

Offline bake of one reference planet first. On-demand generation (the model's InfiniteDiffusion random access makes it possible) is a later project; nothing here should preclude it, so tiles are deterministic functions of (seed, face, level, i, j) wherever we can manage it.

## Stage decisions

### Base: planetgen — decided

A survey of alternatives (Aug 2026) found nothing better than continuing here:

| Alternative | Verdict |
| --- | --- |
| World Orogen (orogen.studio, GPL-3, spherical) | Only maintained open-source contender. Judged not more realistic than planetgen's output. |
| Cortial et al. 2019 "Procedural Tectonic Planets" | No public implementation exists. |
| Borg et al., Eurographics 2026 (sketch → quadsphere planet diffusion) | Closest published system to this whole pipeline. No code released. **Watch.** |
| Songs of the Eons / Gleba | SOTE dead, worldgen never open-sourced; Gleba active but closed source, pre-alpha. Watch. |
| tectonics.js / tectonics.cpp | Dormant / incomplete; documented hypsometry blowups; successor is CC-NC. |
| ASPECT / StagYY geodynamics | Emergent plate tectonics costs months of supercomputer time and yields muted dynamic topography. |
| GPlates + pyGPlates/gplately bridge | Considered seriously, then dropped: its value (Euler-pole kinematics, seafloor age grids, half-space cooling bathymetry, plate history bookkeeping) is exactly what planetgen already implements. Remaining value is the desktop app as a visual inspector, which `bun run preview` covers. Not worth an export format. |

The realism division of labor stands: planetgen owes the diffusion model correct *layout* (plate-shaped continents, belts at collisions, age-graded ocean floor), not pretty pixels. The coarse model redraws local statistics regardless (see the SNR findings in preparing-for-diffusion.md).

### Climate: two tiers — recommended

`climate.js` stays the in-loop model: fast, browser-free, judged by `bun run climate`. It is a heuristic (advected moisture, latitude temperature), which is right for iteration but is not where final realism should come from.

For the bake, run **ExoPlaSim** on the planetgen heightmap and derive the conditioning channels from physics:

- ExoPlaSim = PlaSim (Univ. Hamburg intermediate-complexity GCM) wrapped for arbitrary planets: `pip install exoplasim`, custom topography + land/sea mask as `.sra` files, `Model.configure(topomap=…, landmap=…)`, `runtobalance()` to energy equilibrium, monthly `tas`/`pr` out as netCDF. T42 = 64×128 Gaussian grid (~310 km cells), ~15 min per model year on 16 cores; whole run is an overnight CPU job, well under $50 on a cloud node. GPL-2, maintenance mode (v3.4.2, Jan 2025), needs gfortran; Apple Silicon untested — run it on Linux.
- All four climate channels drop out of the 12-month climatology: mean temp, temp std, annual precip, precip CV. This replaces the current latitude/dryness heuristics for `temperature_std` and `precipitation_cv` in the export mapping.
- Downscale T42 → 23 km/px with a CHELSA-V2-style pass (no off-the-shelf library handles a planet with no weather stations): interpolate monthly fields; temperature corrected by lapse rate, ideally diagnosed per-cell/month from the GCM's own vertical levels; precipitation redistributed by a windward/leeward orographic index from the GCM winds against the fine heightmap. `koppenpasta` (github.com/hersfeldtn/koppenpasta) already does the lapse-rate-only variant on ExoPlaSim output and is the reference.

Why bother: real circulation (Hadley cells, monsoons, rain shadows, wet-west/dry-east asymmetry) — and it plugs the diffusion model's one structural blind spot. terrain-diffusion's training data was clipped to ±60° latitude; its worlds are statistically mid-latitude everywhere. Physics-derived climate channels, pinned at high SNR, are what make the output read as a planet with tropics and poles rather than endless temperate terrain.

Trial before committing: one T21 run (minutes/year) on a planetgen heightmap, eyeball the precip/temp fields against `climate.js`. If ExoPlaSim's fields are not clearly more believable, drop this stage and export from `climate.js` as today.

### Detail: terrain-diffusion at planet scale — decided approach, open engineering

Regional crops work today (preparing-for-diffusion.md). The full planet is different: `tiff-export` on the whole equirect raster is explicitly wrong (pole distortion, one giant job). The plan:

- **Cubesphere, equal-angle mapping.** Six square faces, quadtree per face, 512² tiles. Equal-angle keeps pixel scale within **√2 = 1.41×** worst case, against ~2.12× for raw gnomonic; a "90 m" pixel is really 90–127 m/px depending where on the face it lands, worst at an edge midpoint, and that is within tolerance for the model's learned statistics. (This entry read ~1.3× / ~115 m before `src/cubesphere.js` made it measurable — the analytic scale is `(1+X²)√(1+Y²)/r²`, and `bun run check:tiles` now pins the ratio to √2 so a drift back toward gnomonic fails loudly.) The face-adjacency table (edges, rotations) is the foundation everything shares: conditioning margins, hydrology routing, rendering skirts.
- **Generate per face** on the face's raster via `WorldPipeline` + `set_custom_conditioning_import()`, not `tiff-export`: conditioning for each face is the coarse map reprojected into that face's projection, extended past the edges with reprojected neighbor-face data so the 64-cell context pad sees real terrain, not `mode="edge"` repetition.
- **Seams**: overlap generation bands across face edges and blend elevation in the overlap; corners (three faces meet) are the ugly case. The unmerged terrain-diffusion PR #15 "Sphere export" does cube-face sampling and is prior art to read, not code to trust. This is the one piece of genuinely novel engineering in the whole pipeline — **open** until proven on one edge and one corner.
- **Poles**: cubesphere kills the equirect-distortion problem, but the ±60° training clip remains. Mitigation: pin climate channels cold at high SNR (the model saw cold-dry terrain south of 60°) and treat ice sheets as a post-pass. **Open** until a polar face looks right.
- **Scale of the bake** (90 m model, Earth): ~10¹¹ output px ≈ 200 GB int16; on the order of 600k tile-samples with overlap ≈ single-digit GPU-days. **Thalos is a quarter of that** (half radius): ~150k tiles, one to two days on the home 4070 Ti. The dense DEM is the bake, not the install — the game ships a sparse residual pyramid (~2–3 GB for Thalos). See [full-planet-bake.md](full-planet-bake.md). Feasible, not casual — which is why every stage upstream gets validated on crops first.

### Hydrology and post — decided (documented elsewhere)

Fine drainage — real river networks, discharge, lakes, canyons — runs on the baked DEM, never as a substitute for the planetgen mesh. The detail pass already does a first-stage shaping (priority-flood, stream power, glacial fjords) so the sketch the diffusion model sees has valleys and a coast that drains somewhere; that is rough texture, not the network. The pass structure for the fine stage (priority-flood, D8 accumulation, stream-power incision, hillslope) is in preparing-for-diffusion.md. Planet-scale addendum: flow routing must run on the cubesphere adjacency graph so rivers cross face edges; route at full resolution per drainage basin, or at an intermediate global level (~1 km) with carving applied to the fine tiles.

### Below 90 m — decided (runtime)

The model floor is 90 m. Ground-level gameplay needs ~1 m. That layer is non-ML amplification (erosion-aware detail noise, slope/material displacement), evaluated lazily in the game from the residual, slope, biome, and seed. Do not bake it. 30 m is a later measurement, not the global bake — see [full-planet-bake.md](full-planet-bake.md).

## Where things live

- **planetgen (this repo)**: the studio. The base, project pins, regional preview bakes, and pipeline status live here. Do not vendor terrain-diffusion. When ExoPlaSim graduates from trial, `export:td` grows a mode that takes bake-time climate rasters instead of deriving channels from `climate.js`.
- **~/dev/terrain-diffusion**: sibling checkout, upstream untouched. The app kicks `tiff-export` as a subprocess.
- **Cubesphere bake** (faces, seams, full 90 m job, hydrology on the DEM): still `@planetgen/bake`, a named slot. That is Finish/Terrain internals, not a Progress stage. Preview tiles come first, as a Discover tool.

## Order of attack

1. ExoPlaSim trial on one planetgen heightmap (T21, then T42 if promising). Cheapest stage, biggest realism swing, zero coupling to the hard engineering.
2. Cubesphere face raster + adjacency table, and one face generated via `WorldPipeline` with imported conditioning — compare against a `tiff-export` crop of the same region.
3. One face edge + one corner, seam-blended. This proves or reshapes the whole bake plan.
4. Full coarse planet (all six faces at 23 km conditioning, coarse model only) — cheap, and the first look at the planet as a planet.
5. Scale out: full 90 m bake on the home 4070 Ti, then hydrology.
