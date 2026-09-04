/*
 * Cubesphere tiles — the grid the planet-scale bake will use.
 *
 * Six faces, equal-angle, a quadtree per face. A tile is (face, level, i, j)
 * and nothing else: no lon/lat box, no click position, no drift. Within a
 * face the tiles are a plain (i, j) lattice; across a face edge they meet
 * with a rotation but never a stagger, because both faces carry the same
 * 2^level steps along that edge. So 6 * 4^level tiles cover the sphere with
 * no gaps and no overlaps, and a tile at one level is exactly four at the
 * next. That nesting is why picking a coarse tile here still picks whole
 * bake tiles later — see docs/ref/cubesphere.md.
 *
 * Equal-angle rather than raw gnomonic: stepping the *angle* linearly holds
 * pixel scale to sqrt(2) across a face, where gnomonic spreads to ~2.12x. So
 * a "90 m" pixel is 90-127 m depending where it lands — worst at an edge
 * midpoint, not at the corners — which the model's learned statistics
 * tolerate. `bun run check:tiles` pins that ratio.
 *
 * Browser-free and DOM-free, like the other models here, so the app, the
 * export scripts and `bun run check:tiles` all share one definition.
 */
'use strict';

const DEG = Math.PI / 180;
const QUARTER = Math.PI / 4;

/*
 * n is the face centre, u runs east-ish and v north-ish across it, and
 * n = u x v everywhere so face space is right-handed. Keeping v north-ish on
 * the four equatorial faces is what makes a tile raster come out north-up,
 * the same way the old lon/lat crops did, so hillshading and the importer
 * see what they already expect.
 */
const FACES = [
    {name: '+x', n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1]},
    {name: '+y', n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1]},
    {name: '-x', n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1]},
    {name: '-y', n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1]},
    {name: '+z', n: [0, 0, 1], u: [0, 1, 0], v: [-1, 0, 0]},
    {name: '-z', n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0]},
];

const MIN_LEVEL = 0;
const MAX_LEVEL = 12;

function lonLatToXyz(lonDeg, latDeg) {
    const lon = lonDeg * DEG;
    const lat = latDeg * DEG;
    const cl = Math.cos(lat);
    return [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
}

function xyzToLonLat(p) {
    const r = Math.hypot(p[0], p[1], p[2]) || 1;
    return {
        lon: Math.atan2(p[1], p[0]) / DEG,
        lat: Math.asin(Math.max(-1, Math.min(1, p[2] / r))) / DEG,
    };
}

function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function tiles(level) {
    return 1 << level;
}

/* Which face owns a direction: the axis it leans on hardest. */
function faceOf(p) {
    const ax = Math.abs(p[0]);
    const ay = Math.abs(p[1]);
    const az = Math.abs(p[2]);
    if (ax >= ay && ax >= az) return p[0] >= 0 ? 0 : 2;
    if (ay >= az) return p[1] >= 0 ? 1 : 3;
    return p[2] >= 0 ? 4 : 5;
}

/*
 * Face coordinates in [-1, 1] across the face, and w, the depth toward the
 * face plane. The caller needs w: at w <= 0 the point is on the far side of
 * the planet and has no projection at all. Past |a| or |b| of 1 the point is
 * simply on a neighbouring face, and because atan keeps climbing smoothly
 * the mapping stays continuous there — which is what lets a mesh triangle
 * straddling a face edge rasterize without a seam.
 */
function faceCoords(face, p) {
    const f = FACES[face];
    const w = dot(p, f.n);
    if (!(w > 1e-9)) return null;
    return {
        a: Math.atan(dot(p, f.u) / w) / QUARTER,
        b: Math.atan(dot(p, f.v) / w) / QUARTER,
        w,
    };
}

/* Face coordinates back to a unit direction. */
function faceDirection(face, a, b) {
    const f = FACES[face];
    const ta = Math.tan(a * QUARTER);
    const tb = Math.tan(b * QUARTER);
    const x = f.n[0] + ta * f.u[0] + tb * f.v[0];
    const y = f.n[1] + ta * f.u[1] + tb * f.v[1];
    const z = f.n[2] + ta * f.u[2] + tb * f.v[2];
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
}

function clampLevel(level) {
    return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(level)));
}

