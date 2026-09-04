#!/usr/bin/env bun
/**
 * Check the cubesphere tile grid covers the sphere exactly.
 *
 *   bun run check:tiles
 *
 * The tile grid is the one part of the crop system that can be judged
 * without a picture, so it gets judged hard here. What matters is not that
 * the formulas run but that the grid is a partition: every direction lands
 * in exactly one tile, a tile's own centre lands back in itself, and four
 * tiles at level+1 make up one at level. Those are what let a bake be
 * addressed by (face, level, i, j) instead of by wherever a mouse was.
 *
 * Browser-free, so this runs alongside `check:projects` and `check:earth`.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Cube = require(join(root, "src", "cubesphere.js"));

const failures = [];
const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else { console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
};

/* Fixed stream, so a failure is the same failure on the next run. */
let seed = 20260823;
function rnd() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
}
function randomLonLat() {
    return {lon: rnd() * 360 - 180, lat: Math.asin(rnd() * 2 - 1) / (Math.PI / 180)};
}

console.log("cubesphere tiles");

/* 1. Exactly one face owns each direction. Ties on a face edge are real —
 * the point is on the boundary — so count faces that own it strictly. */
{
    let bad = 0;
    let ownerless = 0;
    for (let k = 0; k < 20000; k++) {
        const {lon, lat} = randomLonLat();
        const p = Cube.lonLatToXyz(lon, lat);
        let owners = 0;
        for (let face = 0; face < 6; face++) {
            const fc = Cube.faceCoords(face, p);
            if (fc && Math.abs(fc.a) < 1 && Math.abs(fc.b) < 1) owners++;
        }
        if (owners > 1) bad++;
        if (owners === 0) ownerless++;
    }
    check("each direction is inside exactly one face", bad === 0 && ownerless === 0,
        `${bad} shared, ${ownerless} homeless`);
}

/* 2. tileAt agrees with the face-space extent it claims to have chosen. */
{
    let bad = 0;
    for (let k = 0; k < 20000; k++) {
        const {lon, lat} = randomLonLat();
        const level = 1 + Math.floor(rnd() * 6);
        const tile = Cube.tileAt(lon, lat, level);
        if (!tile) { bad++; continue; }
        const fc = Cube.faceCoords(tile.face, Cube.lonLatToXyz(lon, lat));
        const e = Cube.tileExtent(tile);
        const inside = fc && fc.a >= e.a0 - 1e-9 && fc.a <= e.a1 + 1e-9
            && fc.b >= e.b0 - 1e-9 && fc.b <= e.b1 + 1e-9;
        if (!inside) bad++;
    }
    check("tileAt lands inside the tile it names", bad === 0, `${bad} outside`);
}

/* 3. Every tile's own centre comes back as that tile — the grid closes. */
{
    let bad = 0;
    let count = 0;
    for (let level = 0; level <= 4; level++) {
        const n = 1 << level;
        for (let face = 0; face < 6; face++) {
            for (let j = 0; j < n; j++) {
                for (let i = 0; i < n; i++) {
                    const tile = {face, level, i, j};
                    const e = Cube.tileExtent(tile);
                    const mid = Cube.xyzToLonLat(
                        Cube.faceDirection(face, (e.a0 + e.a1) / 2, (e.b0 + e.b1) / 2),
                    );
                    count++;
                    if (!Cube.sameTile(Cube.tileAt(mid.lon, mid.lat, level), tile)) bad++;
                }
            }
        }
    }
    check(`every tile centre round-trips (${count} tiles)`, bad === 0, `${bad} lost`);
}

/* 4. Names round-trip, because they become folder names on disk. */
{
    let bad = 0;
    for (let k = 0; k < 2000; k++) {
        const level = Math.floor(rnd() * 9);
        const n = 1 << level;
        const tile = {
            face: Math.floor(rnd() * 6),
            level,
            i: Math.floor(rnd() * n),
            j: Math.floor(rnd() * n),
        };
        if (!Cube.sameTile(Cube.parseTileName(Cube.tileName(tile)), tile)) bad++;
    }
    check("tile names round-trip", bad === 0, `${bad} lost`);
    check("a bad name is rejected", Cube.parseTileName("f9l2x0y0") === null
        && Cube.parseTileName("tile-e12-n34") === null
        && Cube.parseTileName("f0l2x4y0") === null);
}

/* 5. Levels nest: a tile at level+1 sits inside its parent's quadrant. So a
 * coarse pick here is still a whole number of the bake's own tiles. */
{
    let bad = 0;
    for (let k = 0; k < 20000; k++) {
        const {lon, lat} = randomLonLat();
        const level = Math.floor(rnd() * 7);
        const parent = Cube.tileAt(lon, lat, level);
        const child = Cube.tileAt(lon, lat, level + 1);
        if (!parent || !child) { bad++; continue; }
        if (child.face !== parent.face || (child.i >> 1) !== parent.i || (child.j >> 1) !== parent.j) bad++;
    }
    check("level+1 tiles nest inside their parent", bad === 0, `${bad} adrift`);
}

/* 6. A tile's corners land on its raster corners, north-up. */
{
    let bad = 0;
    for (let k = 0; k < 2000; k++) {
        const level = 1 + Math.floor(rnd() * 5);
        const n = 1 << level;
        const tile = {
            face: Math.floor(rnd() * 6),
            level,
            i: Math.floor(rnd() * n),
            j: Math.floor(rnd() * n),
        };
        const [nw, ne, se] = Cube.tileCorners(tile);
        const pnw = Cube.tilePixel(tile, nw.lon, nw.lat, 256, 256);
        const pne = Cube.tilePixel(tile, ne.lon, ne.lat, 256, 256);
        const pse = Cube.tilePixel(tile, se.lon, se.lat, 256, 256);
        const near = (v, want) => Math.abs(v - want) < 1e-6;
        if (!(pnw && pne && pse
            && near(pnw.x, 0) && near(pnw.y, 0)
            && near(pne.x, 256) && near(pne.y, 0)
            && near(pse.x, 256) && near(pse.y, 256))) bad++;
    }
    check("tile corners map to raster corners, north-up", bad === 0, `${bad} skewed`);
}

