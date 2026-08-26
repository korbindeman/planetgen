# Carve — sub-23 km landforms

## What it does

This pass stamps the landforms that are too small for the sketch onto
the baked 90 m DEM: atolls, coral-reef rings, fringing reefs, guyots,
islets, and real fjords.

These are not missing by accident. **The sketch cannot hold a ring.** A
23 km cell is larger than most of these features. Terrain-diffusion will
not invent one from a coarse cell it never saw marked. They wait until
after the DEM is real. They can exist only there.

Sits alongside [Carve — hydrology](carve-hydrology.md). Same stage, same
DEM, almost no shared method. One cuts. This one stamps.

## Reads

| Input | From | Used for |
| --- | --- | --- |
| the 90 m DEM | [Terrain](terrain.md#hands-on) | the surface to stamp onto |
| `r_hotspot`, `r_hotspotPeak`, `r_hotspotAge` | [Layout](layout.md#hands-on) via the sketch | where a volcanic island was, and how long ago it died — an atoll is a drowned one |
| `r_arc`, `r_arcPeak`, `r_arcAge`, `r_arcDir` | same | islet chains along old arcs |
| `r_crust_age` | same | subsidence: a guyot is a seamount that sank with its cooling floor |
| `r_temperature`, `r_moisture` | [Climate](climate.md#hands-on) | reefs need warm water. Fjords need ice |
| `r_boundary` | via the sketch | forearc and margin position |

The peak/age triples exist for this. A stamp needs to know a volcano
*was* here and when it stopped, not only whether it is erupting now.
Without them, every atoll would have to be noise.

**Wishes** — unknown until the stage starts. A sea-surface-temperature
proxy is the first likely ask. Reef presence is close to a temperature
threshold.

## Hands on

Edited 90 m DEM, plus whatever vector records the game wants for reefs.
Consumed by [Export](export.md).

## Must not regress

- **Do not push these back into Shape.** A one-cell cone at 23 km is not
  an island. It is a speck. Shape drops them on purpose. A stamp upstream
  puts a feature on the map that the diffusion model then heals away.
- **Do not ask terrain-diffusion to invent them.** It will not draw a
  landform the sketch never marked. A ring is out of its training
  distribution regardless.

## How it works today

Nothing.

## Open

Everything, including whether these are one pass or several. What is
known:

- **Atolls.** A drowned hotspot volcano with a reef that kept growing.
  The inputs are all present. `r_hotspotPeak` says a volcano was there.
  `r_hotspotAge` says how long ago. `r_crust_age` says how far the floor
  has subsided. Temperature says whether coral could keep up. Nothing has
  been built or tried.
- **Guyots** — the same story where the reef did not keep up. Flat-topped
  seamount, below the surface.
- **Fringing reefs and islets** (Klein-Curaçao class) along old arcs.
- **Fjords.** [Shape](shape.md) drowns glaciated high-latitude coasts.
  A cell is ~23 km. A real fjord is 1–6 km across. What you get is one
  drowned cell, not a Norway coast. A real fjord network is a 90 m
  feature: glacial valley profile, overdeepened floor, threshold at the
  mouth. Related to the hydrology pass but not the same operation. A
  fjord is a drowned glacial trough, not a river channel.

**Not** on this list: abyssal hills and a second continental-shelf pass.
Those are texture the diffusion model can be asked for, not stamps.

## How to judge it

Crop at Maps-style zoom. An atoll either reads as an atoll or it does
not. There is no statistic for this.

Look at it from orbit too. A stamp pass can look right at 90 m and tile
into visible polka dots at planet scale.
