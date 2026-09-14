# Layout

## What it does

Layout composes a plausible tectonic past on a sphere of about 10k cells.
It does not advance moving plates. The procedural default is
`src/layout-history.js`, with geometry in `src/layout-composition.js` and
regional crust assemblies in `src/continental-fabric.js`, called
by `src/pipeline/stages.js`. The Earth
reference fixture remains its own path.

The September 2026 prototype replaces the default timestepped model after
the first global bake exposed oversized inland mountain masses. The goal
is coherent continental shapes, selected active coastal margins, small
continental colliders and quiet interiors, visible before Shape adds detail.

The composition deliberately favors low and middle latitudes and east-west
extent. Polar oceans separate the land from the poles. Longitude is random;
there is no named Earth continent, copied outline or fixed collision location.
These are aesthetic constraints requested for this generator, not a claim
that planetary physics requires an equatorial continental arrangement.

The model remains free of WebGL and DOM. Grain is about 113 km on Thalos.
The sheet is a layout sketch, not a finished heightmap.

## Reads

| Input | From | Used for |
| --- | --- | --- |
| layout seed | variant | deterministic geometry and history choices |
| body radius | variant | plate-count scaling |
| `plates` | layout genes | requested plate count, with a minimum of three oceanic candidates |
| `cratons` | layout genes | biases the sampled number of major cores, bounded to three through six |
| `continentFraction` | layout genes | scale of the continental geometry; not an exact land-area target |
| `seaLevelThicknessKm` | body water | vertical sea-level offset at 145 m per km |

`params.js` remains the parameter registry. Legacy recipes still load. The
old motion parameters, including `steps`, no longer change the procedural
default. The hotspot-track grammar is not implemented in this prototype;
its contract fields are present but zero. Cleaning up these legacy controls
is still open. Body gravity and age are not yet constraints on the composed
histories. Climate continues to read the body through its existing model.

**Wishes** — evaluate more kinds of continental assemblies and marginal seas
from actual reference relief. Improve history composition before adding
heightmap texture.

## Hands on

The existing field contract is retained. Shape samples these fields using
`sampleWeights` / `sampleField`; downstream code does not need a moving model.

| Field | Type | Meaning | Consumed by |
| --- | --- | --- | --- |
| `meters` | f32 | elevation in physical metres, before `metersToElevation` | Shape (warps it), everything downstream |
| `r_crust_type` | u8 | continental or oceanic | Shape, Terrain conditioning |
| `r_crust_age` | f32 | sea-floor age, Myr | Shape. Ocean depth via half-space cooling |
| `r_thickness` | f32 | crustal thickness, km | land height via isostasy |
| `r_plate` | i32 | owning plate id, stable across rifts | Shape, plate captures |
| `r_boundary` | u8 | convergent / divergent / transform | Shape (belt grain), Carve later |
| `r_orogeny` | f32 | present belt strength | Shape (ridge amplitude) |
| `r_orogenyDir` | packed3 | strike of the authored active margin or collision suture | Shape (phasor ridge orientation) |
| `r_arc` | f32 | present arc strength | Shape (island crests) |
| `r_arcPeak` | f32 | strongest this cell ever was | Shape (old/weak arc ribbons) |
| `r_arcAge` | f32 | Myr since last refresh | Shape (extinct arcs still on the map) |
| `r_arcDir` | packed3 | arc strike | Shape (ribbon orientation) |
| `r_hotspot` | f32 | present plume strength | Shape (young hotspot islands) |
| `r_hotspotPeak` | f32 | strongest this cell ever was | Shape (old tracks) |
| `r_hotspotAge` | f32 | Myr since last refresh | Shape (drowned seamount chains) |