/* 6b. The overlay sample (s, t) is the inverse of that raster. One
 * function, so a bake cannot sit next to the cell it was picked from. */
{
    let bad = 0;
    for (let k = 0; k < 2000; k++) {
        const level = 1 + Math.floor(rnd() * 5);
        const n = 1 << level;
        const tile = {
            face: Math.floor(rnd() * 6),
            level,
            i: Math.floor(rnd() * n),
            j: Math.floor(rnd() * n),
        };
        const s = rnd();
        const t = rnd();
        const ll = Cube.tileLonLat(tile, s, t);
        const px = Cube.tilePixel(tile, ll.lon, ll.lat, 256, 256);
        if (!px || Math.abs(px.x - s * 256) > 1e-4 || Math.abs(px.y - t * 256) > 1e-4) bad++;
    }
    check("tileLonLat is the inverse of tilePixel", bad === 0, `${bad} misplaced`);
}

/* 6c. Placement is ECEF, not a lon/lat round-trip. The globe shader takes
 * a unit direction; converting through degrees and back is what let a bake
 * sit next to the cell it came from, and float as the camera moved. */
{
    let bad = 0;
    for (let k = 0; k < 2000; k++) {
        const level = 1 + Math.floor(rnd() * 5);
        const n = 1 << level;
        const tile = {
            face: Math.floor(rnd() * 6),
            level,
            i: Math.floor(rnd() * n),
            j: Math.floor(rnd() * n),
        };
        const s = rnd();
        const t = rnd();
        const d = Cube.tileDirection(tile, s, t);
        const len = Math.hypot(d[0], d[1], d[2]);
        const px = Cube.tilePixel(tile, ...lonlat(d), 256, 256);
        if (Math.abs(len - 1) > 1e-9) bad++;
        if (!px || Math.abs(px.x - s * 256) > 1e-4 || Math.abs(px.y - t * 256) > 1e-4) bad++;
    }
    check("tileDirection is a unit vector on the raster", bad === 0, `${bad} adrift`);
}

function lonlat(d) {
    const ll = Cube.xyzToLonLat(d);
    return [ll.lon, ll.lat];
}

/* 6d. The mesh the renderer draws is that same direction field. A vertex
 * that had gone through lon/lat would not equal tileDirection, and would
 * not share the globe's transform. */
{
    let bad = 0;
    const steps = 4;
    for (let k = 0; k < 400; k++) {
        const level = 1 + Math.floor(rnd() * 4);
        const n = 1 << level;
        const tile = {
            face: Math.floor(rnd() * 6),
            level,
            i: Math.floor(rnd() * n),
            j: Math.floor(rnd() * n),
        };
        const mesh = Cube.tileMesh(tile, steps);
        const verts = steps + 1;
        if (mesh.xyz.length !== verts * verts * 3) { bad++; continue; }
        if (mesh.indices.length !== steps * steps * 6) { bad++; continue; }
        for (let j = 0; j <= steps; j++) {
            for (let i = 0; i <= steps; i++) {
                const d = Cube.tileDirection(tile, i / steps, j / steps);
                const p = (j * verts + i) * 3;
                if (Math.abs(mesh.xyz[p] - d[0]) > 1e-6
                    || Math.abs(mesh.xyz[p + 1] - d[1]) > 1e-6
                    || Math.abs(mesh.xyz[p + 2] - d[2]) > 1e-6) bad++;
                const u = (j * verts + i) * 2;
                if (Math.abs(mesh.uv[u] - i / steps) > 1e-6
                    || Math.abs(mesh.uv[u + 1] - j / steps) > 1e-6) bad++;
            }
        }
    }
    check("tileMesh vertices are tileDirection", bad === 0, `${bad} skewed`);
}

/* 6e. A cube tile is not its nominal lon/lat box. Placing a bake from
 * tileBBox is how a grid crop floated while andes/japan/islands (real
 * lon/lat rasters) stayed put. */
{
    const tile = {face: 0, level: 3, i: 7, j: 0};
    const mid = Cube.tileDirection(tile, 0.5, 0.5);
    const box = Cube.tileBBox(tile);
    const boxed = Cube.lonLatToXyz(
        (box.west + box.east) / 2,
        (box.south + box.north) / 2,
    );
    const far = Math.hypot(mid[0] - boxed[0], mid[1] - boxed[1], mid[2] - boxed[2]);
    check("a cube tile's centre is not its bbox centre", far > 1e-4, `gap ${far.toFixed(6)}`);
    const mesh = Cube.lonLatMesh(-10, -5, 10, 5, 2);
    const nw = Cube.lonLatToXyz(-10, 5);
    check("lonLatMesh corners sit on the box",
        Math.abs(mesh.xyz[0] - nw[0]) < 1e-6
        && Math.abs(mesh.xyz[1] - nw[1]) < 1e-6
        && Math.abs(mesh.xyz[2] - nw[2]) < 1e-6);
}

