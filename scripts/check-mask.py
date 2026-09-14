"""Check sparse output against a field with real cross-window structure."""
import numpy as np
from collections import OrderedDict
from td_mask import generate_masked, interpolate

class Value:
    def __init__(self,a): self.a=a
    def numpy(self): return self.a
class World:
    def __init__(self): self.calls=[]
    def get(self,i,j,ei,ej,with_climate):
        self.calls.append((i,j,ei,ej))
        y,x=np.mgrid[i:ei,j:ej]
        return {'elev':Value(350+13*x-9*y)}

ppc=8
field={'rect':{'width':12,'height':12,'originI':-6,'originJ':-6},
       'base':(-1200+np.arange(144).reshape(12,12)*3).tolist(),
       'weight':np.tile(np.array([0,0,0,.2,.7,1,1,1,1,1,1,1]),(12,1)).tolist()}
job={'start_i':-3,'start_j':-5,'h':6,'w':8,
     'windows':[{'i':-4,'j':-4,'h':8,'w':8}]}
world=World();out=generate_masked(world,job,field,lambda *a:None,ppc)
x=job['start_j']+(np.arange(job['w']*ppc)+.5)/ppc+6
y=job['start_i']+(np.arange(job['h']*ppc)+.5)/ppc+6
base=interpolate(np.array(field['base']),x[None,:],y[:,None])
weight=interpolate(np.array(field['weight']),x[None,:],y[:,None])
yy,xx=np.mgrid[-3*ppc:3*ppc,-5*ppc:3*ppc]
expected=base+weight*(350+13*xx-9*yy-base)
np.testing.assert_allclose(out,expected,atol=.0002,rtol=0)
assert len(world.calls)==1
assert np.isfinite(out).all()
# Adjacent job boundaries may clip a block but must read the same world and
# fallback coordinates, including the negative half of the face lattice.
left=dict(job,w=4)
right=dict(job,start_j=-1,w=4)
joined=np.hstack([generate_masked(World(),left,field,lambda *a:None,ppc),
                  generate_masked(World(),right,field,lambda *a:None,ppc)])
np.testing.assert_array_equal(joined,out)
cached=World();cache=OrderedDict()
generate_masked(cached,left,field,lambda *a:None,ppc,cache)
generate_masked(cached,right,field,lambda *a:None,ppc,cache)
assert len(cached.calls)==1, 'Shared square was generated twice'
print('mask: sparse output equals full analytic field; clipped windows agree; fallback is finite')
