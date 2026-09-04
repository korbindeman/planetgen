# Reference — WSL bake environment

## Where it is

Distro **`Thalos-Ubuntu`** (WSL2, Ubuntu 24.04, the default distro).
Interpreter `~/td-env/bin/python` → `/home/korbi/td-env/bin/python`.
Model source is the **Windows** checkout read cross-mount at
`/mnt/c/Users/korbi/Documents/terrain-diffusion` — there is no second copy,
and the native-Windows env in that same checkout is
[the other environment](terrain-diffusion.md#where-it-lives).

From a Windows agent shell, nothing here needs a login shell or sudo:

```powershell
wsl.exe -l -v                                    # Thalos-Ubuntu, Stopped, 2
wsl.exe -d Thalos-Ubuntu -- bash -lc '~/td-env/bin/python -c "import torch, triton; print(torch.__version__, triton.__version__, torch.cuda.is_available())"'
# -> 2.14.0+cu130 3.8.0 True
```

`Stopped` in `wsl -l -v` is normal; the first command starts the distro.

## Why

Decided Sep 2026. The Thalos 90 m bake runs in WSL2, not native Windows,
because `torch.compile` is unsupported on Windows and the bake is
`WorldPipeline` inference bound. Measured on the home RTX 4070 Ti, same
seed/SNR/fp32/direct-cache settings, 2048² px windows:

| Env | Steady state | Rate | 16 B px dense | ~150k tiles w/ overlap |
| --- | --- | --- | --- | --- |
| Native Windows (uncompiled) | ~10.3 s | ~0.41 Mpx/s | ~11 h | **~26 h** |
| WSL2 + `torch.compile` (inductor/triton) | ~7.5 s | ~0.56 Mpx/s | ~8 h | **~19 h** |

~1.4×. Native remains the fallback if Triton ever chokes on a model update —
re-run the 4-window bench below and compare against these numbers.

## Setup (rootless, no sudo)

CUDA comes through the Windows driver (610.88) — no toolkit install, no
driver install inside WSL. No sudo is available, so everything is
user-local. This is how the env above was built; it is already built.

```bash
# uv (user-local, ~/.local/bin)
curl -LsSf https://astral.sh/uv/install.sh -o /tmp/uv-install.sh && sh /tmp/uv-install.sh

# Python with headers — the system python3.12 has no python3-dev and apt
# needs sudo, so use a uv-managed interpreter (Triton JIT needs Python.h)
uv python install 3.12
uv venv ~/td-env --python 3.12
uv pip install --python ~/td-env/bin/python \
  torch torchvision triton rasterio click tqdm 'numpy>=2.1.3' pyyaml Pillow \
  scipy h5py safetensors 'diffusers>=0.30.3' accelerate easydict \
  infinite-tensor confection catalogue numba networkx scikit-image tifffile \
  global-land-mask pyfastnoiselite ema-pytorch matplotlib
```

Pinned result: torch 2.14.0+cu130, triton 3.8.0, numpy 2.5.2
(`uv pip freeze --python ~/td-env/bin/python` reproduces the full list).

Weights go to a WSL-local HF cache (`HF_HUB_CACHE=~/td-hub`) — do not point
it at the Windows cache dir. Bake outputs (~50 GB with overlap) also live on
ext4 (`/home/korbi/...`, 889 GB free at setup); `/mnt/c` is fine for reading
code, too slow for the tile store.

## Running

Run from the checkout dir — `bind()` resolves the synthetic-map stats cache
(`data/global/synthetic_map_stats.json`) relative to cwd, otherwise it
interactively prompts for a WorldClim download and hangs headless:

```bash
cd /mnt/c/Users/korbi/Documents/terrain-diffusion
PYTHONPATH=$PWD HF_HUB_CACHE=~/td-hub MPLBACKEND=Agg ~/td-env/bin/python <script>
```

Bake settings: fp32 (`dtype=None`), `torch_compile=True`,
`caching_strategy="direct"`, `cache_limit=1<<30`,
SNR `0.2,0.2,1.0,0.2,1.0`. Peak VRAM ~2.1 GB — fits even with a busy desktop,
but free the card anyway before a campaign run.

## Bench

`td-bench` (4 fresh 2048² `world.get` windows, bake settings, `with_climate=False`):

- Cold first window ~12 s (load+bind ~39 s before that, incl. inductor warmup).
- Steady state is runs 2–3. If those regress past ~9 s, Triton fell back —
  check for `torch.compile is not supported` / InductorError in the log.

Sharding still applies ([bake-compute](bake-compute.md)): WSL workers take a
partition of the tile list, same seed + conditioning. The Windows studio keeps
orchestrating; only `WorldPipeline` workers move.