function makeTile(face, level, i, j) {
    const n = tiles(level);
    return {
        face,
        level,
        i: Math.max(0, Math.min(n - 1, i)),
        j: Math.max(0, Math.min(n - 1, j)),
    };
}

function tileAt(lonDeg, latDeg, level) {
    const lvl = clampLevel(level);
    const p = lonLatToXyz(lonDeg, latDeg);
    const face = faceOf(p);
    const fc = faceCoords(face, p);
    if (!fc) return null;
    const n = tiles(lvl);
    return makeTile(
        face,
        lvl,
        Math.floor((fc.a + 1) / 2 * n),
        Math.floor((fc.b + 1) / 2 * n),
    );
}

/* The tile's own [-1, 1] face-space extent. j counts north-ish, like b. */
function tileExtent(tile) {
    const n = tiles(tile.level);
    return {
        a0: -1 + 2 * tile.i / n,
        a1: -1 + 2 * (tile.i + 1) / n,
        b0: -1 + 2 * tile.j / n,
        b1: -1 + 2 * (tile.j + 1) / n,
    };
}

function sameTile(a, b) {
    return !!a && !!b && a.face === b.face && a.level === b.level && a.i === b.i && a.j === b.j;
}

function tileName(tile) {
    return `f${tile.face}l${tile.level}x${tile.i}y${tile.j}`;
}

function parseTileName(name) {
    const m = /^f(\d)l(\d+)x(\d+)y(\d+)$/.exec(String(name || ''));
    if (!m) return null;
    const face = Number(m[1]);
    const level = Number(m[2]);
    if (face < 0 || face > 5 || level < MIN_LEVEL || level > MAX_LEVEL) return null;
    const n = tiles(level);
    const i = Number(m[3]);
    const j = Number(m[4]);
    if (i >= n || j >= n) return null;
    return {face, level, i, j};
}

/*
 * The tile's face-space square grown by `padA` / `padB` coarse cells. The
 * mapping already continues past |a|,|b| of 1, so a pad that steps off the
 * face is neighbouring-face terrain in this face's projection — not empty,
 * and not a repeated rim.
 */
function paddedExtent(tile, padA, padB, cellsA, cellsB) {
    const e = tileExtent(tile);
    const da = (e.a1 - e.a0) * padA / cellsA;
    const db = (e.b1 - e.b0) * padB / cellsB;
    return {a0: e.a0 - da, a1: e.a1 + da, b0: e.b0 - db, b1: e.b1 + db};
}

/*
 * Pixel position inside a raster covering `e`, row 0 at the north edge.
 * Returns null only when the point is on the far hemisphere and has no
 * projection at all. Values outside [0, width] are meaningful and wanted:
 * the rasterizer clips them, and a mesh triangle with one vertex just off
 * the tile still paints the part of itself that lands inside.
 *
 * Takes radians and hoists the face basis out, because this runs per mesh
 * vertex per tile — the rest of the module is the readable degrees wrapper
 * around it, so there is one copy of the projection.
 */
function projectorFromExtent(face, e, width, height) {
    const f = FACES[face];
    const sx = width / (e.a1 - e.a0);
    const sy = height / (e.b1 - e.b0);
    return function project(lonRad, latRad) {
        const cl = Math.cos(latRad);
        const px = cl * Math.cos(lonRad);
        const py = cl * Math.sin(lonRad);
        const pz = Math.sin(latRad);
        const w = px * f.n[0] + py * f.n[1] + pz * f.n[2];
        if (!(w > 1e-9)) return null;
        const a = Math.atan((px * f.u[0] + py * f.u[1] + pz * f.u[2]) / w) / QUARTER;
        const b = Math.atan((px * f.v[0] + py * f.v[1] + pz * f.v[2]) / w) / QUARTER;
        return {x: (a - e.a0) * sx, y: (e.b1 - b) * sy};
    };
}

function tileProjector(tile, width, height) {
    return projectorFromExtent(tile.face, tileExtent(tile), width, height);
}

/* Interior `cellsW`×`cellsH`, plus `padW`/`padH` cells of real neighbour
 * ground on each side. pad=0 is tileProjector. */
function paddedProjector(tile, cellsW, cellsH, padW, padH) {
    return projectorFromExtent(
        tile.face,
        paddedExtent(tile, padW, padH, cellsW, cellsH),
        cellsW + 2 * padW,
        cellsH + 2 * padH,
    );
}

