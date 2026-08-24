/*
 * Earth — the reference fixture.
 *
 * Not a project tree. No search, no variants, no seed to shuffle. The
 * tectonics are already known, so shaping can be tested on that base.
 * Body and authored knobs live here; the outlines and poles live in
 * `earth-fixture.js`.
 *
 * Deliberately free of requires, so any module can read it without a cycle.
 *
 * Earth's physical properties — 6371 km radius, 1.0 g, 23.44° tilt, 24 h
 * day, 4.54 Gyr — are written even though they match DEFAULTS, so Earth
 * stays Earth if the defaults ever move.
 */
'use strict';

module.exports = {
    name: 'earth',
    label: 'Earth',
    fixture: true,

    /* The fixture is a frozen present-day snapshot, not a run, so this
     * token only picks the mesh. `earth-fixture.js` hashes it. */
    seed: 'earth',

    /* How far this fixture has got toward the raw bake export. Keys are
     * stages in `pipeline.js`; a missing key is not started. */
    pipeline: {
        base: 'fixture locked',
        conditioning: 'crops',
        regional: 'crops',
        bake: 'later',
    },

    body: {
        radiusKm: 6371,
        gravityG: 1,
        rotationHours: 24,
        axialTiltDeg: 23.44,
        ageGyr: 4.54,
    },

    /* Authored fixture knobs, not pins. Dry share is an output: solving
     * for a land fraction floods real coastline on this map. */
    values: {
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
