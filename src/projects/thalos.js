/*
 * Thalos — the default project, the world being discovered.
 *
 * A project is a tree of variants plus an optional adopted body. This
 * file holds the body we have decided so far — radius, gravity, day,
 * tilt — and nothing else. Age and water are still in play. The seed
 * lives on a variant, not here.
 *
 * Deliberately free of requires, so any module can read it without a cycle.
 */
'use strict';

module.exports = {
    name: 'thalos',
    label: 'Thalos',

    /* How far this project has got toward the raw bake export. Keys are
     * stages in `pipeline.js`; a missing key is not started. */
    pipeline: {
        base: 'in play',
    },

    /* Adopted body: the default for new working planets. Variants store
     * their own copy. From `~/dev/thalos` lore — a starting point, not
     * a chosen planet. */
    body: {
        /* Half Earth's radius, so a quarter of the surface area:
         * at 35% land the whole world is about one Eurasia. */
        radiusKm: 3186,
        gravityG: 0.91,

        /* From `~/dev/thalos/assets/solar_system.ron`. The 21.3 hour
         * day narrows the Hadley cells, so the dry belt and storm
         * track sit at ~94% of Earth's latitudes. */
        rotationHours: 21.3,
        axialTiltDeg: 23,
    },
};
