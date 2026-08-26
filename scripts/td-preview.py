#!/usr/bin/env python3
"""Downsample a terrain-diffusion DEM so the studio can paint it as terrain."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import rasterio

MAX_DIM = 2048


def _dump(path: Path, elev: np.ndarray) -> None:
    h, w = elev.shape
    path.write_bytes(elev.astype("<f4").tobytes())
    path.parent.joinpath(path.name + ".json").write_text(
        json.dumps({"width": int(w), "height": int(h)})
    )


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: td-preview.py input.tif output.png", file=sys.stderr)
        return 2
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    with rasterio.open(src) as ds:
        elev = ds.read(1).astype(np.float32)
    h, w = elev.shape
    step = max(1, int(np.ceil(max(w, h) / MAX_DIM)))
    elev = np.ascontiguousarray(elev[::step, ::step])
    folder = dst.parent
    _dump(folder / "output.elev", elev)
    print(folder / "output.elev")

    for halo in folder.glob("halo-*.tif"):
        with rasterio.open(halo) as ds:
            arr = ds.read(1).astype(np.float32)
        arr = np.ascontiguousarray(arr[::step, ::step])
        _dump(halo.with_suffix(".elev"), arr)
        print(halo.with_suffix(".elev"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