`layout.json` also optionally stores `layoutHistory`: the versioned composition,
continental polygon frames, shared plate groups, boundary states, connected
seaways, marginal basins, arc/trench paths, uplift provinces, lowland corridors,
ages and attachment/collision events. Version 4 also records actual mesh-edge
interactions, with overriding and subducting plate IDs, and the sizes of filled
accidental water pockets. Version 5 adds continental inheritance, shelf fragments,
and along-strike range widths, strengths and asymmetric shoulders. Version 6
replaces the core envelopes with joined terranes: regional polygons, parent
contacts, detached fragments and an interior spine. Basement provinces follow
those polygons; collision platforms also store polygonal footprints. Individual
island arcs record whether partition cleanup accreted them. Version 7 retains
regional crust in separated companions, records contact-rooted extension and
regional shear, and adds segmented, multi-strand uplift belts.
This is an authored construction record, not a simulated time
log. `r_meters` stores the `meters` field. The optional record does not change
schema 1. Existing saved variants retain their cached geography; Regenerate
or a new seed uses the new generator.

The snapshot also retains `r_elevation`, `r_moisture`, and `r_temperature`;
Climate supplies the latter two before a full layout snapshot is saved.

Lifetime arc fields retain peak >= present. Hotspot fields currently contain
zeros. `elapsedMyr` is zero and plate angular velocities are zero. Plate birth
ages are sampled history metadata, not elapsed simulation time.

## Must not regress

- Coastlines are interpolated contours of a continuous elevation field,
  never a threshold on plate ownership. Plates contain ocean and continent.
- Relief belongs to selected interactions. Do not wrap every coast in a
  mountain rim or turn a continental interior into a radial dome.
- Do not threshold isotropic noise to distribute continents across the world.
  Noise may perturb an authored boundary; it does not decide crust geography.
- A plate is one connected body and has more than one neighbor. Empty plate
  records and disconnected scraps are removed before classifying boundaries.
- At default water level, Layout has one connected world ocean in both metre
  and normalized elevation fields. Seaways have gateways; unintended enclosed
  water pockets become low continental basins before deriving the fields.
- Do not increase mesh density to disguise poor continental geometry. Judge
  the ~10k-cell Layout field without Shape.
- Avoid land bridges through the poles. Fit block geometry into the latitude
  composition; do not slice continents with a horizontal polar cutoff.
- Keep ocean between unrelated assemblies. A small collider can join its
  host, and one incomplete rift can retain a short continental neck. Neither
  may bridge a chain of otherwise unrelated continents.
- Preserve the Earth fixture and the original 1843 comparison path.
- Continental and seaway polygons must have no crossing outline edges.
  Repair local folds without taking a convex hull that erases the bays.
- Save stores the resulting fields, not just a seed. No cache schema bump
  for a model change or an optional construction record.

## How it works today

**Composition.** Three to six unequal continental cores form a hierarchy.
A broad body favors one hemisphere; a second body varies in aspect and tilt.
Some compositions have a third independent anchor. Companion bodies attach
their placement relationships to different anchors, with varied offsets and
north-south reach; optional smaller bodies sit beyond them. These are generic composition
roles, not named continents. A shared footprint budget prevents independent
enlargement from turning every core into a giant.

Each independent core starts as an irregular craton polygon. Smaller crustal
regions weld across exposed edges, with a few primary growth fronts and
successively smaller descendants. Each addition shares a contact with its
parent. The union boundary supplies the continent's outline: bays are spaces
between branches and peninsulas are extensions of the regional assembly.
Accretion occupies part of an exposed edge, preserving embayments between
neighboring terranes. Regional shear bends the entire assembly and its shared
contacts together; it does not add separate noise outlines to each province.
There is no enclosing ribbon or radial mask for these cores. Growth rejects
crossing edges; later restrained subdivision and local uncrossing preserve
the concavities. Broad, compact and pendant roles vary the growth budget and
directional bias. These are a geometric assembly grammar, not an accretion sim.

A peripheral leaf region can detach across its original contact, provided
the translated fragment does not intersect the remaining mainland. It keeps
its crustal group and inherited relief. Its facing coast and the new strait
therefore come from the same assembly. The interior spine follows parent
contacts through the regional tree. Narrow ribbons remain appropriate for
island arcs. Coast contours still come from signed distance, not plate labels.

