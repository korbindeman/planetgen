#!/usr/bin/env python3
"""Bake a cubesphere tile whose GeoTIFFs already carry a real neighbour pad.

tiff-export pads every crop with mode="edge" and generates from (0, 0). That
is why adjacent preview tiles seamed: each U-Net saw a repeated rim, and each
job had its own origin so they did not share noise at the edge.

This script takes the pad as already-sampled neighbouring ground, places the
import at the face-grid origin the exporter computed, and writes the interior
plus a one-cell halo past any cube fold. Same-face neighbours share the origin
plane; a face edge still needs that halo so a later stitch can resample it.

Two ways in:

* One tile, then exit. What the studio has always done, unchanged.
* ``--serve``: read one JSON job per line on stdin and bake each. The model
  loads, moves to the GPU and compiles *once* instead of per tile. That is
  most of the cost of a small tile -- load+bind is ~39 s against ~30 s of
  generation -- and a campaign of 384 tiles cannot pay it 384 times.

Serving is bit-identical to one process per tile. It has to be, or a campaign
would not match the corner that was validated by hand. What makes it so is
``set_custom_conditioning_import``: it calls ``rebuild()``, and rebuild with
``caching_strategy="direct"`` installs a *fresh* ``MemoryTileStore``. So every
job starts on an empty cache and no latent survives the tile before it. That
matters more than it looks -- face origins are per-face stereographic, so two
tiles on different faces ask for overlapping lattice coordinates, and a cache
that outlived a job would hand face 3 terrain conditioned on face 0.
"""
from __future__ import annotations

import json
import sys
from collections import OrderedDict
from pathlib import Path

import click
import numpy as np
import rasterio
import torch
from rasterio.transform import Affine
from td_height import HEIGHT_ENCODING, dump_elev as _dump_elev, generate_window
from td_mask import generate_masked

from terrain_diffusion.common.cli_helpers import parse_cache_size
from terrain_diffusion.inference.tiff_export import CHANNEL_FILES, PIXELS_PER_CELL
from terrain_diffusion.inference.world_pipeline import WorldPipeline, resolve_hdf5_path


def _load(path: Path, internal_scale: float, default_value: float | None) -> np.ndarray:
    with rasterio.open(path) as ds:
        arr = ds.read(1).astype(np.float32)
        nodata = ds.nodata
    if nodata is not None:
        arr = np.where(arr == nodata, np.nan, arr)
    fill = default_value if default_value is not None else 0.0
    arr = np.where(np.isfinite(arr), arr, fill)
    if internal_scale != 1.0:
        arr = arr * internal_scale
    return arr



def import_channels(world, tiff_dir, origin_i, origin_j, expect=None, log=print):
    """Install the five conditioning channels at a lattice origin.

    Returns the first channel's transform and CRS, which is what an output
    GeoTIFF copies its georeferencing from.

    Every call resets the tile store (``set_custom_conditioning_import`` ->
    ``rebuild``), so *how often this is called* decides whether neighbouring
    windows share parent latents. Once per tile and they do not: two tiles
    that touch come out of separate diffusions conditioned on separate
    footprints, and their shared edge disagrees by a few hundred metres.
    Once per face and they do -- which is the whole reason the campaign
    imports a face and then generates windows of it.
    """
    ref_transform = None
    ref_crs = None
    tiff_dir = Path(tiff_dir)
    for filename, channel, internal_scale, default_value in CHANNEL_FILES:
        path = tiff_dir / filename
        if not path.exists():
            log(f"  Skipping {filename} (not found). Perlin noise will be used instead.")
            continue
        with rasterio.open(path) as ds:
            if ref_transform is None:
                ref_transform = ds.transform
                ref_crs = ds.crs
            if expect is not None and (ds.height != expect[1] or ds.width != expect[0]):
                raise click.UsageError(
                    f"{filename} is {ds.width}x{ds.height}, expected {expect[0]}x{expect[1]}"
                )
        arr = _load(path, internal_scale, default_value)
        world.set_custom_conditioning_import(
            channel, arr, origin_i, origin_j, default_value=default_value,
        )
        log(f"  Imported {filename} -> channel {channel}, origin ({origin_i}, {origin_j})")
    if ref_transform is None:
        raise click.UsageError("No conditioning TIFFs found in the directory.")
    return ref_transform, ref_crs



