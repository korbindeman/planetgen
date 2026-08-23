/*
 * Thalos — the planet this generator exists to make.
 *
 * Little is pinned, and that is the honest state rather than an oversight.
 * Thalos is being discovered, not transcribed: the lore in `~/dev/thalos` is
 * where the idea currently stands, not a specification the generator has to
 * hit. Four properties are decided — radius, gravity, day length and tilt —
 * and they are pinned below.
 *
 * Everything else — land fraction, age, and the seed itself — is still in
 * play. That is what this preset is for: it gains a pin each time a decision
 * gets made, so the file doubles as the record of what has been settled.
 *
 * Deliberately free of requires, so any module can read it without a cycle.
 */
'use strict';

module.exports = {
    name: 'thalos',

    /* From `~/dev/thalos/assets/bodies/thalos.ron`. A starting point to
     * explore from, not a chosen planet. */
    seed: 1003,

    values: {
        /* Decided. Half Earth's radius, so a quarter of the surface area:
         * at 35% land the whole world is about one Eurasia. */
        radiusKm: 3186,
        gravityG: 0.91,

        /* Decided, from `~/dev/thalos/assets/solar_system.ron`. The 21.3
         * hour day narrows the Hadley cells, so Thalos's dry belt and storm
         * track sit at ~94% of Earth's latitudes. */
        rotationHours: 21.3,
        axialTiltDeg: 23,

        /* Still in play: age, land fraction, and the seed. `ageGyr: 5.5` is
         * where the lore stands, but it is not pinned here, because nothing
         * has judged what it looks like yet. */
    },
};
