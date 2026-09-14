"""The bake's Float32 metre contract, independent of the terrain model.

Keep sub-metre signs through the worker, cache and raw files. Quantization
belongs to an explicitly declared export representation, never the bake.
"""
import json
from pathlib import Path
import numpy as np

HEIGHT_ENCODING = "float32-metres-v1"


def height_values(values, shape=None):
    """Own finite Float32 metres; reject bad samples rather than clamping them."""
    with np.errstate(over="ignore", invalid="ignore"):
        out = np.array(values, dtype=np.float32, order="C", copy=True)
    if out.ndim != 2 or (shape is not None and out.shape != shape):
        raise ValueError("Terrain elevation dimensions do not match the query")
    if not np.isfinite(out).all():
        raise ValueError("Non-finite terrain elevation")
    return out


def dump_elev(path, values):
    """Write raw little-endian metres and their explicit precision stamp."""
    path = Path(path)
    elev = height_values(values)
    h, w = elev.shape
    path.write_bytes(elev.astype("<f4", copy=False).tobytes())
    path.with_name(path.name + ".json").write_text(json.dumps({
        "width": int(w), "height": int(h), "heightEncoding": HEIGHT_ENCODING,
    }))


def generate_window(world, start_i, start_j, gen_w, gen_h, chunk_cells, log=print, ppc=256):
    """Copy square model queries into a window without quantizing elevations."""
    full = np.zeros((gen_h * ppc, gen_w * ppc), dtype=np.float32)
    row_start=(start_i//chunk_cells)*chunk_cells
    col_start=(start_j//chunk_cells)*chunk_cells
    row_chunks = (start_i+gen_h-row_start+chunk_cells-1)//chunk_cells
    col_chunks = (start_j+gen_w-col_start+chunk_cells-1)//chunk_cells
    completed = 0
    for i in range(row_start,start_i+gen_h,chunk_cells):
        for j in range(col_start,start_j+gen_w,chunk_cells):
            ci,cj=max(i,start_i),max(j,start_j)
            ci2,cj2=min(i+chunk_cells,start_i+gen_h),min(j+chunk_cells,start_j+gen_w)
            result = world.get(
                i * ppc, j * ppc,
                (i+chunk_cells) * ppc, (j+chunk_cells) * ppc,
                with_climate=False,
            )
            elev = height_values(result["elev"].numpy(), (chunk_cells * ppc, chunk_cells * ppc))
            full[(ci-start_i)*ppc:(ci2-start_i)*ppc,(cj-start_j)*ppc:(cj2-start_j)*ppc] = elev[(ci-i)*ppc:(ci2-i)*ppc,(cj-j)*ppc:(cj2-j)*ppc]
            completed += 1
            log(f"Generating: {100 * completed / (row_chunks * col_chunks):.0f}% | {completed}/{row_chunks * col_chunks}")
    return full