/* 7. The mapping stays continuous just past a tile edge. A mesh triangle
 * straddling the edge has to rasterize its share rather than fly off. */
{
    const tile = {face: 0, level: 3, i: 7, j: 4};
    const e = Cube.tileExtent(tile);
    const step = (e.a1 - e.a0) / 512;
    let worst = 0;
    for (let k = -8; k <= 8; k++) {
        const here = Cube.xyzToLonLat(Cube.faceDirection(0, e.a1 + k * step, (e.b0 + e.b1) / 2));
        const next = Cube.xyzToLonLat(Cube.faceDirection(0, e.a1 + (k + 1) * step, (e.b0 + e.b1) / 2));
        const a = Cube.tilePixel(tile, here.lon, here.lat, 512, 512);
        const b = Cube.tilePixel(tile, next.lon, next.lat, 512, 512);
        if (!a || !b) { worst = Infinity; break; }
        worst = Math.max(worst, Math.abs(b.x - a.x));
    }
    check("pixel mapping is continuous across a face edge", worst < 4, `jump of ${worst.toFixed(2)} px`);
}

/* 8. The nominal bbox actually contains the tile. It only frames and culls,
 * but a box that clips the tile would hide part of a bake. */
{
    let bad = 0;
    for (let k = 0; k < 4000; k++) {
        const level = 1 + Math.floor(rnd() * 5);
        const n = 1 << level;
        const tile = {
            face: Math.floor(rnd() * 6),
            level,
            i: Math.floor(rnd() * n),
            j: Math.floor(rnd() * n),
        };
        const box = Cube.tileBBox(tile);
        for (const p of Cube.tileOutline(tile, 12)) {
            let lon = p.lon;
            while (lon < box.west - 1e-6) lon += 360;
            while (lon > box.east + 1e-6) lon -= 360;
            const ok = lon >= box.west - 1e-6 && lon <= box.east + 1e-6
                && p.lat >= box.south - 1e-6 && p.lat <= box.north + 1e-6;
            if (!ok) { bad++; break; }
        }
    }
    check("nominal bbox contains its tile", bad === 0, `${bad} clipped`);
}

/* 9. Equal-angle earns its keep. Scale across a face varies by exactly
 * sqrt(2) — the analytic figure for |dp/dalpha| = (1+X^2)sqrt(1+Y^2)/r^2,
 * worst at an edge midpoint — against ~2.12x for raw gnomonic. Pinned tight
 * rather than loose: if the mapping ever drifts back to gnomonic the ratio
 * jumps to 2.1 and this is what says so. */
{
    const level = 5;
    const n = 1 << level;
    const arcs = [];
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const [nw, ne, se] = Cube.tileCorners({face: 0, level, i, j});
            arcs.push(arc(nw, ne), arc(ne, se));
        }
    }
    const ratio = Math.max(...arcs) / Math.min(...arcs);
    check(`scale varies ${ratio.toFixed(3)}x across a face`, Math.abs(ratio - Math.SQRT2) < 0.01,
        `expected sqrt(2) = ${Math.SQRT2.toFixed(3)}`);
    console.log(`        a 90 m pixel is 90–${(90 * Math.SQRT2).toFixed(0)} m depending where it lands`);
}

/*
 * 9b. Scale was only half the story, and the missing half is what a bake
 * shows. The two face axes are not perpendicular on the ground: the skew is
 * 0 at a face centre and at an edge midpoint — where the scale ratio is
 * worst — and 30 degrees at a face corner, where the scale ratio is 1. Two
 * equal axes 120 degrees apart turn a circle into a sqrt(3) ellipse, so the
 * ground anisotropy peaks at a *corner*, and is worse than the sqrt(2) above.
 *
 * It matters because the model paints terrain that is isotropic in its own
 * square grid, so whatever this map does to a circle is printed on the
 * ground — and it points a different way on each face. Two tiles across a
 * fold then meet with their terrain combed 60-120 degrees apart, which no
 * amount of stitching the elevations can hide. Report it, so a change of
 * projection is judged on this number and not only on scale.
 */
{
    const at = (a, b) => {
        const h = 1e-4;
        const d = (u0, v0, u1, v1) => {
            const A = Cube.faceDirection(0, u0, v0);
            const B = Cube.faceDirection(0, u1, v1);
            return [A[0] - B[0], A[1] - B[1], A[2] - B[2]];
        };
        const du = d(a + h, b, a - h, b);
        const dv = d(a, b + h, a, b - h);
        const la = Math.hypot(du[0], du[1], du[2]);
        const lb = Math.hypot(dv[0], dv[1], dv[2]);
        const cos = (du[0] * dv[0] + du[1] * dv[1] + du[2] * dv[2]) / (la * lb);
        /* Singular values of [du dv]: what the unit circle becomes. */
        const p = la * la + lb * lb;
        const q = la * lb * Math.sqrt(Math.max(0, 1 - cos * cos));
        const disc = Math.sqrt(Math.max(0, p * p - 4 * q * q));
        return {
            aniso: Math.sqrt((p + disc) / 2) / Math.sqrt(Math.max(1e-30, (p - disc) / 2)),
            skew: 90 - Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI,
        };
    };
    const SQRT3 = Math.sqrt(3);
    const centre = at(0, 0);
    const edge = at(1 - 1e-4, 0);
    const corner = at(1 - 1e-4, 1 - 1e-4);
    check("a face centre is isotropic", Math.abs(centre.aniso - 1) < 0.01,
        `${centre.aniso.toFixed(3)} : 1`);
    check("an edge midpoint is skew-free, so there its anisotropy is the scale ratio",
        Math.abs(edge.skew) < 0.01 && Math.abs(edge.aniso - Math.SQRT2) < 0.01,
        `skew ${edge.skew.toFixed(2)} deg, ${edge.aniso.toFixed(3)} : 1`);
    check(`a face corner is sqrt(3) = ${SQRT3.toFixed(3)}, the worst on the sphere`,
        Math.abs(corner.skew + 30) < 0.05 && Math.abs(corner.aniso - SQRT3) < 0.01,
        `skew ${corner.skew.toFixed(2)} deg, ${corner.aniso.toFixed(3)} : 1`);
    console.log(`        terrain isotropic in the raster comes out `
        + `${corner.aniso.toFixed(2)}:1 stretched at a face corner, and the`);
    console.log(`        stretch points a different way on each face that meets there`);
}