function tilePixel(tile, lonDeg, latDeg, width, height) {
    return tileProjector(tile, width, height)(lonDeg * DEG, latDeg * DEG);
}

/*
 * A raster sample (s, t) in [0, 1], row 0 at the north edge, as a unit
 * ECEF direction. This is the tile's physical location: the same vector
 * the globe mesh uses. Overlay vertices, the exporter and tileLonLat all
 * go through here — converting to lon/lat and back is how a bake used to
 * float off the cell it was picked from.
 */
function tileDirection(tile, s, t) {
    const e = tileExtent(tile);
    return faceDirection(
        tile.face,
        e.a0 + (e.a1 - e.a0) * s,
        e.b1 + (e.b0 - e.b1) * t,
    );
}

function tileLonLat(tile, s, t) {
    return xyzToLonLat(tileDirection(tile, s, t));
}

/*
 * A triangle mesh for the tile, in the globe's own ECEF. Vertices are
 * tileDirection(s, t); UVs are the raster. The renderer draws this with
 * the same projection as the coarse surface, so the bake is pinned to
 * the ground rather than composited as a 2D billboard.
 */
function tileMesh(tile, steps) {
    const n = Math.max(1, steps | 0);
    return gridMesh(n, n, (s, t) => tileDirection(tile, s, t));
}

/*
 * Legacy lon/lat crops (andes / japan / islands, and anything baked
 * before the grid). Same ECEF as the globe, so they pin the same way
 * cube tiles do. east may be less than west, or greater than 180, for
 * a box that crosses the antimeridian.
 */
function lonLatMesh(west, south, east, north, steps) {
    let east2 = east;
    if (east2 < west) east2 += 360;
    const n = Math.max(1, steps | 0);
    return gridMesh(n, n, (s, t) => lonLatToXyz(
        west + (east2 - west) * s,
        north + (south - north) * t,
    ));
}

function gridMesh(nx, ny, at) {
    const vx = nx + 1;
    const vy = ny + 1;
    const xyz = new Float32Array(vx * vy * 3);
    const uv = new Float32Array(vx * vy * 2);
    const indices = new Uint32Array(nx * ny * 6);
    let p = 0;
    let t = 0;
    for (let j = 0; j <= ny; j++) {
        const v = j / ny;
        for (let i = 0; i <= nx; i++) {
            const u = i / nx;
            const d = at(u, v);
            xyz[p++] = d[0];
            xyz[p++] = d[1];
            xyz[p++] = d[2];
            uv[t++] = u;
            uv[t++] = v;
        }
    }
    let k = 0;
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const a = j * vx + i;
            const b = a + 1;
            const c = a + vx;
            const d = c + 1;
            indices[k++] = a;
            indices[k++] = c;
            indices[k++] = b;
            indices[k++] = b;
            indices[k++] = c;
            indices[k++] = d;
        }
    }
    return {xyz, uv, indices};
}

/* Corners in raster order: NW, NE, SE, SW. */
function tileCorners(tile) {
    const e = tileExtent(tile);
    return [
        xyzToLonLat(faceDirection(tile.face, e.a0, e.b1)),
        xyzToLonLat(faceDirection(tile.face, e.a1, e.b1)),
        xyzToLonLat(faceDirection(tile.face, e.a1, e.b0)),
        xyzToLonLat(faceDirection(tile.face, e.a0, e.b0)),
    ];
}

/*
 * The tile edge as lon/lat samples. A tile edge is a curve in both the globe
 * and the equirect, so everything that draws one walks this rather than
 * stroking a rectangle.
 */
function tileOutline(tile, steps) {
    const n = Math.max(2, steps || 8);
    const e = tileExtent(tile);
    const pts = [];
    const push = (a, b) => pts.push(xyzToLonLat(faceDirection(tile.face, a, b)));
    for (let k = 0; k <= n; k++) push(e.a0 + (e.a1 - e.a0) * (k / n), e.b1);
    for (let k = 1; k <= n; k++) push(e.a1, e.b1 + (e.b0 - e.b1) * (k / n));
    for (let k = 1; k <= n; k++) push(e.a1 + (e.a0 - e.a1) * (k / n), e.b0);
    for (let k = 1; k <= n; k++) push(e.a0, e.b0 + (e.b1 - e.b0) * (k / n));
    return pts;
}

