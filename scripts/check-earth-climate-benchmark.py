"""Offline checks for the scientific comparison, not an Earth climate score."""
import importlib.util
from pathlib import Path
import numpy as np

spec=importlib.util.spec_from_file_location("benchmark",Path(__file__).with_name("earth-climate-benchmark.py"))
b=importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

# Polar pixels must not receive equatorial area. Integrated area is exact.
fine=b.pixel_areas(1080,2160)
coarse=b.pixel_areas(36,72)
np.testing.assert_allclose(fine.sum(),4*np.pi,rtol=1e-14)
np.testing.assert_allclose(fine.reshape(36,30,72,30).sum(axis=(1,3)),coarse,atol=1e-15)
assert fine[0,0]<fine[540,0]/100

# Aligned aggregation preserves area-integrated water; no edge/pole loss.
rng=np.random.default_rng(42)
rain=rng.uniform(0,1000,(12,180,288))
area=b.pixel_areas(180,288)
aggregated=b.block_mean(rain,area)
np.testing.assert_allclose((rain*area).sum(axis=(1,2)),(aggregated*coarse).sum(axis=(1,2)),rtol=1e-13)

# Missing pixels are unsupported, not zero; legitimate zero rain remains valid.
values=np.array([[np.nan,0.0],[2.0,4.0]])
assert b.block_mean(values,np.ones((2,2)),1,1)[0,0]==2
assert np.isnan(b.block_mean(np.full((2,2),np.nan),np.ones((2,2)),1,1)[0,0])

# GFDL orientation: NE ends at top-right after rolling Greenwich to the centre.
original=np.arange(8).reshape(2,4)
np.testing.assert_array_equal(b.gcm_order(original),[[6,7,4,5],[2,3,0,1]])

# A constant daily rain rate must remain seasonless on a 360-day comparison.
daily=2.0
monthly=np.full((12,1,1),daily*30)
t=np.arange(12)[:,None,None].astype(float)
summary=b.summarize(t,monthly)
np.testing.assert_allclose(summary[:,0,0],[5.5,720,np.std(np.arange(12),ddof=1),0])

# Spatial averaging and seasonal SD do not commute. Both comparisons document
# and use the appropriate order (GCM monthly means vs WorldClim local BIOs).
anti=np.stack([np.sin(np.arange(12)*2*np.pi/12),-np.sin(np.arange(12)*2*np.pi/12)],axis=-1).reshape(12,1,2)
assert b.summarize(b.block_mean(anti,np.ones((1,2)),1,1),np.ones((12,1,1)))[2,0,0]==0
assert b.summarize(anti,np.ones_like(anti))[2].mean()>.7

# Weighted metrics must respect a mask and retain the bias sign.
m=b.metrics(np.array([1.,100.,3.]),np.array([0.,0.,1.]),np.array([1.,0.,3.]))
assert m['cells']==2 and m['bias']==1.75 and m['mae']==1.75
np.testing.assert_allclose(m['rmse'],np.sqrt(13/4))
assert b.metrics(np.zeros(2),np.zeros(2),np.ones(2))['spatial_correlation'] is None
print('Earth benchmark: area/volume conservation, missing support, longitude orientation, calendar, seasonality order and weighted metrics passed')