/*
 * 9c. The bake plane answers 9b. Stereographic from the face centre is
 * conformal, so the anisotropy above becomes exactly 1 everywhere and the
 * model's isotropic terrain has no direction to inherit. What it spends
 * instead is scale, and it spends less of it than the equal-angle square
 * does: 1.27x across a face against sqrt(2).
 */
{
    const aniso = (face, X, Y) => {
        const h = 1e-5;
        const d = (x0, y0, x1, y1) => {
            const A = Cube.faceStereoDirection(face, x0, y0);
            const B = Cube.faceStereoDirection(face, x1, y1);
            return [A[0] - B[0], A[1] - B[1], A[2] - B[2]];
        };
        const du = d(X + h, Y, X - h, Y);
        const dv = d(X, Y + h, X, Y - h);
        const la = Math.hypot(du[0], du[1], du[2]);
        const lb = Math.hypot(dv[0], dv[1], dv[2]);
        const cos = (du[0] * dv[0] + du[1] * dv[1] + du[2] * dv[2]) / (la * lb);
        const p = la * la + lb * lb;
        const q = la * lb * Math.sqrt(Math.max(0, 1 - cos * cos));
        const disc = Math.sqrt(Math.max(0, p * p - 4 * q * q));
        return Math.sqrt((p + disc) / 2) / Math.sqrt(Math.max(1e-30, (p - disc) / 2));
    };
    const H = Cube.FACE_STEREO_HALF;
    let worst = 0;
    let at = "";
    for (let face = 0; face < 6; face++) {
        for (let gy = 0; gy <= 12; gy++) {
            for (let gx = 0; gx <= 12; gx++) {
                const X = -H + 2 * H * gx / 12;
                const Y = -H + 2 * H * gy / 12;
                const a = aniso(face, X, Y);
                if (a > worst) { worst = a; at = `face ${face} (${X.toFixed(2)}, ${Y.toFixed(2)})`; }
            }
        }
    }
    check("the bake plane is conformal — anisotropy 1 everywhere",
        worst < 1.0005, `worst ${worst.toFixed(6)} at ${at}`);

    const step = (X, Y) => Cube.faceStereoGroundStep(X, Y, 1);
    const centre = step(0, 0);
    const cornerXY = Math.sqrt(3) - 1;
    const ratio = centre / step(cornerXY, cornerXY);
    check(`the bake plane spends ${ratio.toFixed(3)}x of scale instead`,
        Math.abs(ratio - (3 - Math.sqrt(3))) < 0.002 && ratio < Math.SQRT2,
        `expected 3 - sqrt(3) = ${(3 - Math.sqrt(3)).toFixed(3)}, and under the equal-angle sqrt(2)`);

    /* Round trip, or a bake cannot be put back on the tile it came from. */
    let err = 0;
    for (let k = 0; k < 4000; k++) {
        const {lon, lat} = randomLonLat();
        const p = Cube.lonLatToXyz(lon, lat);
        const face = Cube.faceOf(p);
        const s = Cube.faceStereo(face, p);
        const q = Cube.faceStereoDirection(face, s.X, s.Y);
        err = Math.max(err, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
    }
    check("bake plane round-trips a direction", err < 1e-12, `worst ${err.toExponential(2)}`);

    /* One lattice per face is the whole point: neighbours must land on the
     * same cells, or the bake stops sharing noise and every same-face edge
     * becomes a join. Rects are sized off the footprint, so they differ. */
    const cells = 14;
    const a = Cube.tileBakeRect({face: 0, level: 4, i: 7, j: 7}, cells, 64);
    const b = Cube.tileBakeRect({face: 0, level: 4, i: 8, j: 7}, cells, 64);
    const c = Cube.tileBakeRect({face: 0, level: 4, i: 15, j: 15}, cells, 64);
    check("same-face neighbours share one lattice",
        a.step === b.step && a.step === c.step
        && Number.isInteger(a.originI) && Number.isInteger(b.originI)
        && b.originI > a.originI && b.originI < a.originI + a.width,
        `steps ${a.step.toExponential(3)}, origins ${a.originI} then ${b.originI}, widths ${a.width}/${b.width}`);
    console.log(`        a level-4 bake rect is ${a.width}x${a.height} at the face centre,`
        + ` ${c.width}x${c.height} at a corner`);

    /* And the rect really does cover its tile, or the resample back into the
     * tile raster would read off the end of the bake. */
    let outside = 0;
    for (const tile of [{face: 0, level: 4, i: 7, j: 7}, {face: 1, level: 4, i: 15, j: 0},
                        {face: 5, level: 4, i: 15, j: 0}, {face: 4, level: 4, i: 0, j: 0}]) {
        const rect = Cube.tileBakeRect(tile, cells, 0);
        for (let gy = 0; gy <= 24; gy++) {
            for (let gx = 0; gx <= 24; gx++) {
                const px = Cube.bakePixel(tile, rect, Cube.tileDirection(tile, gx / 24, gy / 24));
                if (!px || px.x < -1e-6 || px.y < -1e-6
                    || px.x > rect.width + 1e-6 || px.y > rect.height + 1e-6) outside++;
            }
        }
    }
    check("a bake rect covers its whole tile", outside === 0, `${outside} samples off the rect`);

    /*
     * And the whole trip: rasterize a rough field on the bake plane, resample
     * it onto the tile raster, compare with the field sampled there directly.
     * This is the step that replaces "the model painted on the tile square",
     * so if it loses the terrain there is no point in the plane being nicer.
     */
    {
        const Seam = require(join(root, "src", "td-seam.js"));
        const rough = (p) => {
            let v = 0;
            for (let k = 1; k <= 5; k++) {
                const f = 600 * k;
                v += Math.sin(f * p[0] + 1.7 * k) * Math.cos(f * p[1] - 0.9 * k)
                    * Math.sin(f * p[2] + 2.3 * k) / k;
            }
            return v;
        };
        let worstErr = 0;
        let worstKept = 1;
        for (const tile of [{face: 0, level: 4, i: 7, j: 7}, {face: 1, level: 4, i: 15, j: 0}]) {
            const cells = 14;
            const full = Cube.tileBakeRect(tile, cells, 0);
            /* The bake is 2x the tile raster in production (3584 native, 1792
             * dumped), so test the resample at the ratio it really runs at. */
            const S = 384;
            const src = new Float32Array(S * S);
            for (let y = 0; y < S; y++) {
                for (let x = 0; x < S; x++) {
                    src[y * S + x] = rough(Cube.bakeDirection(
                        tile, full, (x + 0.5) / S * full.width, (y + 0.5) / S * full.height,
                    ));
                }
            }
            const T = 192;
            const got = Seam.bakeToTile(tile, full, src, S, S, T, T);
            const want = Seam.rasterizeTile(tile, T, T, rough);
            let err = 0;
            const bend = (a) => {
                let s = 0, n = 0;
                for (let y = 1; y < T - 1; y++) {
                    for (let x = 1; x < T - 1; x++) {
                        s += Math.abs(a[y * T + x] * 2 - a[y * T + x - 1] - a[y * T + x + 1]);
                        n++;
                    }
                }
                return s / n;
            };
            for (let i = 0; i < T * T; i++) err = Math.max(err, Math.abs(got[i] - want[i]));
            worstErr = Math.max(worstErr, err);
            worstKept = Math.min(worstKept, bend(got) / bend(want));
        }
        check("a bake resamples back onto its tile", worstErr < 0.06 && worstKept > 0.85,
            `worst error ${worstErr.toFixed(4)}, kept ${(worstKept * 100).toFixed(0)}% of the detail`);
    }

    /*
     * And the halo, which is the part that has to line up with a *neighbour*.
     * The bake plane broke the old arrangement: td-bake.py grew the raster on
     * a named side, which meant "past the tile's east edge" only while the
     * raster was the tile square. Now the exporter grows the rect and the job
     * cuts the halo back out through `rasterizeHalo`, so it lands in the
     * tile's own continuation. This walks the whole path — grow, bake,
     * resample, cut, then read it the way `blendFromNeighbor` does — and
     * checks the neighbour finds its own ground there.
     */
    {
        const Seam = require(join(root, "src", "td-seam.js"));
        const TdTile = require(join(root, "src", "td-tile.js"));
        const field = (p) => p[2];
        const tile = {face: 0, level: 2, i: 3, j: 2};
        const nb = Cube.neighborTile(tile, "east");
        const halo = TdTile.haloCellsFor(tile);
        check("the halo fixture is a fold with an east halo",
            nb && nb.face !== tile.face && halo.east === TdTile.SEAM_HALO_CELLS);

        const cells = 8;
        const rect = Cube.tileBakeRect(tile, cells, 0, halo);
        const S = 256;
        const src = new Float32Array(S * S);
        for (let y = 0; y < S; y++) {
            for (let x = 0; x < S; x++) {
                src[y * S + x] = field(Cube.bakeDirection(
                    tile, rect, (x + 0.5) / S * rect.width, (y + 0.5) / S * rect.height,
                ));
            }
        }
        const side = 128;
        const sx = S / rect.width;
        const sy = S / rect.height;
        const sample = (d) => {
            const px = Cube.bakePixel(tile, rect, d);
            return px ? Seam.sampleBicubic(src, S, S, px.x * sx, px.y * sy) : 0;
        };
        const haloPx = Math.round(side * halo.east / cells);
        const strip = Seam.rasterizeHalo(tile, "east", side, side, haloPx, sample);
        check("the cut halo is a strip of the tile raster's width",
            strip.width === haloPx && strip.height === side && haloPx > 0,
            `${strip.width}x${strip.height}`);

        const baked = {
            tile,
            width: side,
            height: side,
            elev: Seam.bakeToTile(tile, rect, src, S, S, side, side),
            halo: {east: strip},
        };
        let hits = 0;
        let worst = 0;
        for (let y = 0; y < side; y++) {
            const d = Cube.tileDirection(nb, 0.5 / side, (y + 0.5) / side);
            const ll = Cube.xyzToLonLat(d);
            const got = Seam.sampleSrc(baked, ll.lon, ll.lat);
            if (got == null || !Number.isFinite(got)) continue;
            hits++;
            worst = Math.max(worst, Math.abs(got - field(d)));
        }
        check("the neighbour reads its own ground out of the cut halo",
            hits > side * 0.9 && worst < 0.02,
            `hits ${hits}/${side}, err ${worst.toFixed(4)}`);

        /* The grown rect must actually contain what the cut asks for, or the
         * halo is bicubic-clamped rim rather than terrain. */
        let off = 0;
        for (let k = 0; k <= 32; k++) {
            for (const past of [0.001, 0.5, 0.999]) {
                const d = Cube.tileDirection(tile, 1 + past * halo.east / cells, (k + 0.5) / 33);
                const px = Cube.bakePixel(tile, rect, d);
                if (!px || px.x < 0 || px.y < 0 || px.x > rect.width || px.y > rect.height) off++;
            }
        }
        check("the grown rect covers the halo it will be cut for", off === 0,
            `${off} halo samples outside the bake`);
    }
}

function arc(p, q) {
    const a = Cube.lonLatToXyz(p.lon, p.lat);
    const b = Cube.lonLatToXyz(q.lon, q.lat);
    return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
}

/* 10. A drag selects the rectangle it spans, and refuses to span two faces. */
{
    const a = {face: 2, level: 4, i: 3, j: 9};
    const b = {face: 2, level: 4, i: 6, j: 7};
    const range = Cube.tileRange(a, b);
    check("tileRange spans the rectangle", range.length === 4 * 3, `${range.length} tiles`);
    check("tileRange refuses to cross a face",
        Cube.tileRange(a, {face: 3, level: 4, i: 0, j: 0}).length === 1);
}

/* 11. The picker uses one tile size: the bakeable level nearest 310 km. */
{
    const scaleKm = 23;
    const HALO = require(join(root, "src", "td-tile.js")).SEAM_HALO_CELLS;
    for (const [name, radiusKm, want] of [["thalos", 3186, 4], ["earth", 6371, 5]]) {
        const level = Cube.bestLevel(310, radiusKm, scaleKm, 6, 24, HALO);
        const cells = Cube.tileCells(level, radiusKm, scaleKm);
        const km = Cube.tileEdgeKm(level, radiusKm);
        const window = Cube.usableLevels(radiusKm, scaleKm, 6, 24, HALO);
        check(`${name} picker is L${want}`, level === want, `got L${level}`);
        check(`${name} picker stays inside the job cap`, cells >= 6 && cells <= 24, `${cells} cells`);
        check(`${name} picker is in the bakeable window`, window.includes(level), `${window}`);
        console.log(`        ${name}: L${level}, ${cells} cells, ${km.toFixed(0)} km`);
    }
    check("a 310 km target picks one level per radius",
        Cube.levelForKm(310, 3186) === 4 && Cube.levelForKm(310, 6371) === 5,
        `thalos L${Cube.levelForKm(310, 3186)}, earth L${Cube.levelForKm(310, 6371)}`);
}

/*
 * 12. The level the picker actually starts on has to be bakeable on that
 * planet. This is the one that bit: the default was hard-coded to 4, which is
 * 14 cells on Thalos and 27 on Earth, so every Earth bake was rejected. A
 * level is only ever right relative to a radius.
 */
{
    const TdTile = require(join(root, "src", "td-tile.js"));
    for (const [name, radiusKm] of [["thalos", 3186], ["earth", 6371], ["small", 1800], ["big", 12000]]) {
        const level = Cube.bestLevel(
            TdTile.TARGET_TILE_KM, radiusKm, TdTile.SCALE_KM,
            TdTile.MIN_CELLS, TdTile.MAX_CELLS, TdTile.SEAM_HALO_CELLS,
        );
        const cells = Cube.tileCells(level, radiusKm, TdTile.SCALE_KM);
        /* The rect a fold tile really submits, halo and all — that is what
         * submitJob measures against the cap, not the nominal cell count. */
        const worst = Cube.worstBakeCells(level, cells, TdTile.SEAM_HALO_CELLS);
        check(`${name} starts on a level the bake accepts`,
            cells >= TdTile.MIN_CELLS && worst <= TdTile.MAX_CELLS,
            `L${level} is ${cells} cells, worst rect ${worst}, cap is ${TdTile.MIN_CELLS}-${TdTile.MAX_CELLS}`);
        console.log(`        ${name}: L${level}, ${cells} cells (worst rect ${worst}),`
            + ` ${Cube.tileEdgeKm(level, radiusKm).toFixed(0)} km`);
    }
    /* The bakeable window bestLevel chooses from has to stay in cap too. */
    let bad = 0;
    for (let radiusKm = 1000; radiusKm <= 20000; radiusKm += 250) {
        for (const level of Cube.usableLevels(
            radiusKm, TdTile.SCALE_KM, TdTile.MIN_CELLS, TdTile.MAX_CELLS, TdTile.SEAM_HALO_CELLS,
        )) {
            const cells = Cube.tileCells(level, radiusKm, TdTile.SCALE_KM);
            const worst = Cube.worstBakeCells(level, cells, TdTile.SEAM_HALO_CELLS);
            if (cells < TdTile.MIN_CELLS || worst > TdTile.MAX_CELLS) bad++;
        }
    }
    check("every bakeable level stays in cap, at every radius", bad === 0, `${bad} out of range`);
}

/*
 * 13. Neighbour pad. tiff-export fills a 64-cell window by repeating the
 * rim, which is why adjacent bakes seamed. The pad has to be real
 * neighbouring ground, and two tiles that share an edge have to agree
 * where that ground sits in WorldPipeline coordinates.
 */
{
    const TdTile = require(join(root, "src", "td-tile.js"));
    const DEG = Math.PI / 180;
    const cells = 8;
    const pad = TdTile.CONTEXT_PAD;
    const left = {face: 0, level: 3, i: 3, j: 4};
    const right = {face: 0, level: 3, i: 4, j: 4};
    const north = {face: 0, level: 3, i: 3, j: 5};

    const mid = Cube.tileLonLat(left, 0.3, 0.7);
    const a = Cube.tileProjector(left, cells, cells)(mid.lon * DEG, mid.lat * DEG);
    const b = Cube.paddedProjector(left, cells, cells, 0, 0)(mid.lon * DEG, mid.lat * DEG);
    check("pad 0 is the unpadded projector",
        a && b && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9);

    const e = Cube.tileExtent(left);
    const east = Cube.xyzToLonLat(Cube.faceDirection(0, e.a1, (e.b0 + e.b1) / 2));
    const lp = Cube.paddedProjector(left, cells, cells, pad, pad)(east.lon * DEG, east.lat * DEG);
    const rp = Cube.paddedProjector(right, cells, cells, pad, pad)(east.lon * DEG, east.lat * DEG);
    check("shared east edge is the interior's right column on the left tile",
        lp && Math.abs(lp.x - (pad + cells)) < 1e-6, lp ? `x=${lp.x}` : "null");
    check("shared east edge is the interior's left column on the right tile",
        rp && Math.abs(rp.x - pad) < 1e-6, rp ? `x=${rp.x}` : "null");

    const rightMid = Cube.tileLonLat(right, 0.5, 0.5);
    const inPad = Cube.paddedProjector(left, cells, cells, pad, pad)(
        rightMid.lon * DEG, rightMid.lat * DEG,
    );
    check("left tile's pad contains the right tile's centre",
        inPad && Math.abs(inPad.x - (pad + 1.5 * cells)) < 0.05,
        inPad ? `x=${inPad.x.toFixed(3)}` : "null");

    /*
     * The bake asks in bake-plane cells now, not in the tile square's, so
     * this is the property that has to hold there: two tiles that touch must
     * name overlapping cells of one lattice, or they stop sharing noise and
     * every same-face edge becomes a join. (contextOrigin held it for the old
     * square. tileBakeRect holds it for the plane the model actually sees.)
     */
    const rL = Cube.tileBakeRect(left, cells, TdTile.CONTEXT_PAD);
    const rR = Cube.tileBakeRect(right, cells, TdTile.CONTEXT_PAD);
    const rN = Cube.tileBakeRect(north, cells, TdTile.CONTEXT_PAD);
    const overlaps = (a, b) => a.originI < b.originI + b.width && b.originI < a.originI + a.width
        && a.originJ < b.originJ + b.height && b.originJ < a.originJ + a.height;
    check("neighbouring bake rects are cells of one lattice",
        rL.step === rR.step && rL.step === rN.step
        && Number.isInteger(rL.originI) && Number.isInteger(rR.originJ));
    check("an east neighbour's rect overlaps this one's pad", overlaps(rL, rR),
        `${rL.originI}+${rL.width} vs ${rR.originI}+${rR.width}`);
    check("a north neighbour's rect overlaps this one's pad", overlaps(rL, rN));
    check("CONTEXT_PAD is the U-Net window tiff-export uses",
        TdTile.CONTEXT_PAD === 64);
}

/*
 * 14. Face adjacency. A cube edge is a 90° fold in WorldPipeline space, so
 * the neighbour is another face's (i, j), sometimes rotated. Polar joins
 * are not opposite names. Every border tile must point at someone, and
 * that someone must point back.
 */
{
    let missing = 0;
    let oneWay = 0;
    let sameFace = 0;
    let pairs = 0;
    for (let level = 0; level <= 4; level++) {
        const n = 1 << level;
        for (let face = 0; face < 6; face++) {
            for (let j = 0; j < n; j++) {
                for (let i = 0; i < n; i++) {
                    const tile = {face, level, i, j};
                    for (const edge of Cube.faceEdges(tile)) {
                        const nb = Cube.neighborTile(tile, edge);
                        if (!nb) { missing++; continue; }
                        if (nb.face === tile.face) { sameFace++; continue; }
                        pairs++;
                        if (Cube.sharedEdge(nb, tile) == null) oneWay++;
                    }
                }
            }
        }
    }
    check("every face-edge tile has a neighbour on another face",
        missing === 0 && sameFace === 0,
        `${missing} missing, ${sameFace} stayed on face`);
    check("face-edge neighbours point back", oneWay === 0, `${oneWay} of ${pairs} one-way`);

    const eq = Cube.neighborTile({face: 0, level: 2, i: 3, j: 1}, "east");
    check("equatorial east keeps j and lands on +y",
        eq && eq.face === 1 && eq.i === 0 && eq.j === 1,
        eq ? Cube.tileName(eq) : "null");
    const polar = Cube.neighborTile({face: 1, level: 2, i: 2, j: 3}, "north");
    check("face 1 north rotates onto +z east",
        polar && polar.face === 4 && polar.i === 3,
        polar ? Cube.tileName(polar) : "null");
    check("a face-interior east step stays on the face",
        Cube.neighborTile({face: 0, level: 2, i: 1, j: 1}, "east").face === 0);
}

/*
 * 15. Face-edge stitch, against a spherical field — no GPU. If the warp
 * from one face's continuation into the other's UV is right, resampling
 * a halo of p.z (smooth on the sphere) lands on the neighbour's own
 * samples. Independent noise then has to follow that halo at the fold,
 * or the join is still a cut.
 */
{
    const Seam = require(join(root, "src", "td-seam.js"));
    const TdTile = require(join(root, "src", "td-tile.js"));
    const field = (p) => p[2];
    const W = 48;
    const haloPx = 12;
    const aTile = {face: 0, level: 2, i: 3, j: 2};
    const bTile = Cube.neighborTile(aTile, "east");
    check("the stitch fixture is a face fold", bTile && bTile.face === 1, Cube.tileName(bTile || {}));

    const src = {
        tile: aTile,
        width: W,
        height: W,
        elev: Seam.rasterizeTile(aTile, W, W, field),
        halo: {east: Seam.rasterizeHalo(aTile, "east", W, W, haloPx, field)},
    };
    let worst = 0;
    let hits = 0;
    for (let y = 0; y < W; y++) {
        const d = Cube.tileDirection(bTile, 0.5 / W, (y + 0.5) / W);
        const ll = Cube.xyzToLonLat(d);
        const got = Seam.sampleSrc(src, ll.lon, ll.lat);
        const want = field(d);
        if (got == null || !Number.isFinite(got)) continue;
        hits++;
        worst = Math.max(worst, Math.abs(got - want));
    }
    check("east halo resamples onto +y west at the field's own values",
        hits > W * 0.8 && worst < 0.02,
        `hits ${hits}/${W}, err ${worst.toFixed(4)}`);

    const dest = {
        tile: bTile,
        width: W,
        height: W,
        elev: Seam.rasterizeTile(bTile, W, W, (p) => field(p) + 0.4),
    };
    const moved = Seam.blendFromNeighbor(dest, src);
    let edgeErr = 0;
    for (let y = 0; y < W; y++) {
        edgeErr = Math.max(edgeErr, Math.abs(dest.elev[y * W] - field(
            Cube.tileDirection(bTile, 0.5 / W, (y + 0.5) / W),
        )));
    }
    check("a biased neighbour follows the halo at the fold",
        moved > 0 && edgeErr < 0.05,
        `moved ${moved}, edge err ${edgeErr.toFixed(4)}`);

    const cTile = {face: 1, level: 2, i: 2, j: 3};
    const dTile = Cube.neighborTile(cTile, "north");
    const polarSrc = {
        tile: cTile,
        width: W,
        height: W,
        elev: Seam.rasterizeTile(cTile, W, W, field),
        halo: {north: Seam.rasterizeHalo(cTile, "north", W, W, haloPx, field)},
    };
    const polarDest = {
        tile: dTile,
        width: W,
        height: W,
        elev: Seam.rasterizeTile(dTile, W, W, (p) => field(p) + 0.4),
    };
    Seam.blendFromNeighbor(polarDest, polarSrc);
    const pEdge = Cube.sharedEdge(dTile, cTile);
    let polarErr = 0;
    for (let k = 0; k < W; k++) {
        const x = pEdge === "east" ? W - 1 : pEdge === "west" ? 0 : k;
        const y = pEdge === "south" ? W - 1 : pEdge === "north" ? 0 : k;
        polarErr = Math.max(polarErr, Math.abs(polarDest.elev[y * W + x] - field(
            Cube.tileDirection(dTile, (x + 0.5) / W, (y + 0.5) / W),
        )));
    }
    check("a rotated polar fold stitches the same way",
        pEdge && polarErr < 0.05,
        `edge ${pEdge}, err ${polarErr.toFixed(4)}`);
    /*
     * A smooth field says nothing about the interpolator — bilinear is exact
     * on it. Terrain is not smooth, and the stitched side of a real fold came
     * out visibly softer than the side it met. So resample a field with real
     * energy near the sampling limit and measure how much of its roughness
     * survives the turn: bicubic keeps 89% of this one, bilinear 77%.
     */
    {
        const rough = (p) => {
            let v = 0;
            for (let k = 1; k <= 5; k++) {
                const f = 600 * k;
                v += Math.sin(f * p[0] + 1.7 * k) * Math.cos(f * p[1] - 0.9 * k)
                    * Math.sin(f * p[2] + 2.3 * k) / k;
            }
            return v;
        };
        const rTile = {face: 0, level: 2, i: 3, j: 2};
        const nTile = Cube.neighborTile(rTile, "east");
        const RW = 256;
        const halo = Seam.rasterizeHalo(rTile, "east", RW, RW, 24, rough);
        const line = [];
        const got = [];
        for (let y = 0; y < RW; y++) {
            const d = Cube.tileDirection(nTile, 0.5 / RW, (y + 0.5) / RW);
            const ll = Cube.xyzToLonLat(d);
            line.push(rough(d));
            got.push(Seam.sampleSrc({
                tile: rTile, width: RW, height: RW,
                elev: Seam.rasterizeTile(rTile, RW, RW, rough),
                halo: {east: halo},
            }, ll.lon, ll.lat));
        }
        const bend = (a) => {
            let s = 0;
            for (let i = 1; i < a.length - 1; i++) s += Math.abs(a[i] * 2 - a[i - 1] - a[i + 1]);
            return s / (a.length - 2);
        };
        const kept = bend(got) / bend(line);
        check("the fold resample keeps a rough field's detail",
            kept > 0.85, `kept ${(kept * 100).toFixed(0)}% of the along-seam roughness`);
    }

    check("SEAM_HALO_CELLS is one coarse cell of overlap",
        TdTile.SEAM_HALO_CELLS === 1);
    const interiorHalo = TdTile.haloCellsFor({face: 0, level: 3, i: 3, j: 3});
    const foldHalo = TdTile.haloCellsFor({face: 0, level: 3, i: 7, j: 4});
    check("an interior tile generates no face-edge halo",
        interiorHalo.east === 0 && interiorHalo.west === 0
        && interiorHalo.north === 0 && interiorHalo.south === 0);
    check("a +x east fold generates an east halo only",
        foldHalo.east === 1 && foldHalo.west === 0 && foldHalo.north === 0 && foldHalo.south === 0);
}

console.log(failures.length ? `\n${failures.length} failed` : "\nall good");
process.exit(failures.length ? 1 : 0);