/* Does the tile's face-space square straddle the face centre? Only the two
 * polar faces can then hold a pole, and only in that one tile. */
function holdsPole(tile) {
    if (tile.face !== 4 && tile.face !== 5) return false;
    const e = tileExtent(tile);
    return e.a0 <= 0 && e.a1 >= 0 && e.b0 <= 0 && e.b1 >= 0;
}

/*
 * A lon/lat bounding box for the tile. It is nominal — a cube tile is not an
 * axis-aligned rectangle — and is used for culling, for framing the view and
 * for the GeoTIFF's geotransform. The tile identity, not this box, is what
 * places the bake. east may exceed 180 to express a box crossing the
 * antimeridian, matching what the crop overlay already expects.
 */
function tileBBox(tile) {
    const pts = tileOutline(tile, 16);
    let south = 90;
    let north = -90;
    for (const p of pts) {
        south = Math.min(south, p.lat);
        north = Math.max(north, p.lat);
    }
    if (holdsPole(tile)) {
        return {
            west: -180,
            east: 180,
            south: tile.face === 5 ? -90 : south,
            north: tile.face === 4 ? 90 : north,
        };
    }
    /* Widest gap between consecutive longitudes is the part the tile misses,
     * so the box runs the other way round from there. */
    const lons = pts.map((p) => p.lon).sort((x, y) => x - y);
    let gap = lons[0] + 360 - lons[lons.length - 1];
    let west = lons[0];
    let east = lons[lons.length - 1];
    for (let k = 1; k < lons.length; k++) {
        const d = lons[k] - lons[k - 1];
        if (d > gap) {
            gap = d;
            west = lons[k];
            east = lons[k - 1] + 360;
        }
    }
    return {west, east, south, north};
}

/*
 * ---- the bake plane -------------------------------------------------
 *
 * The equal-angle face square is what a tile *is*: addressing, coverage,
 * nesting, and where the overlay drapes. It is not what the model should
 * paint on. Its two axes are not perpendicular on the ground — 0 degrees of
 * skew at a face centre and at an edge midpoint, but 30 degrees at a face
 * corner — so a circle comes out a sqrt(3) ellipse there. terrain-diffusion
 * paints terrain that is isotropic in its own square grid, so that ellipse
 * gets printed on the ground, pointing a different way on every face. Two
 * tiles across a fold then meet with their terrain combed 60-120 degrees
 * apart. Measured on a real corner bake: the smoothest ground bearing on the
 * three tiles ran 75, 120 and 165 degrees, each within a bin of its own
 * tile's stretch axis. Elevations, roughness and colour were all continuous
 * across the joins; the grain was not, and that is what the eye sees.
 *
 * So the model gets a different plane: stereographic from the face centre.
 * It is conformal, so anisotropy is exactly 1 everywhere and the grain has
 * no direction to inherit. Scale runs 1.00 at the face centre to 1.27 at a
 * corner — tighter than the equal-angle square's sqrt(2), and scale is the
 * distortion the model's learned statistics already tolerate.
 *
 * One plane per face, not one per tile. Per tile would be conformal too, and
 * would throw away the property the old face-wide cell origin bought:
 * neighbours on a face name overlapping cells of one lattice, so the bake
 * gives them the same noise there and their join is not a join at all. A
 * face-wide plane keeps that and drops the shear. `tileBakeRect` is what
 * hands a job its cells now.
 *
 * A bake still resamples back into the tile's own raster afterwards, so
 * output.elev, the drape and the tile grid are unchanged by any of this.
 */

/* Half-width of a face's footprint here. Edge midpoints reach furthest —
 * 2/(1+sqrt(2)) = 0.8284 against sqrt(3)-1 = 0.7321 at a corner — so the
 * face is a square with bulging sides, not a square. */
const FACE_STEREO_HALF = 2 / (1 + Math.SQRT2);

/* Direction -> the face's bake plane. Null behind the face's horizon. */
function faceStereo(face, p) {
    const f = FACES[face];
    const c = dot(p, f.n);
    if (!(c > -0.999999)) return null;
    const k = 2 / (1 + c);
    return {X: dot(p, f.u) * k, Y: dot(p, f.v) * k};
}

