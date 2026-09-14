#!/usr/bin/env python3
"""Downsample a terrain-diffusion DEM so the studio can paint it as terrain."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import rasterio

# Default cap on the dumped raster. A cube-tile bake overrides it with
# --max-dim: its raster covers the tile *and* its context halo, so capping the
# whole thing at 2048 quietly cost the tile itself resolution — 21 cells
# decimated to 1792 leaves the 14-cell tile only 1195 px, where it used to get
# 1792. The caller knows how many cells it asked for; this does not.
MAX_DIM = 2048


def _dump(path: Path, elev: np.ndarray, encoding=None) -> None:
    h, w = elev.shape
    path.write_bytes(elev.astype("<f4").tobytes())
    path.parent.joinpath(path.name + ".json").write_text(
        json.dumps({"width": int(w), "height": int(h), **({"heightEncoding": encoding} if encoding else {})})
    )


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print("usage: td-preview.py input.tif output.png [--max-dim N]", file=sys.stderr)
        return 2
    max_dim = MAX_DIM
    for a in sys.argv[1:]:
        if a.startswith("--max-dim="):
            max_dim = max(64, int(a.split("=", 1)[1]))
    src, dst = Path(args[0]), Path(args[1])
    with rasterio.open(src) as ds:
        elev = ds.read(1).astype(np.float32)
        encoding = ds.tags().get("height_encoding")
    h, w = elev.shape
    step = max(1, int(np.ceil(max(w, h) / max_dim)))
    elev = np.ascontiguousarray(elev[::step, ::step])
    folder = dst.parent
    _dump(folder / "output.elev", elev, encoding)
    print(folder / "output.elev")

    for halo in folder.glob("halo-*.tif"):
        with rasterio.open(halo) as ds:
            arr = ds.read(1).astype(np.float32)
            halo_encoding = ds.tags().get("height_encoding")
        arr = np.ascontiguousarray(arr[::step, ::step])
        _dump(halo.with_suffix(".elev"), arr, halo_encoding)
        print(halo.with_suffix(".elev"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
