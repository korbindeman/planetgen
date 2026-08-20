/*
 * From http://www.redblobgames.com/x/1742-webgl-mapgen2/
 * Copyright 2017 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Left half: ocean, indexed by elevation -1:0.
 * Right half: Whittaker biomes, temperature 0:1 × moisture 0:1.
 */
'use strict';

exports.width = 64,
exports.height = 64;

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function lerp3(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/* Rows are moisture 0, 0.5, 1. Columns are temperature 0, 1/3, 2/3, 1. */
const BIOME = [
    [[176, 172, 164], [198, 176, 124], [210, 185, 139], [196, 154, 102]],
    [[142, 144, 128], [108, 122, 78], [148, 140, 72], [128, 122, 48]],
    [[214, 222, 230], [64, 96, 70], [48, 96, 52], [28, 74, 38]],
];

function biomeColor(temp, moisture) {
    const t = Math.max(0, Math.min(1, temp)) * 3;
    const m = Math.max(0, Math.min(1, moisture)) * 2;
    const t0 = Math.min(2, Math.floor(t));
    const t1 = t0 + 1;
    const tf = t - t0;
    const m0 = Math.min(1, Math.floor(m));
    const m1 = m0 + 1;
    const mf = m - m0;
    return lerp3(
        lerp3(BIOME[m0][t0], BIOME[m0][t1], tf),
        lerp3(BIOME[m1][t0], BIOME[m1][t1], tf),
        mf);
}

function colormap() {
    const pixels = new Uint8Array(exports.width * exports.height * 4);

    for (var y = 0, p = 0; y < exports.height; y++) {
        for (let x = 0; x < exports.width; x++) {
            let e = 2 * x / exports.width - 1,
                moisture = y / exports.height;

            let r, g, b;

            if (x === exports.width/2 - 1) {
                r = 48;
                g = 120;
                b = 160;
            } else
            if (x === exports.width/2 - 2) {
                r = 48;
                g = 100;
                b = 150;
            } else if (x === exports.width/2 - 3) {
                r = 48;
                g = 80;
                b = 140;
            } else
            if (e < 0.0) {
                r = 48 + 48*e;
                g = 64 + 64*e;
                b = 127 + 127*e;
            } else {
                const rgb = biomeColor(e, moisture);
                r = rgb[0];
                g = rgb[1];
                b = rgb[2];
            }

            pixels[p++] = r;
            pixels[p++] = g;
            pixels[p++] = b;
            pixels[p++] = 255;
        }
    }
    return pixels;
}

exports.data = colormap();
