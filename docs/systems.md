# Systems

A **system** is the star and the **situation** of each **project** in it.
Several bodies share one star. Each body stays its own project.
**Variants** stay layouts of that surface.

This file is a vision. Nothing here is built. Discover of one planet is
still the job.

## What a system is not

A system is not a project. Opening a moon is not a new variant of the
homeworld. Star class is not a gene. Explore does not redraw the star.

A lone **project** stays legal. It keeps the implicit Sun and one AU
orbit that `world.js` already uses.

## Initialize

A new system would use **buckets**, as a new project does. Picking a
star class would not write 5772 K. The person would pick a short set of
roles: star, home, moons, neighbours. The computer would place those
bodies on legal orbits.

The person would not set eccentricity, Hill radius, or instellation.

## What the computer derives

The person does not keep flux, year, and lock in agreement. Those knobs
are not shown.

| They picked | The system would write |
| --- | --- |
| Star bucket | temperature, luminosity, spectrum |
| Home in the habitable zone | semi-major axis, year, flux |
| A large moon | a child orbit (outside Roche, inside Hill), often locked, day equal to month |

Change the star, and every body in the system would get a new flux and
year. Shuffle continents on the homeworld, and the star would not move.

`climate.js` would take flux as a scale, exactly 1 at Earth, the way day
already scales Hadley cells. A bake-time GCM would take the same record
(`startemp`, `flux`, `year`, `eccentricity`, `synchronous`). The person
would not see those names.

Atmosphere composition can wait. It is a Climate input, not a
system-bucket question.

## Bodies that have no Layout

Gas giants and airless rocks would still sit on the system list. They
may have no plates. The catalogue would be complete. The surface
pipeline stays per body. A later Terrain would take an airless body as
a different point in the same space: fluvial channels off, craters on.
That file is [custom-model.md](custom-model.md).

## Pyros

Pyros is the shipped system, when this exists, the way Thalos is the
shipped project. Until then the game's `solar_system.ron` stays the
catalogue for that world. Do not copy it into this repo.

Sol would be a system **fixture** if known orbits are needed the way
Earth is known tectonics. The first ExoPlaSim trial does not need that.
Thalos around a G2V at 1 AU already matches those numbers.

## Export

[Export](stages/export.md) already names a solar-system pack. A
**system** would be the authoring side of that pack. A later exporter
would speak another game's format. The system file would stay the
authoring record.

## Status

**open**. Not scheduled. Do not add knobs, a picker layer, or a system
file for this. When Climate's GCM trial runs, it would still use Thalos
with the implicit Sun.
