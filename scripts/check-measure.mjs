#!/usr/bin/env bun
/**
 * Check great-circle measure math.
 *
 *   bun run check:measure
 *
 * The path has to be a geodesic on this planet's radius, not a chord
 * across the map. That is the one thing a screen tool can get wrong
 * silently, so it is pinned here. Browser-free, like check:tiles.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const Measure = require(join(root, "src", "measure.js"));
const World = require(join(root, "src", "world.js"));

const EARTH_R = World.EARTH.radiusKm;
const THALOS_R = 3186;
const failures = [];
const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else { console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
};

const near = (a, b, eps) => Math.abs(a - b) <= eps;

console.log("measure");

{
    const a = {lon: 0, lat: 0};
    const b = {lon: 90, lat: 0};
    const km = Measure.distanceKm(a, b, EARTH_R);
    const expect = EARTH_R * Math.PI / 2;
    check("Earth quarter-equator is πR/2", near(km, expect, 1e-6), `${km} vs ${expect}`);
}

{
    const a = {lon: 0, lat: 0};
    const b = {lon: 90, lat: 0};
    const km = Measure.distanceKm(a, b, THALOS_R);
    const expect = THALOS_R * Math.PI / 2;
    check("Thalos uses its own radius", near(km, expect, 1e-6), `${km} vs ${expect}`);
}

{
    const a = {lon: 0, lat: 0};
    const b = {lon: 180, lat: 0};
    const km = Measure.distanceKm(a, b, EARTH_R);
    check("antipodes are πR", near(km, EARTH_R * Math.PI, 1e-6), `${km}`);
}

{
    const a = {lon: 10, lat: 20};
    check("identity is zero", Measure.distanceKm(a, a, EARTH_R) === 0);
}

{
    const a = {lon: -170, lat: 0};
    const b = {lon: 170, lat: 0};
    const km = Measure.distanceKm(a, b, EARTH_R);
    const expect = EARTH_R * (20 * Math.PI / 180);
    check("antimeridian wrap takes the short arc", near(km, expect, 1e-6), `${km} vs ${expect}`);
}

{
    const a = {lon: 0, lat: 0};
    const b = {lon: 90, lat: 0};
    const mid = Measure.interpolate(a, b, 0.5);
    check("equator slerp midpoint is (45, 0)",
        near(mid.lon, 45, 1e-6) && near(mid.lat, 0, 1e-6),
        `${mid.lon}, ${mid.lat}`);
}

{
    const a = {lon: 0, lat: 0};
    const b = {lon: 0, lat: 90};
    const mid = Measure.interpolate(a, b, 0.5);
    check("meridian slerp midpoint is (0, 45)",
        near(mid.lon, 0, 1e-6) && near(mid.lat, 45, 1e-6),
        `${mid.lon}, ${mid.lat}`);
}

{
    const a = {lon: 12, lat: -4};
    const b = {lon: -80, lat: 41};
    const ab = Measure.distanceKm(a, b, EARTH_R);
    const ba = Measure.distanceKm(b, a, EARTH_R);
    check("distance is symmetric", near(ab, ba, 1e-9), `${ab} vs ${ba}`);
}

{
    Measure.clear();
    Measure.addPoint({lon: 0, lat: 0});
    Measure.addPoint({lon: 90, lat: 0});
    Measure.addPoint({lon: 90, lat: 90});
    const legs = Measure.pathLegs(EARTH_R);
    const total = legs.reduce((s, leg) => s + leg.km, 0);
    check("two 90° legs sum to πR/2 + πR/2",
        legs.length === 2 && near(total, EARTH_R * Math.PI, 1e-6),
        `${total}`);
    Measure.clear();
}

{
    check("format 400 m", Measure.formatDistance(0.4) === "400 m");
    check("format 4.2 km", Measure.formatDistance(4.2) === "4.2 km");
    check("format 1842 km", Measure.formatDistance(1842.4) === "1842 km");
    check("format Δ +640 m", Measure.formatDelta(100, 740) === "+640 m");
    check("format Δ -2.1 km", Measure.formatDelta(2100, 0) === "-2.1 km");
}

{
    Measure.setActive(true);
    Measure.addPoint({lon: 0, lat: 0});
    const idle = Measure.readout(EARTH_R);
    check("one point asks for an end", idle.hint === "Click an end." && idle.value === "");
    Measure.addPoint({lon: 90, lat: 0});
    const done = Measure.readout(EARTH_R);
    check("two points show kilometres", done.value === "10008 km");
    Measure.clear();
    Measure.setActive(false);
}

if (failures.length) {
    console.log(`\n${failures.length} failed`);
    process.exit(1);
}
console.log("\nall ok");