/* And back. r = 2 tan(rho/2), so the inverse is a rational map. */
function faceStereoDirection(face, X, Y) {
    const f = FACES[face];
    const d = 4 + X * X + Y * Y;
    const a = 4 * X / d;
    const b = 4 * Y / d;
    const c = (4 - X * X - Y * Y) / d;
    return [
        a * f.u[0] + b * f.v[0] + c * f.n[0],
        a * f.u[1] + b * f.v[1] + c * f.n[1],
        a * f.u[2] + b * f.v[2] + c * f.n[2],
    ];
}

/*
 * Ground metres per unit of the bake plane at (X, Y). The conformal scale
 * factor is (4 + r^2)/4, so ground step is its reciprocal: a uniform grid
 * here is finest at the corners, by 1.27x, and square everywhere.
 */
function faceStereoGroundStep(X, Y, radiusM) {
    return radiusM * 4 / (4 + X * X + Y * Y);
}

/*
 * The tile's footprint in its face's bake plane. The edges are curved here,
 * so walk the outline rather than mapping the four corners.
 */
/*
 * The tile's face-space square grown by `halo` coarse cells on the named
 * sides only. A fold needs ground past its edge to stitch with; the other
 * sides do not, because same-face neighbours already share this lattice.
 * Asymmetric, so `paddedExtent` cannot do it.
 */
function haloExtent(tile, cells, halo) {
    const e = tileExtent(tile);
    if (!halo) return e;
    const da = (e.a1 - e.a0) / Math.max(1, cells);
    const db = (e.b1 - e.b0) / Math.max(1, cells);
    return {
        a0: e.a0 - da * (halo.west || 0),
        a1: e.a1 + da * (halo.east || 0),
        b0: e.b0 - db * (halo.south || 0),
        b1: e.b1 + db * (halo.north || 0),
    };
}

function tileStereoBox(tile, steps = 16, extent = null) {
    const e = extent || tileExtent(tile);
    let X0 = Infinity, X1 = -Infinity, Y0 = Infinity, Y1 = -Infinity;
    const at = (a, b) => {
        const s = faceStereo(tile.face, faceDirection(tile.face, a, b));
        if (!s) return;
        X0 = Math.min(X0, s.X); X1 = Math.max(X1, s.X);
        Y0 = Math.min(Y0, s.Y); Y1 = Math.max(Y1, s.Y);
    };
    for (let k = 0; k <= steps; k++) {
        const ta = e.a0 + (e.a1 - e.a0) * (k / steps);
        const tb = e.b0 + (e.b1 - e.b0) * (k / steps);
        at(ta, e.b0);
        at(ta, e.b1);
        at(e.a0, tb);
        at(e.a1, tb);
    }
    return {X0, X1, Y0, Y1};
}

/*
 * The shared lattice. Cells are square in the plane and indexed from the
 * face centre, so two tiles of one face that touch land on the same cells
 * and the bake gives them the same noise there.
 */
function stereoCellSize(level, cells) {
    return 2 * FACE_STEREO_HALF / (tiles(level) * Math.max(1, cells));
}

/*
 * The lattice rectangle a bake covers for this tile: its footprint rounded
 * out to whole cells, then grown by `pad`. Sizes vary a little between
 * tiles, because a conformal plane does not cut a face into equal squares —
 * the caller reads cropW/cropH off this rather than assuming cells^2.
 */
function tileBakeRect(tile, cells, pad = 0, halo = null) {
    const step = stereoCellSize(tile.level, cells);
    const box = tileStereoBox(tile, 16, haloExtent(tile, cells, halo));
    const i0 = Math.floor(box.X0 / step) - pad;
    const j0 = Math.floor(box.Y0 / step) - pad;
    const i1 = Math.ceil(box.X1 / step) + pad;
    const j1 = Math.ceil(box.Y1 / step) + pad;
    return {step, originI: i0, originJ: j0, width: i1 - i0, height: j1 - j0};
}

/* A bake-plane sample (x, y) of `rect`, as a unit direction. Row 0 is the
 * high-Y edge, matching the tile raster's north-up rows. */
function bakeDirection(tile, rect, x, y) {
    return faceStereoDirection(
        tile.face,
        (rect.originI + x) * rect.step,
        (rect.originJ + rect.height - y) * rect.step,
    );
}

