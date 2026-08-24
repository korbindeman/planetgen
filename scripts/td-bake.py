#!/usr/bin/env python3
"""Bake a cubesphere tile whose GeoTIFFs already carry a real neighbour pad.

tiff-export pads every crop with mode="edge" and generates from (0, 0). That
is why adjacent preview tiles seamed: each U-Net saw a repeated rim, and each
job had its own origin so they did not share noise at the edge.

This script takes the pad as already-sampled neighbouring ground, places the
import at the face-grid origin the exporter computed, and writes only the
interior. Same WorldPipeline, same cost as tiff-export's internal pad.
"""
from __future__ import annotations

from pathlib import Path

import click
import numpy as np
import rasterio
import torch
from rasterio.transform import Affine
from tqdm import tqdm

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


@click.command()
@click.argument("model_path", default="xandergos/terrain-diffusion-90m")
@click.argument("tiff_dir", type=click.Path(exists=True))
@click.argument("output", type=click.Path())
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
@click.option("--pad", type=int, required=True)
@click.option("--origin-i", type=int, required=True)
@click.option("--origin-j", type=int, required=True)
@click.option("--crop-w", type=int, required=True)
@click.option("--crop-h", type=int, required=True)
def main(
    tiff_dir, output, model_path, snr, hdf5_file, cache_size, seed, device,
    batch_size, torch_compile, dtype, caching_strategy, chunk_size,
    pad, origin_i, origin_j, crop_w, crop_h,
):
    tiff_dir = Path(tiff_dir)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    if pad < 1:
        raise click.UsageError("--pad must be a positive cell count (use tiff-export for an unpadded crop)")
    if crop_w < 1 or crop_h < 1:
        raise click.UsageError("--crop-w and --crop-h must be positive")

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

    print(f"World seed: {world.seed}")
    print(f"  origin ({origin_i}, {origin_j})  interior {crop_w}×{crop_h}  pad {pad}")

    ref_transform = None
    ref_crs = None
    expect_h = crop_h + 2 * pad
    expect_w = crop_w + 2 * pad

    for filename, channel, internal_scale, default_value in CHANNEL_FILES:
        path = tiff_dir / filename
        if not path.exists():
            print(f"  Skipping {filename} (not found). Perlin noise will be used instead.")
            continue
        with rasterio.open(path) as ds:
            if ref_transform is None:
                ref_transform = ds.transform
                ref_crs = ds.crs
            if ds.height != expect_h or ds.width != expect_w:
                raise click.UsageError(
                    f"{filename} is {ds.width}×{ds.height}, expected {expect_w}×{expect_h} "
                    f"(interior {crop_w}×{crop_h} plus {pad} cells of pad)"
                )
        arr = _load(path, internal_scale, default_value)
        world.set_custom_conditioning_import(
            channel, arr, origin_i, origin_j, default_value=default_value,
        )
        print(f"  Imported {filename} → channel {channel}, origin ({origin_i}, {origin_j})")

    if ref_transform is None:
        raise click.UsageError("No conditioning TIFFs found in the directory.")

    out_h = crop_h * PIXELS_PER_CELL
    out_w = crop_w * PIXELS_PER_CELL
    # The conditioning GeoTIFF's transform was written for the padded raster
    # against the interior tile's nominal bbox. Scale so the output covers
    # that bbox, not the pad.
    out_transform = Affine(
        ref_transform.a * expect_w / out_w, ref_transform.b, ref_transform.c,
        ref_transform.d, ref_transform.e * expect_h / out_h, ref_transform.f,
    )

    print(f"Output: {output} ({out_w}x{out_h} px)")

    if chunk_size % PIXELS_PER_CELL != 0:
        raise click.UsageError(f"--chunk-size must be a multiple of {PIXELS_PER_CELL}.")
    chunk_cells = chunk_size // PIXELS_PER_CELL
    row_chunks = (crop_h + chunk_cells - 1) // chunk_cells
    col_chunks = (crop_w + chunk_cells - 1) // chunk_cells

    interior_i = origin_i + pad
    interior_j = origin_j + pad

    with world:
        with rasterio.open(
            output, "w",
            driver="GTiff", height=out_h, width=out_w,
            count=1, dtype="int16",
            crs=ref_crs, transform=out_transform,
            compress="lzw", tiled=True, blockxsize=256, blockysize=256,
        ) as dst:
            with tqdm(total=row_chunks * col_chunks, desc="Generating") as pbar:
                for ci in range(0, crop_h, chunk_cells):
                    for cj in range(0, crop_w, chunk_cells):
                        ci2 = min(ci + chunk_cells, crop_h)
                        cj2 = min(cj + chunk_cells, crop_w)

                        pi1 = (interior_i + ci) * PIXELS_PER_CELL
                        pi2 = (interior_i + ci2) * PIXELS_PER_CELL
                        pj1 = (interior_j + cj) * PIXELS_PER_CELL
                        pj2 = (interior_j + cj2) * PIXELS_PER_CELL

                        result = world.get(pi1, pj1, pi2, pj2, with_climate=False)
                        elev = np.clip(result["elev"].numpy(), -32768, 32767).astype(np.int16)

                        window = rasterio.windows.Window(
                            cj * PIXELS_PER_CELL, ci * PIXELS_PER_CELL,
                            elev.shape[1], elev.shape[0],
                        )
                        dst.write(elev, 1, window=window)
                        pbar.update(1)


if __name__ == "__main__":
    main()