def bake_tile(
    world, tiff_dir, output, pad, origin_i, origin_j, crop_w, crop_h,
    halo_north, halo_east, halo_south, halo_west, chunk_size, log=print,
    dump_elev=False, max_dim=0,
):
    """Generate one tile with an already-bound pipeline.

    Everything here is per tile. Everything the caller does before it -- load,
    ``to(device)``, ``set_cond_snr``, ``bind`` -- is per process, which is
    exactly why this is a function and not the body of ``main``.

    ``dump_elev`` writes ``output.elev`` and the halo dumps here instead of
    leaving them to a second `td-preview.py` process. It is the same
    decimation rule -- one `step` taken from the interior and applied to every
    halo, so a halo still lines up with the tile it belongs to -- run against
    the array that is already in memory. A campaign cannot afford to spawn
    python, import rasterio and re-read a 5376x5376 GeoTIFF once per tile just
    to cast it to float32. ``max_dim`` 0 means native: no decimation at all,
    which is what a 90 m bake wants and what the 128 px/cell studio preview
    deliberately does not.
    """
    tiff_dir = Path(tiff_dir)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    if pad < 1:
        raise click.UsageError("--pad must be a positive cell count (use tiff-export for an unpadded crop)")
    if crop_w < 1 or crop_h < 1:
        raise click.UsageError("--crop-w and --crop-h must be positive")
    for name, value in (
        ("halo-north", halo_north), ("halo-east", halo_east),
        ("halo-south", halo_south), ("halo-west", halo_west),
    ):
        if value < 0:
            raise click.UsageError(f"--{name} must be >= 0")

    log(f"  origin ({origin_i}, {origin_j})  interior {crop_w}x{crop_h}  pad {pad}"
        f"  halo n{halo_north} e{halo_east} s{halo_south} w{halo_west}")

    expect_h = crop_h + 2 * pad
    expect_w = crop_w + 2 * pad
    ref_transform, ref_crs = import_channels(
        world, tiff_dir, origin_i, origin_j, expect=(expect_w, expect_h), log=log,
    )

    out_h = crop_h * PIXELS_PER_CELL
    out_w = crop_w * PIXELS_PER_CELL
    # The conditioning GeoTIFF's transform was written for the padded raster
    # against the interior tile's nominal bbox. Scale so the output covers
    # that bbox, not the pad.
    out_transform = Affine(
        ref_transform.a * expect_w / out_w, ref_transform.b, ref_transform.c,
        ref_transform.d, ref_transform.e * expect_h / out_h, ref_transform.f,
    )

    log(f"Output: {output} ({out_w}x{out_h} px)")

    if chunk_size % PIXELS_PER_CELL != 0:
        raise click.UsageError(f"--chunk-size must be a multiple of {PIXELS_PER_CELL}.")
    chunk_cells = chunk_size // PIXELS_PER_CELL

    interior_i = origin_i + pad
    interior_j = origin_j + pad
    gen_h = crop_h + halo_north + halo_south
    gen_w = crop_w + halo_west + halo_east
    start_i = interior_i - halo_north
    start_j = interior_j - halo_west
    ppc = PIXELS_PER_CELL

    def write_tif(path, arr):
        h, w = arr.shape
        tiled = h >= 256 and w >= 256
        with rasterio.open(
            path, "w",
            driver="GTiff", height=h, width=w,
            count=1, dtype="float32",
            crs=ref_crs, transform=out_transform,
            compress="lzw",
            tiled=tiled,
            **({"blockxsize": 256, "blockysize": 256} if tiled else {}),
        ) as dst:
            dst.write(arr, 1)
            dst.update_tags(height_encoding=HEIGHT_ENCODING)

    full = generate_window(world, start_i, start_j, gen_w, gen_h, chunk_cells, log)

    hn, hw = halo_north * ppc, halo_west * ppc
    interior = full[hn:hn + out_h, hw:hw + out_w]
    write_tif(output, interior)
    folder = output.parent
    # Halo column/row 0 is the first sample past the tile, matching td-seam.
    halos = {}
    if halo_east:
        halos["east"] = np.ascontiguousarray(full[hn:hn + out_h, hw + out_w:])
    if halo_west:
        halos["west"] = np.ascontiguousarray(np.fliplr(full[hn:hn + out_h, :hw]))
    if halo_south:
        halos["south"] = np.ascontiguousarray(full[hn + out_h:, hw:hw + out_w])
    if halo_north:
        halos["north"] = np.ascontiguousarray(np.flipud(full[:hn, hw:hw + out_w]))
    for side, arr in halos.items():
        write_tif(folder / f"halo-{side}.tif", arr)

    if dump_elev:
        step = 1 if max_dim <= 0 else max(1, int(np.ceil(max(out_w, out_h) / max_dim)))
        _dump_elev(folder / "output.elev", np.ascontiguousarray(interior[::step, ::step]).astype(np.float32))
        for side, arr in halos.items():
            _dump_elev(folder / f"halo-{side}.elev", np.ascontiguousarray(arr[::step, ::step]).astype(np.float32))
        log(f"  dumped output.elev at step {step} ({out_w // step}x{out_h // step})")


