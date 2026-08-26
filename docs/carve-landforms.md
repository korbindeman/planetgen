# Carve — sub-23 km landforms

**Not started. Deferred, and deliberately so.**

## What it does

Stamps the landforms that are too small for the sketch onto the baked
90 m DEM: atolls, coral-reef rings, fringing reefs, guyots, islets, and
real fjords.

These are not missing by accident. **The sketch cannot hold a ring** — a
23 km cell is larger than most of these features — and terrain-diffusion
will not invent one from a coarse cell it never saw marked. So they are
deferred to the one place they can exist: after the DEM is real.

Sits alongside [Carve — hydrology](carve-hydrology.md). Same stage, same
DEM, almost no shared method: one cuts, this one stamps.

## Reads

| Input | From | Used for |
| --- | --- | --- |
| the 90 m DEM | [Terrain](terrain.md#hands-on) | the surface to stamp onto |
| `r_hotspot`, `r_hotspotPeak`, `r_hotspotAge` | [Layout](layout.md#hands-on) via the sketch | where a volcanic island was, and how long ago it died — an atoll is a drowned one |
| `r_arc`, `r_arcPeak`, `r_arcAge`, `r_arcDir` | same | islet chains along old arcs |
| `r_crust_age` | same | subsidence: a guyot is a seamount that sank with its cooling floor |
| `r_temperature`, `r_moisture` | [Climate](climate.md#hands-on) | reefs need warm water; fjords need ice |
| `r_boundary` | via the sketch | forearc and margin position |

**This is what the peak/age triples were for.** A stamp needs to know a
volcano *was* here and when it stopped, not just whether it is erupting
now. Without them, every atoll would have to be noise.

**Wishes** — unknown until the stage starts. A sea-surface-temperature
proxy is the obvious first ask, since reef presence is close to a
temperature threshold.

## Hands on

Edited 90 m DEM, plus whatever vector records the game wants for reefs.
Consumed by [Export](export.md).

## Must not regress

- **Do not push these back into Shape.** A one-cell cone at 23 km is not
  an island, it is a speck; Shape drops them on purpose. Adding a stamp
  upstream puts a feature on the map that the diffusion model will then
  heal away.
- **Do not ask terrain-diffusion to invent them.** It will not draw a
  landform the sketch never marked, and a ring is out of its training
  distribution regardless.

## How it works today

Nothing.

## Open

Everything, including whether these are one pass or several. What is
known:

- **Atolls.** A drowned hotspot volcano with a reef that kept growing.
  The inputs are all present — `r_hotspotPeak` says a volcano was there,
  `r_hotspotAge` says how long ago, `r_crust_age` says how far the floor
  has subsided, temperature says whether coral could keep up. Nothing has
  been built or tried.
- **Guyots** — the same story where the reef did not keep up. Flat-topped
  seamount, below the surface.
- **Fringing reefs and islets** (Klein-Curaçao class) along old arcs.
- **Fjords.** [Shape](shape.md) drowns glaciated high-latitude coasts,
  but a cell is ~23 km and a real fjord is 1–6 km across, so what you get
  is one drowned cell, not a Norway coast. A real fjord network is a
  90 m feature: glacial valley profile, overdeepened floor, threshold at
  the mouth. Related to the hydrology pass but not the same operation —
  a fjord is a drowned glacial trough, not a river channel.

Deliberately **not** on this list: abyssal hills and a second
continental-shelf pass. Those are texture the diffusion model can be
asked for, not stamps.

## How to judge it

Crop at Maps-style zoom. An atoll either reads as an atoll or it does
not; there is no statistic for this.

Check it from orbit too — a stamp pass is exactly the kind of thing that
looks right at 90 m and tiles into visible polka dots at planet scale.