Some companions inherit their facing coast from a segment of an anchor's
margin. The sampled rift direction and widening opening vary; their far coast
is composed separately. This gives loose correspondence between neighbors.
The facing coast samples the exposed assembly, excluding detached fragments.
Separated companions retain their own terranes, inherited relief and detached
fragments. The opening deforms this regional fabric against the sampled host
margin; it no longer replaces the companion with a smooth tapered polygon.
Shared edges are split at the profile's breakpoints before deformation, so
long chords cannot jump across bays and intersect neighboring terranes.
Adaptive subdivision also resolves the curve introduced by spherical
reprojection; a narrow terrane must not fold across its opposite edge.
Rifts can search other orientations instead of always opening
toward the same local flank.
When that geometry cannot fit, a separately composed companion occupies a
nearby feasible position. The smaller anchor can retain one short continental
neck at one end of a rift; the other end opens to ocean. It cannot link a
sequence of unrelated assemblies. The optional history record stores core
roles and parent block indices, separated margins and incomplete rifts.

Placement checks full polygon outlines for ocean clearance and polar reach.
Among feasible frames it favors the requested relationship, rather than the
first empty patch of equatorial ocean. A separate deterministic random stream
drives placement retries, with wider alternatives and bounded size reductions
when a core cannot fit. After local attempts fail, candidates can search the
full longitude range; shrinking forever inside an occupied neighborhood did
not produce a valid placement. These are geometric composition constraints, not
plate motion or a reconstruction of Earth's continental arrangement.

Smaller attached polygons are fitted away from the poles by contracting
their axes in proportion to their north-south component. Global longitude
and hemisphere reflections transform every frame and plate seed together
**after** local construction, preserving the relationships among the bodies.

**Boundary constraints.** A small cyclic wave-function-collapse grammar
assigns active, passive and rift histories to eight boundary sectors.
Constraint propagation forbids an active margin immediately meeting an
opening rift without a transition; minimum-domain selection and backtracking
complete the ring. Active and passive sectors are required, so no continent
gets an all-active rim. These states are stored as local history priors;
present active ownership requires an authored young range or island arc.
They do not yet solve the relief paths or the global interaction graph;
the continental and orogenic composition remains an aesthetic grammar.

**Relief.** Finite paths place coastal ranges, collision sutures, older
oblique branches and subdued inherited ranges. Width, strength, age and
strike belong to each path. Coastal paths walk a finite stretch of the actual
polygon boundary by arc length, with a roughly constant angular inset. Rays
select a starting coast, not every point of the range; the former method
jumped across branches and bays. Young coastal uplift is suppressed where another
block has buried that margin deep inside the final union. One or two colliders
choose different large hosts. Contact candidates check the entire assembly
for exposed water and avoid opening seas. The regional coastal tangent sets
the contact orientation, rather than a ray from the continent's center. The
small block faces inland across that contact; a polygonal platform extends
behind the long, gently bent suture. Its elevation is a regional surface,
not a Gaussian mound.
An older branch connects each young suture into the wider system.
Collision hosts are selected from the two largest actual polygon areas, so
a small core cannot be swallowed by its plateau. A second collision is older
and weaker.

Each terrane owns a tilted basement surface, blended across its contacts.
Small directional variation is local to its regional strike. Selected old
contacts carry inherited uplands, so the continent's construction and relief
share structure. The former broad height patches and invented backbone are
removed. Each world still mixes low platforms, mixed shields and raised
shields. Broad lowland corridors suppress ancient uplift toward an outlet
away from young ranges. These are regional lowlands, not river networks or
carved drainage. Range width and strength vary along strike, with an inland
shoulder and a shorter front. An end taper confines uplift to the finite path
without forcing the entire range into one central hump. Along-strike uplift
segments leave saddles; subsidiary thrust strands sit behind the front and
share its strike. The uplift field supplies Shape with the same segmented
orogeny, while a broader coastal ramp prevents a highland from reaching sea
level as a vertical edge. Ancient uplands
combine by maximum rather than accumulating at every intersection. Arc
fragments populate the existing arc-strength, age and direction fields.

