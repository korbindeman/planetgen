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

/* 11. The levels offered are the ones that make a sane bake. */
{
    const scaleKm = 23;
    for (const [name, radiusKm] of [["thalos", 3186], ["earth", 6371]]) {
        const levels = Cube.usableLevels(radiusKm, scaleKm, 6, 24);
        const detail = levels
            .map((l) => `L${l} ${Cube.tileEdgeKm(l, radiusKm).toFixed(0)}km ${Cube.tileCells(l, radiusKm, scaleKm)}cells`)
            .join(", ");
        check(`${name} offers usable levels`, levels.length >= 2, detail);
        console.log(`        ${detail}`);
        const cells = levels.map((l) => Cube.tileCells(l, radiusKm, scaleKm));
        check(`${name} levels stay inside the job cap`, cells.every((c) => c >= 6 && c <= 24));
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
            TdTile.TARGET_TILE_KM, radiusKm, TdTile.SCALE_KM, TdTile.MIN_CELLS, TdTile.MAX_CELLS,
        );
        const cells = Cube.tileCells(level, radiusKm, TdTile.SCALE_KM);
        check(`${name} starts on a level the bake accepts`,
            cells >= TdTile.MIN_CELLS && cells <= TdTile.MAX_CELLS,
            `L${level} is ${cells} cells, cap is ${TdTile.MIN_CELLS}-${TdTile.MAX_CELLS}`);
        console.log(`        ${name}: L${level}, ${cells} cells, ${Cube.tileEdgeKm(level, radiusKm).toFixed(0)} km`);
    }
    /* And every level the stepper offers, not just the default. */
    let bad = 0;
    for (let radiusKm = 1000; radiusKm <= 20000; radiusKm += 250) {
        for (const level of Cube.usableLevels(radiusKm, TdTile.SCALE_KM, TdTile.MIN_CELLS, TdTile.MAX_CELLS)) {
            const cells = Cube.tileCells(level, radiusKm, TdTile.SCALE_KM);
            if (cells < TdTile.MIN_CELLS || cells > TdTile.MAX_CELLS) bad++;
        }
    }
    check("every offered level is bakeable, at every radius", bad === 0, `${bad} out of range`);
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

    const oL = TdTile.contextOrigin(left, cells);
    const oR = TdTile.contextOrigin(right, cells);
    const oN = TdTile.contextOrigin(north, cells);
    check("east neighbour originJ steps by the interior width",
        oR.originJ === oL.originJ + cells, `${oR.originJ} vs ${oL.originJ + cells}`);
    check("east neighbour shares originI", oR.originI === oL.originI);
    check("north neighbour originI steps toward row 0",
        oN.originI === oL.originI - cells, `${oN.originI} vs ${oL.originI - cells}`);
    check("CONTEXT_PAD is the U-Net window tiff-export uses",
        TdTile.CONTEXT_PAD === 64);
}

console.log(failures.length ? `\n${failures.length} failed` : "\nall good");
process.exit(failures.length ? 1 : 0);