/* Where a direction lands in `rect`, in samples. Null behind the horizon. */
function bakePixel(tile, rect, p) {
    const s = faceStereo(tile.face, p);
    if (!s) return null;
    return {
        x: s.X / rect.step - rect.originI,
        y: rect.originJ + rect.height - s.Y / rect.step,
    };
}

const EDGES = ['east', 'north', 'west', 'south'];

/* Which sides of the face this tile sits on. Empty when the tile is
 * interior to its face. Two entries is a face corner — three faces meet. */
function faceEdges(tile) {
    const n = tiles(tile.level);
    const out = [];
    if (tile.i === n - 1) out.push('east');
    if (tile.j === n - 1) out.push('north');
    if (tile.i === 0) out.push('west');
    if (tile.j === 0) out.push('south');
    return out;
}

/*
 * One step past the named edge, as a direction. 0.51 of the tile from the
 * centre is 0.01 into the neighbour, so faceOf is unambiguous — the exact
 * edge is a tie.
 */
function stepPastEdge(tile, edge) {
    const e = tileExtent(tile);
    const aMid = (e.a0 + e.a1) / 2;
    const bMid = (e.b0 + e.b1) / 2;
    const da = e.a1 - e.a0;
    const db = e.b1 - e.b0;
    const k = 0.51;
    if (edge === 'east') return faceDirection(tile.face, aMid + da * k, bMid);
    if (edge === 'west') return faceDirection(tile.face, aMid - da * k, bMid);
    if (edge === 'north') return faceDirection(tile.face, aMid, bMid + db * k);
    if (edge === 'south') return faceDirection(tile.face, aMid, bMid - db * k);
    return null;
}

/*
 * The tile across a given edge. Interior edges stay on the face (i, j
 * step). Face edges land on the neighbouring face with that face's own
 * (i, j) — polar attachments rotate, which is why this goes through ECEF
 * rather than a hand-coded index map.
 */
function neighborTile(tile, edge) {
    if (!tile || EDGES.indexOf(edge) < 0) return null;
    const n = tiles(tile.level);
    if (edge === 'east' && tile.i < n - 1) {
        return makeTile(tile.face, tile.level, tile.i + 1, tile.j);
    }
    if (edge === 'west' && tile.i > 0) {
        return makeTile(tile.face, tile.level, tile.i - 1, tile.j);
    }
    if (edge === 'north' && tile.j < n - 1) {
        return makeTile(tile.face, tile.level, tile.i, tile.j + 1);
    }
    if (edge === 'south' && tile.j > 0) {
        return makeTile(tile.face, tile.level, tile.i, tile.j - 1);
    }
    const p = stepPastEdge(tile, edge);
    if (!p) return null;
    const ll = xyzToLonLat(p);
    return tileAt(ll.lon, ll.lat, tile.level);
}

/* Named edge of `from` that lands on `to`, or null. Polar joins are not
 * opposite names: face 1's north is face 4's east. */
function sharedEdge(from, to) {
    if (!from || !to) return null;
    for (let i = 0; i < EDGES.length; i++) {
        const n = neighborTile(from, EDGES[i]);
        if (n && sameTile(n, to)) return EDGES[i];
    }
    return null;
}

/* Every tile in the (i, j) rectangle spanned by two tiles on one face. */
function tileRange(a, b) {
    if (!a || !b || a.face !== b.face || a.level !== b.level) return a ? [a] : [];
    const out = [];
    for (let j = Math.min(a.j, b.j); j <= Math.max(a.j, b.j); j++) {
        for (let i = Math.min(a.i, b.i); i <= Math.max(a.i, b.i); i++) {
            out.push({face: a.face, level: a.level, i, j});
        }
    }
    return out;
}

/*
 * Nominal tile edge in km: a face edge is a quarter of a great circle, cut
 * into 2^level. Equal-angle tiles vary by up to ~1.3x within a face, so this
 * is the average rather than a promise about any one tile.
 */
function faceEdgeKm(radiusKm) {
    return (Math.PI / 2) * radiusKm;
}

function tileEdgeKm(level, radiusKm) {
    return faceEdgeKm(radiusKm) / tiles(clampLevel(level));
}

/* Conditioning cells across a tile, at the coarse scale the model wants. */
function tileCells(level, radiusKm, scaleKm) {
    return Math.max(1, Math.round(tileEdgeKm(level, radiusKm) / scaleKm));
}