Detached regional fragments supply a scale between a continent and a volcanic
island. Shelf width and depth vary regionally, with narrow
active margins and arc shelves. A shallow shelf transitions separately into
the slope; the former single ramp made every continent plunge immediately
into deep water. Shelf fields do not change the continuous shoreline or add
a new required artifact field.

**Marine systems.** Selected long basement contacts that reach an exposed
coast can reopen under extension. A failed arm tapers inland as an embayment;
an opening that reaches ocean at both ends can separate a continental
fragment. The widths vary along the contact, and both shoulders retain their
regional basement. These are schematic rifted margins, consistent with the
general relationship between extension and continental separation described
by [USGS](https://www.usgs.gov/publications/deep-crustal-seismology-continental-margins),
not a fault mechanics solver or a fjord pass.

A remnant seaway bends along an exposed continental flank
and returns to ocean through a widening, resolvable gateway. Its host varies
among the larger cores. The actual regional coast tangent defines the frame:
using a radial direction could drill a narrow slot across the coastline.
Arc basins sit between the
coast and a broken island chain. Each system shares one frame for its channel,
islands, offshore trench and candidate overriding plate. Subdued inherited
uplift belongs to one shoulder rather than encircling the basin. Islands are
emplaced after basin opening. These are generic relationships, not sampled
Earth shapes. The Caribbean reference combines subduction arcs with transform
flanks ([USGS Caribbean plate overview](https://www.usgs.gov/publications/seismicity-earth-1900-2010-caribbean-plate-and-vicinity));
the Aegean reference shows localized extension and microplate boundaries
([USGS Aegean study](https://www.usgs.gov/publications/new-constraints-active-tectonic-deformation-aegean)).
The current grammar abstracts these relationships; it does not reconstruct
their full histories. A connectivity pass fills unintended enclosed water
pockets in the signed field before elevation, crust and ownership are derived.

**Static plates.** Continental blocks anchor plates; oceanic sites compete
over the intervening basins. Selected active margins bring the oceanic
ownership up to the margin, with a continuous connection back into the basin.
A narrow offshore strip alone would be disconnected and disappear during
partition cleanup. Marine systems can own a smaller overriding plate; its
domain extends continuously from the basin to the island chain. Overlapping
basin domains compete by distance to their paths, not generation order.
Passive margins retain ocean on the continental
plate. The largest connected core of each plate is retained; detached scraps
are reassigned by growing from those cores. Single-neighbor enclaves are
absorbed and empty records removed. This never edits continent geometry.
If a basin plate or an individual island is absorbed, the record marks the
affected arc accreted and its fields retain extinct history rather than
present activity. A basin remains active only while it has an active island.

**Ocean history.** Boundary roles are evaluated on actual adjacent plate
pairs after partition cleanup. Host/collider contacts converge, arc fronts
subduct with explicit polarity, and basin flanks transform. Offshore opening
boundaries share a pairwise extension axis; along-axis segments become
transforms instead of assigning roles from random plate IDs. Junction cells
use a fixed role priority, independent of neighbor iteration order.
Distance in ocean-only mesh hops from spreading cells supplies a schematic
age field. Marginal basins retain their own formation age. Half-space cooling
supplies depth, with trench deepening on the incoming side. This is a first approximation;
it is not a reconstructed seafloor age map or a globally compatible velocity
solution. No Euler rotations, advection, rifting loop or site churn runs.

### The 1843 path

`--no-tectonics` still selects the original blend. Shared geometry, sampling
and unit helpers remain in `tectonics.js`. The previous motion implementation
also remains there for reference, but the procedural pipeline no longer calls
it. The studio's toggle now says **Procedural tectonic history**.

## Open

- The first radial-polygon batch was rejected: flattened blobs and uniform
  interiors had little of Earth's character. The following four-core assembly
  still repeated the same arrangement. Enlarging independent cores then
  caused megacontinents; separating them into arbitrary empty space produced
  a row of isolated bodies. The current hierarchy and related margins address
  that failure, while broader profiles replace stringy shapes. Some paired
  margins and rounded outlines still repeat. Varying anchor relationships and
  coast profiles reduces the repetition, but does not remove it. Continue
  judging consecutive batches against Earth; the hierarchy is an aesthetic prior.
- WFC currently constrains each block's boundary ring, not the entire plate
  adjacency graph. A global history solve, with consistent subduction polarity
  and junction roles, remains future work.
- The static plate partition is a geometric scaffold, not a fully constrained
  tectonic reconstruction. Coastal-belt placement is composed from the same
  continental geometry; coarse plate boundaries only approximate those paths.
- Ocean ages use mesh hops, and pairwise extension axes do not constitute a
  globally compatible velocity solution. Ridge geometry, triple junctions
  and back-arc extension need further work. No plate motion is integrated.
- Legacy motion/hotspot controls remain for recipe compatibility and the old
  model. They need a deliberate UI migration if this prototype is retained.
- Regional elevations are deliberately sparse. Do not confuse this coarse
  pass with a claim that hydrology or fine terrain is solved.
- The personality pass in `work/layout-personality/accepted/` and
  `accepted-holdout/` was rejected by the user as still basic and clumped;
  those directory names do not imply aesthetic acceptance. The replacement
  regional construction is reviewed in `work/layout-fabric/review/` and
  `holdout/` (seeds 1–12 and 101–112). It removes the underlying envelope and
  height patches. Broad interiors remain schematic, and some branch patterns
  and shelf bands repeat. Further realism needs better regional relationships,
  not higher mesh density or blanket texture.
- Inspect additional consecutive seed batches. Do not select a few good
  seeds as evidence that every generated world works.
- The reference-driven revision in `work/reference-realism/` retains the
  pre-change source and captures, intermediate trials, and two consecutive
  twelve-seed reviews. Regional geometry and coast complexity improve, but
  the continental hierarchy and mountain placement remain a composition
  grammar. Fine coast detail and terrain still belong to later stages.

## How to judge it

```sh
bun run sheet:layout                 # seeds 1–12, Layout only
bun run sheet:layout --from=101      # another consecutive batch
bun run check:layout                # contracts on seeds 1–12 and 101–112
bun run check:layout --seeds=103     # isolate a geometry regression
bun run sheet --overlay=relief --no-detail
bun run sheet --overlay=plates --no-detail
bun run check:earth
```

`sheet:layout` writes `work/layout-history/contact-sheet.png`, individual
full-size maps, composition JSON, and relief/plate/crust globe and map pairs
for the first three seeds. Each contact map chooses an ocean-centered frame
for legibility; this rotates the view, not the geography. The entire sphere
is shown. `--from` changes the batch and overwrites these review outputs.
`--out` selects a review directory; `--views=0` skips the extra globe and
diagnostic captures during an intermediate map-only iteration. Final reviews
must include those captures.

Look for distinguishable continental masses, secondary blocks, broad ocean
basins, varied active and passive margins, and narrow collision relief.
Reject repeated coastal rims, isolated round mountain bumps, constant-width
rift slots, polar land bridges, and a featureless equatorial land ribbon.
The September review in `work/layout-revision/` also samples the local NOAA
ETOPO raster onto the same ~10k-cell mesh and renders it with the same palette.
That comparison retains Earth structure even at this grain; extra Shape noise
cannot substitute for continental composition. It is an angular comparison:
Thalos and Earth have different physical radii. The Earth fixture is separate
from this measured-elevation reference and has not been modified.

Read both globe and equirect captures, and check the plate/crust counterparts
before accepting the terrain. The tests cannot judge that picture.
