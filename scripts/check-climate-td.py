"""One 256x256 native terrain cell on CPU, isolated from any campaign worker."""
import os
os.environ['CUDA_VISIBLE_DEVICES'] = ''
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['OMP_NUM_THREADS'] = '2'
os.environ['MKL_NUM_THREADS'] = '2'
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
import sys, json, time, importlib.util
import faulthandler
faulthandler.dump_traceback_later(60,repeat=True)
from pathlib import Path
cache_root=Path(sys.argv[1]).resolve()/'cpu-cache'
os.environ['NUMBA_CACHE_DIR']=str(cache_root/'numba')
os.environ['MPLCONFIGDIR']=str(cache_root/'matplotlib')
import numpy as np
import torch
print('CPU trial: Python dependencies loaded',flush=True)
torch.set_num_threads(2)
torch.set_num_interop_threads(1)
root = Path(__file__).resolve().parent
sys.path.insert(0,str(root.parent.parent/'terrain-diffusion'))
spec = importlib.util.spec_from_file_location('climate_trial_worker',root/'td-bake.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
print('CPU trial: terrain pipeline imported',flush=True)
faulthandler.cancel_dump_traceback_later()
out = Path(sys.argv[1]).resolve()
# The sibling library resolves its fallback-climate statistics against cwd.
# Point this test process at a private copy of the existing cache, so running
# the check from planetgen neither prompts for downloads nor writes to a bake.
import shutil
import terrain_diffusion.inference.synthetic_map as synthetic_map
stats_source=root.parent.parent/'terrain-diffusion/data/global/synthetic_map_stats.json'
if not stats_source.is_file():
    raise FileNotFoundError(f'CPU validation needs the existing terrain reference cache: {stats_source}')
cache_root.mkdir(parents=True,exist_ok=True)
stats_copy=cache_root/'synthetic_map_stats.json'
shutil.copyfile(stats_source,stats_copy)
synthetic_map.STATS_CACHE_PATH=str(stats_copy)
job = json.loads((out/'trial.json').read_text())
class Imports:
    def __init__(self): self.channels = {}
    def set_custom_conditioning_import(self,channel,arr,i,j,default_value=None): self.channels[channel] = arr
imports = Imports()
worker.import_channels(imports,out/'conditioning',job['origin_i'],job['origin_j'])
y,x=job['start_i']-job['origin_i'],job['start_j']-job['origin_j']
for channel,(key,scale) in enumerate([('heightmap',1),('temperature',1),('temperature_std',100),('precipitation',1),('precipitation_cv',1)]):
    arr=imports.channels[channel]
    assert np.isfinite(arr).all()
    assert np.isclose(arr[y,x],job['expected'][key]*scale,rtol=1e-6), (key,arr[y,x],job['expected'][key])
print('All five channels reached the actual importer with correct units',flush=True)
started=time.monotonic()
world=worker.WorldPipeline.from_pretrained('xandergos/terrain-diffusion-90m',seed=211,latents_batch_size=1,
    torch_compile=False,dtype=None,caching_strategy='direct',cache_limit=512*1024**2)
world.to('cpu');world.set_cond_snr([.2,.2,1,.2,1]);world.bind(hdf5_file=None)
worker.import_channels(world,out/'conditioning',job['origin_i'],job['origin_j'])
print('CPU model ready; generating one native 256x256 cell',flush=True)
with torch.inference_mode():
    p=256;result=world.get(job['start_i']*p,job['start_j']*p,(job['start_i']+1)*p,(job['start_j']+1)*p,with_climate=False)
elev=result['elev'].numpy()
assert elev.shape==(256,256) and np.isfinite(elev).all() and elev.std()>1
worker._dump_elev(out/'output.elev',elev)
report={**job,'device':'cpu','seconds':time.monotonic()-started,'minM':float(elev.min()),'maxM':float(elev.max()),'meanM':float(elev.mean()),'stdM':float(elev.std())}
(out/'result.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report),flush=True)
