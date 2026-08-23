/*
 * Earth.
 *
 * A preset is a named set of pins: every parameter it names is decided, and
 * everything it leaves out is free. Earth pins little because the model's
 * DEFAULTS are already calibrated against Earth — what is here is the
 * handful of places present-day Earth differs from a planet that has just
 * run 200 Myr of history, plus the two knobs the fixture's one-shot paint
 * needs and the ordinary simulation does not have.
 *
 * The geography itself is not in this file and is not a parameter: Bird
 * 2003 outlines and NNR-MORVEL56 poles are authored in `earth-fixture.js`.
 * This is the parameter half, so Earth loads the same way Thalos will.
 *
 * Deliberately free of requires, so any module can read it without a cycle.
 *
 * Earth's physical properties — 6371 km radius, 1.0 g, 23.44° tilt, 24 h
 * day, 4.54 Gyr — are absent because the generator has no parameters for
 * them yet; radius is still hard-coded at `detail.js:23`. They belong here
 * once they are wired, and not before: a preset that names a parameter the
 * generator ignores is worse than one that admits the gap.
 */
'use strict';

module.exports = {
    name: 'earth',

    /* The fixture is a frozen present-day snapshot, not a run, so its seed
     * only picks the mesh. `earth-fixture.js` hashes this token. */
    seed: 'earth',

    values: {
        /* The body. These are the defaults too, because the whole model is
         * calibrated at Earth — but a reference fixture should say what it
         * is rather than inherit it, so that Earth stays Earth if the
         * defaults ever move. */
        radiusKm: 6371,
        gravityG: 1,
        rotationHours: 24,
        axialTiltDeg: 23.44,
        ageGyr: 4.54,

        /* Deliberately NOT pinned, though Earth's land fraction is 29% and
         * the fixture reads 32.4%.
         *
         * Solving for it moves sea level, and on a fixture whose geography is
         * authored from real outlines that floods real coastline: continents
         * thin, shelves drown, and continental crust went from 27% submerged
         * to 35% against Earth's 30% — one number right, a worse map. The
         * fixture's job is to be Earth's map, so its land fraction is an
         * output to judge, not a target to force.
         *
         * The 3.4 points are real and belong at their source: too much of the
         * surface is emergent land on *oceanic* crust — island arcs a cell
         * wide that Earth does not have — plus continental crust sitting a
         * little too high. Fix those and the fraction follows.
         */

        /* Present-day area, not birth area. The random path starts at 0.57
         * because a 200 Myr run consumes crust; starting there here would
         * drown the map. */
        continentFraction: 0.41,

        /* Block unions carry proportionally less rim than single caps, so
         * more of the crust must start as drowned shelf to land near
         * Earth's 29% land. */
        emergentFraction: 0.64,

        cratons: 9,

        /* Belts and basins are authored by the fixture, not grown. */
        sutures: 0,

        /* Drake Passage. */
        polarStraits: true,
        polarCapLand: 0.50,
        polarStraitLat: 52,
        polarStraitBand: 16,

        /* Fixture-only: the one-shot kinematic paint has no simulation
         * loop to accumulate over, so it needs its own pass count and an
         * explicit cap where half-space cooling would otherwise run past
         * the oldest floor Earth actually has. */
        paintPasses: 6,
        seafloorAgeCapMyr: 180,
    },
};
