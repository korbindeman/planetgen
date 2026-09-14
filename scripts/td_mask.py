"""Sparse generation helpers. No model imports: test against an analytic world."""
import numpy as np
from td_height import height_values

def interpolate(a, x, y):
    x = np.clip(x - .5, 0, a.shape[1] - 1)
    y = np.clip(y - .5, 0, a.shape[0] - 1)
    ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
    jx, jy = np.minimum(ix + 1, a.shape[1] - 1), np.minimum(iy + 1, a.shape[0] - 1)
    tx, ty = x - ix, y - iy
    return ((a[iy, ix] * (1-tx) + a[iy, jx] * tx) * (1-ty)
            + (a[jy, ix] * (1-tx) + a[jy, jx] * tx) * ty)

def generate_masked(world, job, field, log=print, ppc=256, cache=None):
    """Produce finite raw heights; interpolate the common offshore fallback.

    Only selected absolute windows call the model. The full face remains bound,
    so its coarse parents and conditioning context are unchanged.
    """
    rect = field['rect']
    base = np.asarray(field['base'], dtype=np.float32).reshape(rect['height'], rect['width'])
    weights = np.asarray(field['weight'], dtype=np.float32).reshape(base.shape)
    si, sj, h, w = job['start_i'], job['start_j'], job['h'], job['w']
    xs = sj + (np.arange(w*ppc)+.5)/ppc - rect['originI']
    ys = si + (np.arange(h*ppc)+.5)/ppc + rect['originJ'] + rect['height']
    out = np.empty((h*ppc, w*ppc), dtype=np.float32)
    # Bound temporary arrays; a fold raw plane can be wider than 6000 pixels.
    for y in range(0, h*ppc, ppc):
        out[y:y+ppc] = interpolate(base, xs[None,:], ys[y:y+ppc,None])
    selected = queried = reused = 0
    for block in job['windows']:
        i, j, bh, bw = (int(block[k]) for k in ('i','j','h','w'))
        if bh != bw:
            raise ValueError('The model must receive a square query')
        ci,cj,ei,ej=max(i,si),max(j,sj),min(i+bh,si+h),min(j+bw,sj+w)
        y,x=(ci-si)*ppc,(cj-sj)*ppc
        hh,ww=(ei-ci)*ppc,(ej-cj)*ppc
        key=(i,j,bh,bw)
        elev=cache.get(key) if cache is not None else None
        if elev is None:
            result = world.get(i*ppc,j*ppc,(i+bh)*ppc,(j+bw)*ppc,with_climate=False)
            queried += bh*bw
            elev = height_values(result['elev'].numpy(), (bh * ppc, bw * ppc))
            if cache is not None:
                cache[key]=elev
                while len(cache)>16:cache.popitem(last=False)
        elif cache is not None:
            cache.move_to_end(key)
            reused += bh*bw
        elev = elev[(ci-i)*ppc:(ei-i)*ppc,(cj-j)*ppc:(ej-j)*ppc]
        a = interpolate(weights, xs[None,x:x+ww], ys[y:y+hh,None])
        part = out[y:y+hh,x:x+ww]
        # A fully selected sample must equal the model even beside a deep
        # fallback. Subtracting that fallback in float32 first erases
        # sub-millimetre heights through cancellation.
        part[:] = (1 - a) * part + a * elev
        selected += (ei-ci)*(ej-cj)
    log(f"  fine mask: selected {selected}/{h*w} output cells; "
        f"queried {queried} model cells, reused {reused} cached cells in {len(job['windows'])} windows")
    return out
