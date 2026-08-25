/*
 * The body itself.
 *
 * Everything else in this repo is a model parameter — a number chosen because
 * it makes the simulation behave. These six are different: they are properties
 * of the planet being generated, the things you would read off its entry in a
 * catalogue. They belong to no one model, because all three read them.
 *
 * The whole model is calibrated at Earth, so Earth's values are the defaults
 * and every derivation below is written as a ratio against them. That is not a
 * convenience: it means a default run is bit-identical to the run before these
 * existed, and any drift is a real change rather than a rounding difference
 * introduced by rewriting a constant as a formula.
 *
 * Browser-free, like the models it configures.
 */
'use strict';

/* Earth, frozen.
 *
 * Every derivation below is a ratio against this, and it must NOT be the
 * mutable DEFAULTS: loading a project assigns into DEFAULTS, so using that as
 * the reference makes the reference move with the value and every ratio
 * collapse to 1. That failed silently — the command line passes overrides and
 * kept working, while the app and the contact sheet quietly stopped scaling
 * anything at all. Hence a separate frozen constant.
 */
const EARTH = Object.freeze({
    radiusKm: 6371,
    gravityG: 1,
    rotationHours: 24,
    axialTiltDeg: 23.44,
    ageGyr: 4.54,
});


const DEFAULTS = {
    /* Earth. Was hard-coded as EARTH_RADIUS_KM in detail.js and erosion.js,
     * which is why every km-denominated parameter silently meant something
     * else on any other planet. */
    radiusKm: 6371,

    /* Surface gravity. Does *not* enter isostasy: how high crust floats is
     * set by the crust/mantle density ratio (1 - pc/pm ~ 0.152, the 145 m
     * per km in tectonics.js), which has no g in it. What g does set is the
     * ceiling — how much relief crust can hold up before it flows. That is
     * why Olympus Mons is 22 km tall at 0.38 g. */
    gravityG: 1,

    /* Not a parameter. The solver still accepts a number if a test asks.
     * Null means do not solve: sea level stays where `seaLevelThicknessKm`
     * puts it and land comes out where it comes out. */
    landFraction: null,

    /* Length of the day. Sets how wide the Hadley cells are, and so where
     * the dry belt and the storm track sit. */
    rotationHours: 24,

    /* Obliquity. Sets how far the rain belts swing with the seasons. */
    axialTiltDeg: 23.44,

    /* Age. The weakest of these — see `ageRelief` below. */
    ageGyr: 4.54,
};


/* --------------------------------------------------------------- derivations
 *
 * Each is a pure function of the body, returning a multiplier that is exactly
 * 1 at Earth. Kept here rather than inside the models so the physics is in one
 * readable place and can be tested without running a simulation.
 */

/* Planet size, as a fraction of Earth's. */
function radiusScale(opts) {
    return opts.radiusKm / EARTH.radiusKm;
}


/* Mean spacing between cells of an n-region mesh, in km. The reason a mesh
 * parameter needs the body: at n=10000 a cell is 226 km on Earth and 113 km
 * on a half-radius planet, so anything expressed per cell means twice the
 * rate per km there. */
function cellSpacingKm(numRegions, opts) {
    return 2 * opts.radiusKm * Math.sqrt(Math.PI / numRegions);
}


/* Inverse: how many mesh regions give this mean spacing. Shape uses it so
 * the sketch grain stays 23 km (or whatever the terrain model wants) on
 * any radius. */
function regionsForSpacingKm(spacingKm, opts) {
    if (!(spacingKm > 0) || !(opts && opts.radiusKm > 0)) return 1;
    return Math.max(1, Math.round(Math.PI * (2 * opts.radiusKm / spacingKm) ** 2));
}


/* Convert a rate written per mesh cell into the same rate per cell on this
 * planet's mesh, so it stays constant per km travelled rather than per step
 * of the solver. Used by the climate model's rainout and recycling. */
function perCellRate(rate, numRegions, opts) {
    const spacing = cellSpacingKm(numRegions, opts);
    const reference = cellSpacingKm(numRegions, EARTH);
    if (!(spacing > 0) || !(reference > 0)) return rate;
    /* A rate is a share removed per cell, so it compounds: holding the
     * per-km rate fixed means 1 - (1 - rate) ^ (spacing / reference). */
    return 1 - Math.pow(1 - Math.min(1, Math.max(0, rate)), spacing / reference);
}


/* How much relief the crust can hold up, relative to Earth. Lower gravity
 * means taller mountains for the same crustal strength. */
function reliefScale(opts) {
    return 1 / opts.gravityG;
}


/* Where the Hadley cells end, relative to Earth.
 *
 * Held-Hou gives the cell's poleward edge as phi ~ (gH / omega^2 a^2)^(1/4),
 * so at fixed depth and radius phi scales as omega^(-1/2) — and omega is
 * inversely proportional to the length of the day. A shorter day means
 * narrower cells, so the subtropical dry belt and the storm track both sit
 * closer to the equator. Thalos's 21.3 hour day puts them at 94% of Earth's
 * latitudes.
 */