def serve_jobs(world, chunk_size):
    """One JSON job per line on stdin, one JSON result per line on stdout.

    Human output goes to stderr for the whole session so the result stream
    stays parseable: tqdm is already on stderr, and the caller tails it for
    progress exactly as it does for a one-shot bake.

    A tile that throws is reported and the worker stays up. Losing the model
    load over one bad rect would cost more than the tile is worth, and the
    runner needs to know *which* tile failed to leave it unmarked.
    """
    def log(*args):
        print(*args, file=sys.stderr, flush=True)

    mask_field = None
    mask_cache = OrderedDict()
    log("READY")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        name = None
        try:
            job = json.loads(line)
            name = job.get("name")
            op = job.get("op") or "tile"
            if op == "import":
                # One face's conditioning, held across every window that
                # follows. See import_channels for why the count matters.
                import_channels(
                    world, job["tiff_dir"], int(job["origin_i"]), int(job["origin_j"]), log=log,
                )
                mask_field = json.loads(Path(job["mask_file"]).read_text()) if job.get("mask_file") else None
                mask_cache.clear()
                print(json.dumps({"ok": True, "name": name, "op": "import"}), flush=True)
                continue
            if op == "generate":
                if 'windows' in job:
                    if mask_field is None:
                        raise ValueError('Masked generation requires an imported face mask')
                    full = generate_masked(world, job, mask_field, log, cache=mask_cache)
                else:
                    full = generate_window(
                    world, int(job["start_i"]), int(job["start_j"]),
                    int(job["w"]), int(job["h"]),
                    int(job.get("chunk_size") or chunk_size) // PIXELS_PER_CELL, log,
                    )
                out = Path(job["output_elev"])
                out.parent.mkdir(parents=True, exist_ok=True)
                step = 1
                max_dim = int(job.get("max_dim") or 0)
                if max_dim > 0:
                    step = max(1, int(np.ceil(max(full.shape) / max_dim)))
                _dump_elev(out, np.ascontiguousarray(full[::step, ::step]).astype(np.float32))
                log(f"  window {full.shape[1]}x{full.shape[0]} -> {out} step {step}")
                print(json.dumps({"ok": True, "name": name, "op": "generate"}), flush=True)
                continue
            halo = job.get("halo") or {}
            bake_tile(
                world,
                job["tiff_dir"], job["output"], int(job["pad"]),
                int(job["origin_i"]), int(job["origin_j"]),
                int(job["crop_w"]), int(job["crop_h"]),
                int(halo.get("north", 0)), int(halo.get("east", 0)),
                int(halo.get("south", 0)), int(halo.get("west", 0)),
                int(job.get("chunk_size") or chunk_size), log,
                dump_elev=bool(job.get("dump_elev")), max_dim=int(job.get("max_dim") or 0),
            )
            result = {"ok": True, "name": name, "output": job["output"]}
        except Exception as err:  # a bad tile must not take the worker down
            result = {"ok": False, "name": name, "error": f"{type(err).__name__}: {err}"}
            log(f"FAILED {result['error']}")
        print(json.dumps(result), flush=True)
    log("DONE")


