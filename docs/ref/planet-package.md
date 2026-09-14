# Reference — the `.planet` package

How to read a planet. This is the consumer's document: byte layouts, the
texel-to-direction mapping, and the reconstruction algorithm. Why the format
is shaped this way is [export.md § The planet package](../stages/export.md#the-planet-package);
you do not need it to write a reader.

Written by `bun run build:package` (`scripts/build-package.mjs`), which also
validates: `bun run build:package --project=<p> --variant-name=<v> --validate`.

## At a glance

- A **sparse quadtree of height nodes** over a cubesphere, `(face, lod, x, y)`.
- Heights are **int16 metres, sea level 0**. No scale, no bias, no unorm.
- Nodes at `lod <= absolute_lod` are **absolute**; above that they are
  **residuals against the parent**. Reconstruction is exact.
- Every node exists up to `dense_lod`. Above it, **a missing node means the
  parent is already good enough** — never "no data". There are no holes.
- Every node carries a **one-texel skirt**, so you never sample a neighbour
  to shade or filter an edge.

## File layout

```
+---------------------------+
| header      32 bytes      |
| manifest    JSON, UTF-8   |
| index       24 bytes/node |
| blobs       zstd streams  |
+---------------------------+
```

All integers are little-endian.

### Header — 32 bytes

| Offset | Type | Field |
| --- | --- | --- |
| 0 | `char[8]` | magic, ASCII `PLANETPK` |
| 8 | `u32` | format version (currently `1`) |
| 12 | `u32` | manifest length in bytes |
| 16 | `u32` | node count |
| 20 | `u32` | index record size in bytes (currently `24`) |
| 24 | `u64` | absolute file offset of the blob region |

Read the record size from the header rather than assuming 24 — a later
version may grow the record, and the field is there so an old reader can
stride correctly over a newer file.

### Manifest — JSON

Starts at byte 32, runs for `manifest length`. Fields a reader needs:

| Field | Meaning |
| --- | --- |
| `node_resolution` | interior texels per node side (448 on the first planet) |
| `node_skirt` | skirt texels per side (1) |
| `node_stride` | stored texels per side, `node_resolution + 2 * node_skirt` |
| `leaf_lod` | finest lod present |
| `dense_lod` | last complete lod: every node exists at or below it |
| `absolute_lod` | last stored-absolute lod; residuals above it (≤ `dense_lod` on old files, which predate the split) |
| `radius_m` | body radius in metres |
| `bake_level` | the cubesphere level the DEM was baked at |
| `content_key` | 16 hex chars; namespace your caches by this |
| `max_error_m` | prune budget the writer used |

`body`, `variant`, `seed` identify the planet. `payload` and `residual_flag`
restate the encoding in prose.

### Index — 24 bytes per node

Immediately after the manifest, `node count` records:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | `u8` | face, 0..5 |
| 1 | `u8` | **low 7 bits** lod; **high bit set** means the payload is a residual |
| 2 | `u16` | declared predictor error in metres, saturated at 65535 |
| 4 | `u32` | node x |
| 8 | `u32` | node y |
| 12 | `u64` | blob offset, **relative to the blob region**, not the file |
| 20 | `u32` | blob length in bytes |

Records are sorted by `(face, lod, y, x)`, so a reader can binary-search
rather than build a hash map. Mask the lod byte with `0x7f` before comparing.

### Blobs

Each blob is a zstd stream. Decompressed it is exactly
`node_stride² * 2` bytes: int16, row-major, **first row is north**.

## Addressing

`lod` has `2^lod` nodes per face edge, so node `(x, y)` at `lod` covers
`1 / 2^lod` of the face in each axis. `x` increases with face axis *a*, and
`y` increases **southward** — row 0 of a node is its northern edge, matching
the payload's row order.

### Faces

Each face is a normal `n` and two tangents `u`, `v`:

| face | `n` | `u` | `v` |
| --- | --- | --- | --- |
| 0 | `(1, 0, 0)` | `(0, 1, 0)` | `(0, 0, 1)` |
| 1 | `(0, 1, 0)` | `(-1, 0, 0)` | `(0, 0, 1)` |
| 2 | `(-1, 0, 0)` | `(0, -1, 0)` | `(0, 0, 1)` |
| 3 | `(0, -1, 0)` | `(1, 0, 0)` | `(0, 0, 1)` |
| 4 | `(0, 0, 1)` | `(0, 1, 0)` | `(-1, 0, 0)` |
| 5 | `(0, 0, -1)` | `(0, 1, 0)` | `(1, 0, 0)` |

**This frame is z-up**: `+z` is the north pole, and latitude maps to z. It is
not the OpenGL cubemap convention and it is not y-up. If your engine is y-up,
convert at the boundary with a proper rotation — `(x, -z, y)` maps this frame
to a y-up one; `(x, z, y)` is a mirror and will hand every coastline the wrong
way round.

### Texel to direction

The projection is **equal-angle**: face coordinates `a, b` in `[-1, 1]` become

```
dir = normalize( n + tan(a * PI/4) * u + tan(b * PI/4) * v )
```

For interior texel `(px, py)` of node `(face, lod, x, y)`, with
`N = 2^lod` and `R = node_resolution`:

```
s = (px + 0.5) / R                  # 0..1 across the node, west to east
t = (py + 0.5) / R                  # 0..1 down the node, north to south

a0 = -1 + 2 *  x      / N
a1 = -1 + 2 * (x + 1) / N
bLow  = -1 + 2 * (N - 1 - y) / N    # southern edge
bHigh = -1 + 2 * (N     - y) / N    # northern edge

a = a0    + (a1   - a0)    * s
b = bHigh + (bLow - bHigh) * t
```

Skirt texels are the same formula with `px` or `py` at `-1` or `R`; they land
just outside the node and duplicate the neighbour's ground.
New exporters sample that ground from neighboring interiors at the same mip,
including across cube folds. The optional manifest field
`terrain.skirt_mode = "same-mip-spherical-neighbours-v1"` distinguishes this
from old packages whose outer face rows were clamped. Node interiors and the
reconstruction algorithm below are unchanged.

Note `b` runs *down* from `bHigh`, which is what makes row 0 north.

## Reading a node

```
stride = node_stride
interior(px, py) -> stored[(py + skirt) * stride + (px + skirt)]
```

Absolute nodes are heights. Residual nodes must be added to a prediction from
the parent.

### Reconstruction

```
reconstruct(face, lod, x, y):
    entry = index[face, lod, x, y]
    if entry is missing: return null
    raw = zstd_decode(entry.blob)            # int16[stride * stride]
    if not entry.residual: return raw
    parent = reconstruct(face, lod - 1, x >> 1, y >> 1)
    predicted = predict(parent, x & 1, y & 1)
    return predicted + raw                    # element-wise
```

The chain is bounded: a leaf walks at most `leaf_lod - absolute_lod` parents.

### The predictor — must match exactly

Prediction is closed-loop: the writer took each residual against the parent
*a reader reconstructs*, so an inexact predictor drifts and the error
compounds down the levels. This is bilinear upsampling of the parent's
matching quadrant, over the stored array including its skirt:

```
predict(parent, qx, qy):
    half = R / 2
    for py in -1 ..= R:
      for px in -1 ..= R:
        fx = qx * half + (px + 0.5) / 2 - 0.5
        fy = qy * half + (py + 0.5) / 2 - 0.5
        x0 = floor(fx); y0 = floor(fy)
        tx = fx - x0;   ty = fy - y0
        v = P(x0,   y0  ) * (1-tx) * (1-ty)
          + P(x0+1, y0  ) *    tx  * (1-ty)
          + P(x0,   y0+1) * (1-tx) *    ty
          + P(x0+1, y0+1) *    tx  *    ty
        out(px, py) = round_half_up(v)

P(x, y) = parent[ clamp(y + 1, 0, R + 1) * stride + clamp(x + 1, 0, R + 1) ]
```

`P` indexes the parent's stored array directly, so `x = -1` reads its skirt,
and the clamp only bites past that.

**`round_half_up` is not your language's `round`.** The writer is JavaScript,
where `Math.round` breaks ties toward `+∞`: `round(-2.5)` is `-2`. Rust and
C++ `round()` break ties away from zero and give `-3`. One texel off by a
metre at a coarse lod propagates into every descendant. Use:

```
round_half_up(v) = floor(v + 0.5)
```

## Traversal

Start at lod 0 — six nodes, one per face — and refine.

A node that is **present** replaces its parent for the ground it covers. A
node that is **absent** above `dense_lod` means the parent already describes
that ground within `max_error_m`; stop descending, and keep using the
ancestor you have. Absence never means missing data, so a reader needs no
hole handling and no fallback surface.

Because pruning cascades, an absent node has no descendants in the file
either. You can stop at the first miss without probing deeper.

`predictor_error_m` on a present node is the error its *parent* had, i.e. what
you avoid by fetching it. It is a reasonable input to a streaming priority.

## Heights

Metres, sea level zero, integers. Land is positive, ocean floor negative.
There is no separate sea-level field: compare against 0.

Terrain below the 90 m grain is not in this file and never will be — it is an
algorithm and a seed, evaluated at runtime. See
[export.md § Below 90 m](../stages/export.md#below-90-m--decided-runtime).

## Checks worth running against a new reader

Cheap, and each one has caught a real defect here:

1. **Every node's blob decodes to exactly `node_stride² * 2` bytes.**
2. **Every node has a parent in the file.** A child whose parent is absent is
   unreachable; that bug shipped 180 such nodes before the check existed.
3. **The dense base is complete** — all `6 * 4^lod` nodes for every
   `lod <= dense_lod`.
4. **Reconstruct a leaf and compare against a known height.** If your
   predictor rounds differently this is where it shows, and nowhere else.
5. **Check the poles and a face fold**, not just a face centre. Frame and
   orientation bugs look perfectly fine in the middle of a face.

## Content integrity

Optional `content_identity: "sha256-manifest-index-blobs-v1"` identifies packages
whose `blobs_sha256` hashes every byte from `blob_base` to EOF and whose
`index_sha256` hashes the fixed-size index bytes. `content_key` is SHA-256 of the
UTF-8 prefix `planet-package-v1` followed by a zero byte and `JSON.stringify`
of the manifest with `content_key` removed, preserving the writer's property
order. This is an integrity and cache identity contract, not authentication.
An unknown content identity is an error when validating. Old packages lacking
these fields can be decoded but cannot pass a content-integrity certificate.

The reference reader validates address ordering, uniqueness, ancestry, dense
coverage, nonoverlapping file-bounded blobs and the supported node layout before
exposing an index. Decoded arrays are cached per open package. The supported
node payload limit is 64 MiB; supported leaf levels are 0 through 25.
`--selftest` additionally decodes all nodes and checks content digests when
present. It does not certify the source's fidelity or the source's seam rules.

## Pruning certification

New exports identify `pruning.method` as `bilinear-subtree-v1`. Their omission
test compares the retained ancestor against every descendant's continuous
bilinear node surface and retains mixed dry/wet subtrees. `max_error_m` bounds
that omission, independently of the rounded one-level `predictor_error_m`.
Packages without this field predate full-subtree certification; the surviving
file cannot establish the error of source data removed during export.

This certificate does not assert cross-face source agreement or bound a
consumer's reprojection and interpolation changes. Those need separate tests.

## Known limitations

- **Fold skirts replicate.** Where a node's edge is a cube fold, its skirt
  repeats the edge texel instead of sampling the neighbouring face, because
  that neighbour lives on another face's plane. Interior and same-face tile
  edges carry real neighbour data.
- **A fold is two diffusions.** Elevations agree across it; terrain character
  does not always. See [terrain.md § Open](../stages/terrain.md#open).
- **Masked ground is sketch-grade.** Where the bake was masked to land and
  shelf, nodes come from the 23 km sketch interpolated up, not from the 90 m
  model. It is smooth, not detailed — real ground, lower information.