function hadleyScale(opts) {
    return Math.sqrt(opts.rotationHours / EARTH.rotationHours);
}


/* How far the rain belts swing with the seasons, relative to Earth. The
 * ITCZ follows the subsolar point, which reaches the tropic latitude, so
 * this is simply the obliquity ratio. */
function seasonScale(opts) {
    return opts.axialTiltDeg / EARTH.axialTiltDeg;
}


/* Relief carried by an old planet, relative to Earth.
 *
 * This is a modelling choice, not a derived law, and it is the shakiest
 * number in this file. The argument is that an older body has a colder,
 * thicker lithosphere and less vigorous convection, so a collision of the
 * same size builds a lower belt and its root relaxes sooner — which is what
 * "geologically old" is supposed to look like: rounded massifs rather than a
 * Himalaya. The exponent is chosen so the effect is visible without being
 * decisive: 5.5 Gyr reads about 10% lower than Earth, not half.
 *
 * It deliberately does not touch erosion rate. How fast a mountain wears
 * down is set by climate and gravity, not by how long the planet has
 * existed, and folding age into erosion would be the wrong mechanism
 * wearing the right-looking result.
 */
function ageRelief(opts) {
    return Math.pow(EARTH.ageGyr / opts.ageGyr, 0.5);
}


/* Apply the derivations to a merged option set.
 *
 * Called once where each model builds its options, so the mapping from body
 * to model parameters lives in one readable place instead of being smeared
 * across the use sites. Each model gets whichever of these keys it has; the
 * rest are absent and skipped.
 *
 * Every factor is exactly 1 at Earth's defaults, so a default run multiplies
 * by 1.0 and is bit-identical to the run before this function existed.
 *
 * One rule worth stating: a derivation is applied *after* a project sets the
 * parameter, so pinning `orogenyReliefM` gives its value at Earth gravity
 * and this still scales it. Pin `gravityG` to change the scaling. Pinning
 * both ends of a derivation is the case we deliberately do not solve.
 */
function derive(opts, numRegions) {
    /* How much relief the crust can hold up: lower gravity allows more, an
     * older and colder lithosphere builds less. */
    const relief = reliefScale(opts) * ageRelief(opts);
    if (opts.orogenyReliefM != null) opts.orogenyReliefM *= relief;
    if (opts.arcUpliftM != null) opts.arcUpliftM *= relief;
    if (opts.arcCrestM != null) opts.arcCrestM *= relief;
    if (opts.hotspotUpliftM != null) opts.hotspotUpliftM *= relief;
    /* `crustMaxKm` is deliberately not scaled. It is a thickness rather than
     * a relief, and isostasy already turns thickness into height, so scaling
     * both would count gravity twice. */

    /* How many plates and continents a body of this size carries.
     *
     * Plate size is set by the convection cells beneath, and a cell is a
     * length — roughly the depth of the mantle — rather than a fixed share of
     * the surface. Holding the *count* fixed would give a half-size planet
     * plates half as wide as Earth's, which is the one thing we know is
     * wrong; holding the *size* fixed would scale the count as area, leaving
     * a small planet with four plates and nothing to look at. Mantle depth
     * itself scales roughly with radius, so the truth sits between: count
     * proportional to radius. Thalos gets ten plates and three continents.
     */
    const size = radiusScale(opts);
    if (opts.plates != null) opts.plates = Math.max(2, Math.round(opts.plates * size));
    if (opts.cratons != null) opts.cratons = Math.max(1, Math.round(opts.cratons * size));

    /* Where the circulation puts its belts. */
    const hadley = hadleyScale(opts);
    if (opts.itczWidth != null) opts.itczWidth *= hadley;
    if (opts.subsidenceCentre != null) opts.subsidenceCentre *= hadley;
    if (opts.subsidenceWidth != null) opts.subsidenceWidth *= hadley;
    if (opts.stormCentre != null) opts.stormCentre *= hadley;
    if (opts.stormWidth != null) opts.stormWidth *= hadley;

    /* How far they swing with the seasons. */
    const season = seasonScale(opts);
    if (opts.seasonShift != null) opts.seasonShift *= season;
    if (opts.windSeasonShift != null) opts.windSeasonShift *= season;

    /* Rates written per mesh cell hold their meaning per km. The caller has
     * to hand in the mesh size: it is a property of the mesh, not an option,
     * and keying off an `opts.numRegions` that is never set would leave this
     * silently inert. Only the climate model has these. */
    if (numRegions > 0) {
        if (opts.rainEfficiency != null) opts.rainEfficiency = perCellRate(opts.rainEfficiency, numRegions, opts);
        if (opts.recycling != null) opts.recycling = perCellRate(opts.recycling, numRegions, opts);
    }

    return opts;
}


module.exports = {
    EARTH,
    DEFAULTS,
    derive,
    radiusScale,
    cellSpacingKm,
    regionsForSpacingKm,
    perCellRate,
    reliefScale,
    hadleyScale,
    seasonScale,
    ageRelief,
};