/*
 * Bakeable cube levels: enough coarse cells to condition on, few enough that
 * one bake stays a preview. The picker uses one of these (see bestLevel);
 * cover more ground by picking more tiles. Coarse to fine.
 */
/*
 * The largest bake rectangle any tile of this level needs. A conformal plane
 * does not cut a face into equal squares: a corner tile's footprint spans up
 * to 1.5x the nominal cell count, because that is where the plane's scale is
 * furthest from the face centre's. The cap has to be tested against this and
 * not against `tileCells`, or the picker offers a level the bake then
 * refuses — the exact failure the MIN/MAX comment in src/td-tile.js is about,
 * one step further back.
 */
function worstBakeCells(level, cells, haloCells = 0) {
    const n = tiles(level);
    let worst = 0;
    for (const [i, j] of [[n - 1, n - 1], [n - 1, n >> 1], [n >> 1, n >> 1], [0, 0]]) {
        const tile = {face: 0, level, i, j};
        const halo = {};
        for (const edge of faceEdges(tile)) halo[edge] = haloCells;
        const r = tileBakeRect(tile, cells, 0, halo);
        worst = Math.max(worst, r.width, r.height);
    }
    return worst;
}

/* `haloCells` is TdTile.SEAM_HALO_CELLS — a fold tile bakes its own overlap,
 * so the cap has to be measured against the rectangle that includes it. */
function usableLevels(radiusKm, scaleKm, minCells, maxCells, haloCells = 0) {
    const out = [];
    for (let level = MIN_LEVEL; level <= MAX_LEVEL; level++) {
        const cells = tileCells(level, radiusKm, scaleKm);
        if (worstBakeCells(level, cells, haloCells) > maxCells) continue;
        if (cells < minCells) break;
        out.push(level);
    }
    return out;
}

/*
 * The one level the picker uses on a planet of this size: nearest the
 * target ground width, out of those a bake will actually accept.
 *
 * Choosing from the usable set rather than filtering afterwards is the point.
 * The same level covers different ground on different planets — level 4 is
 * 313 km on a half-radius planet and 626 km on an Earth-sized one — so a
 * level hard-coded for one planet silently becomes an impossible bake on
 * another, which is exactly what happened.
 */
function bestLevel(targetKm, radiusKm, scaleKm, minCells, maxCells, haloCells = 0) {
    const levels = usableLevels(radiusKm, scaleKm, minCells, maxCells, haloCells);
    if (!levels.length) return levelForKm(targetKm, radiusKm);
    let best = levels[0];
    let bestErr = Infinity;
    for (const level of levels) {
        const err = Math.abs(Math.log(tileEdgeKm(level, radiusKm) / targetKm));
        if (err < bestErr) {
            bestErr = err;
            best = level;
        }
    }
    return best;
}

/* The level whose tile comes closest to a target width on the ground. */
function levelForKm(targetKm, radiusKm) {
    let best = MIN_LEVEL;
    let bestErr = Infinity;
    for (let level = MIN_LEVEL; level <= MAX_LEVEL; level++) {
        const err = Math.abs(Math.log(tileEdgeKm(level, radiusKm) / targetKm));
        if (err < bestErr) {
            bestErr = err;
            best = level;
        }
    }
    return best;
}

module.exports = {
    FACES,
    MIN_LEVEL,
    MAX_LEVEL,
    lonLatToXyz,
    xyzToLonLat,
    faceOf,
    faceCoords,
    faceDirection,
    clampLevel,
    makeTile,
    tileAt,
    tileExtent,
    paddedExtent,
    sameTile,
    tileName,
    parseTileName,
    tileProjector,
    paddedProjector,
    tilePixel,
    tileDirection,
    tileLonLat,
    tileMesh,
    lonLatMesh,
    tileCorners,
    tileOutline,
    tileBBox,
    EDGES,
    FACE_STEREO_HALF,
    faceStereo,
    faceStereoDirection,
    faceStereoGroundStep,
    haloExtent,
    tileStereoBox,
    stereoCellSize,
    tileBakeRect,
    bakeDirection,
    bakePixel,
    faceEdges,
    neighborTile,
    sharedEdge,
    tileRange,
    faceEdgeKm,
    tileEdgeKm,
    tileCells,
    worstBakeCells,
    usableLevels,
    bestLevel,
    levelForKm,
};
