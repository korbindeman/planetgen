#!/usr/bin/env bun
/**
 * Check authored sculpt math.
 *
 *   bun run check:sculpt
 *
 * Coast has to grow or eat the shore without peaks or pits.
 * Relief has to stay in the neighbourhood. Undo has to put the
 * field back. Browser-free, like check:measure.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Sculpt = require(join(root, "src", "sculpt.js"));
const SphereMesh = require(join(root, "src", "sphere-mesh.js"));
const Tectonics = require(join(root, "src", "tectonics.js"));

const failures = [];
const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
        console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
        failures.push(name);
    }
};

const near = (a, b, eps) => Math.abs(a - b) <= eps;

console.log("sculpt");

check("falloff is 1 at the centre", Sculpt.falloff(0) === 1);
check("falloff is 0 at the edge", Sculpt.falloff(1) === 0);
check("falloff is 0 outside", Sculpt.falloff(1.2) === 0);
check("falloff is between at mid", Sculpt.falloff(0.5) > 0 && Sculpt.falloff(0.5) < 1);
check("tools are Coast and Relief", Sculpt.TOOLS.join(" ") === "coast relief");

{
    const a = {lon: 0, lat: 0};
    const b = {lon: 10, lat: 0};
    const ang = Sculpt.screenToRadiusRad(a, b, 0.01);
    check("screenToRadiusRad uses the two picks", ang > 0.1 && ang < 0.3, `${ang}`);
}

{
    const {mesh, r_xyz} = SphereMesh.makeSphere(240, 0, () => 0.5);
    const xyz = Float32Array.from(r_xyz);
    const n = mesh.numRegions;
    const meters = new Float32Array(n);
    const elevation = new Float32Array(n);
    for (let r = 0; r < n; r++) {
        const x = xyz[3 * r];
        meters[r] = x > 0.04 ? 220 : x < -0.04 ? -1800 : x > 0 ? 40 : -40;
        elevation[r] = Tectonics.metersToElevation(meters[r]);
    }
    const map = {r_xyz: xyz, r_meters: meters, r_elevation: elevation};
    const radiusRad = Sculpt.affectRadiusRad(mesh, 0.28);
    const disk = Sculpt.gatherDisk(mesh, xyz, [1, 0, 0], radiusRad, 0);
    check("gatherDisk finds a neighbourhood", disk.cells.length >= 3, `${disk.cells.length}`);

    const coastCenter = [0.08, 0.99, 0];
    const coastLen = Math.hypot(...coastCenter) || 1;
    const coastXyz = coastCenter.map((v) => v / coastLen);
    const beforeCoast = Float32Array.from(meters);
    const coastDisk = Sculpt.gatherDisk(mesh, xyz, coastXyz, radiusRad, 0);
    let waterBefore = 0;
    for (const r of coastDisk.cells) if (beforeCoast[r] < 0) waterBefore++;
    Sculpt.coastDab(mesh, map, coastXyz, radiusRad, 0.85, false, null, {
        snap: new Map(),
        painted: new Map(),
    });
    let grew = 0;
    let coastPeak = 0;
    let waterLeft = 0;
    for (const r of coastDisk.cells) {
        if (beforeCoast[r] < 0 && meters[r] >= 0) grew++;
        if (meters[r] > coastPeak) coastPeak = meters[r];
        if (meters[r] < 0) waterLeft++;
    }
    check("coast add grows some water into land", grew >= 1, `${grew}`);
    check("coast add does not fill the whole disk", waterLeft > 0 || waterBefore === 0, `${waterLeft}/${waterBefore}`);
    check("coast add stays a coastal plain", coastPeak < 400, `${coastPeak}`);

    for (let r = 0; r < n; r++) {
        meters[r] = beforeCoast[r];
        elevation[r] = Tectonics.metersToElevation(meters[r]);
    }
    Sculpt.coastDab(mesh, map, coastXyz, radiusRad, 0.85, true, null, {
        snap: new Map(),
        painted: new Map(),
    });
    let ate = 0;
    let newWaterMin = 0;
    for (const r of coastDisk.cells) {
        if (beforeCoast[r] >= 0 && meters[r] < 0) {
            ate++;
            if (meters[r] < newWaterMin) newWaterMin = meters[r];
        }
    }
    check("coast subtract eats some land", ate >= 1, `${ate}`);
    check("coast subtract stays a shelf", newWaterMin > -500, `${newWaterMin}`);

    for (let r = 0; r < n; r++) {
        meters[r] = beforeCoast[r];
        elevation[r] = Tectonics.metersToElevation(meters[r]);
    }
    const hill = [1, 0, 0];
    for (let r = 0; r < n; r++) {
        const dx = xyz[3 * r] - 1;
        const dy = xyz[3 * r + 1];
        const dz = xyz[3 * r + 2];
        if (dx * dx + dy * dy + dz * dz < 0.04) meters[r] = 780;
        elevation[r] = Tectonics.metersToElevation(meters[r]);
    }
    const beforeRelief = Float32Array.from(meters);
    Sculpt.reliefDab(mesh, map, hill, radiusRad, 0.8, false, null, {
        snap: new Map(),
        painted: new Map(),
    });
    let lifted = 0;
    let reliefPeak = -1e9;
    for (const r of disk.cells) {
        if (meters[r] > beforeRelief[r] + 2) lifted++;
        if (meters[r] > reliefPeak) reliefPeak = meters[r];
    }
    check("relief high lifts some land", lifted >= 1, `${lifted}`);
    check("relief high stays in the neighbourhood", reliefPeak < 1600, `${reliefPeak}`);

    for (let r = 0; r < n; r++) {
        meters[r] = beforeRelief[r];
        elevation[r] = Tectonics.metersToElevation(meters[r]);
    }
    const ocean = [-1, 0, 0];
    const oceanDisk = Sculpt.gatherDisk(mesh, xyz, ocean, radiusRad, 0);
    Sculpt.reliefDab(mesh, map, ocean, radiusRad, 0.8, true, null, {
        snap: new Map(),
        painted: new Map(),
    });
    let stillWater = true;
    let oceanPit = 0;
    for (const r of oceanDisk.cells) {
        if (meters[r] >= 0) stillWater = false;
        if (meters[r] < oceanPit) oceanPit = meters[r];
    }
    check("relief low on ocean stays ocean", stillWater);
    check("relief low does not punch an abyss", oceanPit > -3500, `${oceanPit}`);

    for (let r = 0; r < n; r++) {
        meters[r] = beforeCoast[r];
        elevation[r] = Tectonics.metersToElevation(meters[r]);
    }
    Sculpt.clearHistory();
    Sculpt.setTool("coast");
    Sculpt.setStrength(0.85);
    const at = {xyz: coastXyz, lon: 4, lat: 80, radiusRad};
    const beforeStroke = Float32Array.from(map.r_meters);
    Sculpt.beginStroke(mesh, map, at, null);
    Sculpt.moveStroke({xyz: [0.2, 0.98, 0], lon: 12, lat: 78, radiusRad});
    Sculpt.endStroke();
    check("a coast stroke can be undone", Sculpt.canUndo());
    Sculpt.undo(map);
    let restored = true;
    for (let r = 0; r < n; r++) {
        if (!near(map.r_meters[r], beforeStroke[r], 1e-2)) restored = false;
    }
    check("undo restores metres", restored);

    Sculpt.setTool(null);
    Sculpt.clearHistory();
}

if (failures.length) {
    console.log(`\n${failures.length} failed`);
    process.exit(1);
}
console.log("\nok");
