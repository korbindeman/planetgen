# Why planetgen and not something else — Aug 2026

**Historical. Do not update this file.** A survey of alternatives to
writing our own base, run Aug 2026. The verdict was to keep going here.
The live stage is [layout.md](../layout.md).

| Alternative | Verdict |
| --- | --- |
| World Orogen (orogen.studio, GPL-3, spherical) | Only maintained open-source contender. Judged not more realistic than planetgen's output. |
| Cortial et al. 2019, "Procedural Tectonic Planets" | No public implementation exists. |
| Borg et al., Eurographics 2026 (sketch → quadsphere planet diffusion) | Closest published system to this whole pipeline. No code released. **Watch.** |
| Songs of the Eons / Gleba | SOTE dead, worldgen never open-sourced; Gleba active but closed source, pre-alpha. Watch. |
| tectonics.js / tectonics.cpp | Dormant / incomplete; documented hypsometry blowups; successor is CC-NC. |
| ASPECT / StagYY geodynamics | Emergent plate tectonics costs months of supercomputer time and yields muted dynamic topography. |
| GPlates + pyGPlates/gplately bridge | Considered seriously, then dropped: its value (Euler-pole kinematics, seafloor age grids, half-space cooling bathymetry, plate history bookkeeping) is exactly what planetgen already implements. Remaining value is the desktop app as a visual inspector, which `bun run preview` covers. Not worth an export format. |

## What we kept from World Orogen and what we did not

Read at the same time, and the source of Shape's three steps — see
[detail-pass-2026-08.md](detail-pass-2026-08.md).

| | planetgen | World Orogen | call |
| --- | --- | --- | --- |
| Continents | clustered cratons, crust type independent of the plate partition | land is a per-plate boolean, continents seeded farthest-point | **keep ours** — this is why our coasts do not trace plate outlines and why one ocean stays empty |
| History | 200 Myr of rigid-body rotation, rift and collision | one-shot; velocity evaluated once, never integrated | **keep ours** |
| Ocean floor | half-space cooling on real sea-floor age | distance-to-coast profile, no age field | **keep ours** |
| Resolution | 10k cells, one mesh | 20k coarse sim → 204k–2.5M render mesh | **borrow theirs** |
| Coastline shape | one warp octave + `detailNoise: 0.06` | domain-warped lookup, coastal fractal, glacial fjords | **borrow theirs** |
| Mountains | scalar orogeny → smooth swell | phasor/Gabor ridges oriented to compression | **borrow theirs, improved** |
| Erosion | none | priority-flood + stream power + thermal + glacial | **borrow theirs, staged** |

Their weakness is ours to keep away from: whole-plate land assignment and
farthest-point continent seeding are exactly what removes hemispheric
asymmetry, and filling interior depressions (`fixupTopology`) is what
removes inland seas.

## The division of labour that came out of it

planetgen owes the diffusion model correct **layout** — plate-shaped
continents, belts at collisions, age-graded ocean floor — not pretty
pixels. The coarse model redraws local statistics regardless.