@click.command()
@click.argument("model_path", default="xandergos/terrain-diffusion-90m")
@click.argument("tiff_dir", type=click.Path(exists=True), required=False)
@click.argument("output", type=click.Path(), required=False)
@click.option("--snr", default="0.2,0.2,1.0,0.2,1.0")
@click.option("--hdf5-file", default=None)
@click.option("--cache-size", default="1G")
@click.option("--seed", type=int, default=None)
@click.option("--device", default=None)
@click.option("--batch-size", default="1,2,4,8,16")
@click.option("--compile/--no-compile", "torch_compile", default=True)
@click.option("--dtype", type=click.Choice(["fp32", "bf16", "fp16"]), default="fp32")
@click.option("--caching-strategy", type=click.Choice(["indirect", "direct"]), default="direct")
@click.option("--chunk-size", type=int, default=8 * PIXELS_PER_CELL)
@click.option("--serve", "serve", is_flag=True,
              help="Read JSON jobs on stdin and keep the model loaded between them.")
@click.option("--pad", type=int, default=None)
@click.option("--origin-i", type=int, default=None)
@click.option("--origin-j", type=int, default=None)
@click.option("--crop-w", type=int, default=None)
@click.option("--crop-h", type=int, default=None)
@click.option("--halo-north", type=int, default=0)
@click.option("--halo-east", type=int, default=0)
@click.option("--halo-south", type=int, default=0)
@click.option("--halo-west", type=int, default=0)
def main(
    tiff_dir, output, model_path, snr, hdf5_file, cache_size, seed, device,
    batch_size, torch_compile, dtype, caching_strategy, chunk_size, serve,
    pad, origin_i, origin_j, crop_w, crop_h,
    halo_north, halo_east, halo_south, halo_west,
):
    # The one-shot arguments are optional at the parser so `--serve` can leave
    # them out; a one-shot bake still requires every one of them.
    if not serve:
        missing = [n for n, v in (
            ("TIFF_DIR", tiff_dir), ("OUTPUT", output), ("--pad", pad),
            ("--origin-i", origin_i), ("--origin-j", origin_j),
            ("--crop-w", crop_w), ("--crop-h", crop_h),
        ) if v is None]
        if missing:
            raise click.UsageError(f"a one-shot bake needs {', '.join(missing)} (or pass --serve)")

    if device is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cpu":
            print("Warning: Using CPU (CUDA not available).")

    batch_sizes = [int(x) for x in batch_size.split(",")] if "," in batch_size else int(batch_size)
    if dtype == "fp32":
        dtype = None

    world = WorldPipeline.from_pretrained(
        model_path,
        seed=seed,
        latents_batch_size=batch_sizes,
        torch_compile=torch_compile,
        dtype=dtype,
        caching_strategy=caching_strategy,
        cache_limit=parse_cache_size(cache_size),
    )
    world.to(device)

    if snr:
        try:
            snr_vals = [float(x.strip()) for x in snr.split(",")]
        except ValueError:
            raise click.UsageError("--snr values must be numbers")
        if len(snr_vals) != 5:
            raise click.UsageError("--snr must have exactly 5 comma-separated values")
        world.set_cond_snr(snr_vals)

    if caching_strategy == "direct":
        world.bind(hdf5_file=resolve_hdf5_path(hdf5_file) if hdf5_file else None)
    else:
        world.bind(resolve_hdf5_path(hdf5_file) if hdf5_file else "TEMP")

    print(f"World seed: {world.seed}", file=sys.stderr if serve else sys.stdout, flush=True)

    try:
        if serve:
            serve_jobs(world, chunk_size)
        else:
            bake_tile(
                world, tiff_dir, output, pad, origin_i, origin_j, crop_w, crop_h,
                halo_north, halo_east, halo_south, halo_west, chunk_size,
            )
    finally:
        world.close()


if __name__ == "__main__":
    main()
