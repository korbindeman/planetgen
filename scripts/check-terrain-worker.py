"""Exercise the actual worker's native TIFF/raw path with an analytic world.

Run in the terrain-diffusion Python environment; the model is imported but
never loaded or run. Every generated artifact is confined to a temporary dir.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import numpy as np
import rasterio
from rasterio.transform import Affine

scripts = Path(__file__).resolve().parent
sys.path.insert(0, str(scripts))
sys.path.insert(0, str(scripts.parent.parent / 'terrain-diffusion'))
spec = importlib.util.spec_from_file_location('terrain_bake', scripts / 'td-bake.py')
bake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bake)
from td_height import HEIGHT_ENCODING


class Value:
    def __init__(self, value): self.value = value
    def numpy(self): return self.value


class World:
    def set_custom_conditioning_import(self, *args, **kwargs): pass
    def get(self, i, j, ei, ej, with_climate):
        y, x = np.mgrid[i:ei, j:ej]
        return {'elev': Value(((x - 255.5) * .00001).astype(np.float32))}


with tempfile.TemporaryDirectory(prefix='terrain-worker-precision-') as folder:
    folder = Path(folder)
    inputs = folder / 'input'
    inputs.mkdir()
    with rasterio.open(inputs / 'heightmap.tif', 'w', driver='GTiff', width=4,
                       height=4, count=1, dtype='float32', crs='EPSG:4326',
                       transform=Affine(.1, 0, 20, 0, -.1, 20)) as dataset:
        dataset.write(np.zeros((4, 4), dtype=np.float32), 1)
    output = folder / 'output.tif'
    bake.bake_tile(World(), inputs, output, 1, -1, -1, 2, 2,
                   1, 1, 1, 1, 512, log=lambda *args: None, dump_elev=True)
    y, x = np.mgrid[0:512, 0:512]
    expected = ((x - 255.5) * .00001).astype(np.float32)
    with rasterio.open(output) as dataset:
        assert dataset.dtypes == ('float32',)
        assert dataset.tags()['height_encoding'] == HEIGHT_ENCODING
        np.testing.assert_array_equal(dataset.read(1), expected)
    before = {}
    for path in folder.glob('*.elev'):
        before[path.name] = path.read_bytes()
        record = json.loads(path.with_name(path.name+'.json').read_text())
        assert record['heightEncoding'] == HEIGHT_ENCODING
        assert len(before[path.name]) == 4 * record['width'] * record['height']
    assert len(before) == 5, 'Interior or a folded halo was omitted'
    assert before['output.elev'] == expected.astype('<f4').tobytes()
    subprocess.run([sys.executable, str(scripts/'td-preview.py'), str(output),
                    str(folder/'output.png'), '--max-dim=512'], check=True, capture_output=True)
    for name, data in before.items():
        path = folder/name
        assert path.read_bytes() == data, 'TIFF preview round trip changed terrain'
        assert json.loads(path.with_name(path.name+'.json').read_text())['heightEncoding'] == HEIGHT_ENCODING
print('Terrain worker: native Float32 GeoTIFF, raw interior, four halos and preview round trip preserve exact sub-metre values and precision stamps')
