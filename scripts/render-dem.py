#!/usr/bin/env python3
"""Hillshade a terrain-diffusion DEM (or a planetgen heightmap.tif) to PNG."""
from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

import numpy as np
import rasterio

OCEAN_DEPTH_M = 6000.0
LAND_PEAK_M = 5500.0
ZENITH = math.radians(45)
AZIMUTH = math.radians(315)
CELL = 90.0
SHADE_MIN = 0.15
MAX_EDGE = 2048


def lerp3(a, b, t):
    return [a[i] + (b[i] - a[i]) * t for i in range(3)]


def elev_rgb(m):
    if m < 0:
        t = min(1.0, -m / OCEAN_DEPTH_M)
        return lerp3([72, 130, 176], [12, 28, 58], t)
    t = min(1.0, m / LAND_PEAK_M)
    if t < 0.35:
        return lerp3([92, 148, 78], [196, 196, 118], t / 0.35)
    if t < 0.7:
        return lerp3([196, 196, 118], [142, 104, 64], (t - 0.35) / 0.35)
    return lerp3([142, 104, 64], [244, 244, 248], (t - 0.7) / 0.3)


def hillshade(elev):
    dzdx = np.zeros_like(elev, dtype=np.float32)
    dzdy = np.zeros_like(elev, dtype=np.float32)
    dzdx[:, 1:-1] = (elev[:, 2:] - elev[:, :-2]) / (2 * CELL)
    dzdx[:, 0] = (elev[:, 1] - elev[:, 0]) / CELL
    dzdx[:, -1] = (elev[:, -1] - elev[:, -2]) / CELL
    dzdy[1:-1, :] = (elev[2:, :] - elev[:-2, :]) / (2 * CELL)
    dzdy[0, :] = (elev[1, :] - elev[0, :]) / CELL
    dzdy[-1, :] = (elev[-1, :] - elev[-2, :]) / CELL
    slope = np.arctan(np.hypot(dzdx, dzdy))
    aspect = np.arctan2(-dzdy, dzdx)
    shade = math.cos(ZENITH) * np.cos(slope) + math.sin(ZENITH) * np.sin(slope) * np.cos(AZIMUTH - aspect)
    return np.clip(shade, SHADE_MIN, 1.0)


def downsample(elev, max_edge):
    h, w = elev.shape
    scale = max(h, w) / max_edge
    if scale <= 1:
        return elev
    nh, nw = max(1, int(round(h / scale))), max(1, int(round(w / scale)))
    y = np.linspace(0, h - 1, nh)
    x = np.linspace(0, w - 1, nw)
    yi = np.clip(y.astype(int), 0, h - 2)
    xi = np.clip(x.astype(int), 0, w - 2)
    ty = (y - yi)[:, None]
    tx = (x - xi)[None, :]
    z00 = elev[yi[:, None], xi]
    z01 = elev[yi[:, None], xi + 1]
    z10 = elev[yi[:, None] + 1, xi]
    z11 = elev[yi[:, None] + 1, xi + 1]
    return (z00 * (1 - ty) * (1 - tx) + z01 * (1 - ty) * tx + z10 * ty * (1 - tx) + z11 * ty * tx).astype(np.float32)


def write_png(path, rgb):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def colorize(elev):
    shade = hillshade(elev)
    ocean = elev < 0
    t_ocean = np.clip(-elev / OCEAN_DEPTH_M, 0, 1)
    t_land = np.clip(elev / LAND_PEAK_M, 0, 1)
    rgb = np.empty(elev.shape + (3,), dtype=np.float32)
    lo, hi = np.array([72, 130, 176], np.float32), np.array([12, 28, 58], np.float32)
    rgb[ocean] = lo + (hi - lo) * t_ocean[ocean, None]
    low = (~ocean) & (t_land < 0.35)
    mid = (~ocean) & (t_land >= 0.35) & (t_land < 0.7)
    high = (~ocean) & (t_land >= 0.7)
    a, b = np.array([92, 148, 78], np.float32), np.array([196, 196, 118], np.float32)
    rgb[low] = a + (b - a) * (t_land[low, None] / 0.35)
    a, b = np.array([196, 196, 118], np.float32), np.array([142, 104, 64], np.float32)
    rgb[mid] = a + (b - a) * ((t_land[mid, None] - 0.35) / 0.35)
    a, b = np.array([142, 104, 64], np.float32), np.array([244, 244, 248], np.float32)
    rgb[high] = a + (b - a) * ((t_land[high, None] - 0.7) / 0.3)
    rgb *= shade[..., None]
    return np.clip(rgb, 0, 255).astype(np.uint8)


def main():
    if len(sys.argv) < 2:
        print("usage: render-dem.py input.tif [output.png]", file=sys.stderr)
        sys.exit(2)
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_suffix(".png")
    with rasterio.open(src) as ds:
        elev = ds.read(1).astype(np.float32)
    elev = downsample(elev, MAX_EDGE)
    write_png(dst, colorize(elev))
    print(dst)


if __name__ == "__main__":
    main()
