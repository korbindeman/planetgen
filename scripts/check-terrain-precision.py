"""Regress the real dense/masked producer and bytes, without loading a model."""
from collections import OrderedDict
import json
from pathlib import Path
import tempfile
import numpy as np
from td_height import HEIGHT_ENCODING, height_values, generate_window, dump_elev
from td_mask import generate_masked, interpolate


class Value:
    def __init__(self, value): self.value = value
    def numpy(self): return self.value


class World:
    def __init__(self, field): self.field, self.calls = field, []
    def get(self, i, j, ei, ej, with_climate):
        self.calls.append((i, j, ei, ej))
        assert ei-i == ej-j, 'Producer changed a square model query'
        y, x = np.mgrid[i:ei, j:ej]
        return {'elev': Value(self.field(x, y).astype(np.float32))}


quiet = lambda *args: None
ppc = 8
coast = lambda x, y: (x + 7.5) / 64 + (y + .5) / 256
world = World(coast)
dense = generate_window(world, -3, -5, 8, 6, 4, quiet, ppc)
y, x = np.mgrid[-3*ppc:3*ppc, -5*ppc:3*ppc]
expected = coast(x, y).astype(np.float32)
np.testing.assert_array_equal(dense, expected)
assert (dense > 0).any() and (dense < 0).any()
assert np.count_nonzero((dense > 0) != (expected.astype(np.int16) > 0)) > 0

field = {'rect': {'width': 12, 'height': 12, 'originI': -6, 'originJ': -6},
         'base': np.full((12, 12), -7000).tolist(), 'weight': np.ones((12, 12)).tolist()}
job = {'start_i': -3, 'start_j': -3, 'h': 6, 'w': 6,
       'windows': [{'i': -4, 'j': -4, 'h': 8, 'w': 8}]}
# A deep fallback must not swallow very shallow model values when a=1.
tiny = lambda x, y: np.where((x+y)%2, 1e-7, -1e-7)
world, cache = World(tiny), OrderedDict()
masked = generate_masked(world, job, field, quiet, ppc, cache)
y, x = np.mgrid[-3*ppc:3*ppc, -3*ppc:3*ppc]
np.testing.assert_array_equal(masked, tiny(x, y).astype(np.float32))
np.testing.assert_array_equal(generate_masked(world, job, field, quiet, ppc, cache), masked)
assert len(world.calls) == 1
assert all(value.dtype == np.float32 for value in cache.values())
left, right = dict(job, w=3), dict(job, start_j=0, w=3)
joined = np.hstack([generate_masked(world, left, field, quiet, ppc, cache),
                    generate_masked(world, right, field, quiet, ppc, cache)])
np.testing.assert_array_equal(joined, masked)

# The interior of the blend is a convex combination, not a lossy difference.
field['weight'] = np.tile(np.linspace(0, 1, 12), (12, 1)).tolist()
mixed = generate_masked(World(coast), job, field, quiet, ppc)
sx = job['start_j'] + (np.arange(job['w']*ppc)+.5)/ppc + 6
sy = job['start_i'] + (np.arange(job['h']*ppc)+.5)/ppc + 6
a = interpolate(np.array(field['weight'], dtype=np.float32), sx[None, :], sy[:, None])
expected_mix = ((1-a)*-7000 + a*coast(x, y).astype(np.float32)).astype(np.float32)
np.testing.assert_array_equal(mixed, expected_mix)

extremes = np.array([[-40000.25, 40000.25, -.00001, .00001]], dtype=np.float32)
owned = height_values(extremes)
np.testing.assert_array_equal(owned, extremes)
owned[0, 0] = 0
assert extremes[0, 0] == -40000.25, 'Model cache aliases a borrowed output buffer'
for bad in (np.nan, np.inf, -np.inf, 1e100):
    try: height_values([[bad]])
    except ValueError: pass
    else: raise AssertionError('Invalid terrain accepted')
try: height_values(np.zeros((2, 3)), (3, 2))
except ValueError: pass
else: raise AssertionError('Wrong query dimensions accepted')
with tempfile.TemporaryDirectory(prefix='terrain-precision-') as folder:
    path = Path(folder) / 'output.elev'
    dump_elev(path, masked)
    assert path.read_bytes() == masked.astype('<f4').tobytes()
    assert json.loads(path.with_name(path.name+'.json').read_text()) == {
        'width': 48, 'height': 48, 'heightEncoding': HEIGHT_ENCODING}
    invalid = Path(folder) / 'invalid.elev'
    try: dump_elev(invalid, [[np.nan]])
    except ValueError: pass
    else: raise AssertionError('Invalid raw file written')
    assert not invalid.exists()
print('Terrain precision: dense and masked signs, sub-micrometre contact, cached/clipped windows, convex fade, finite range and exact Float32 bytes pass')
