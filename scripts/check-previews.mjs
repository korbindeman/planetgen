import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createRequire} from 'node:module';
import {campaignHalo} from './preview-halo.mjs';
const require=createRequire(import.meta.url), Cube=require('../src/cubesphere');
const {downsample,haloSize}=require('../src/preview-dem');
const Shade=require('../src/td-shade'),Look=require('../src/look');

// Pixel-centre registration and the border filter must preserve a continuous
// planar slope. Clamping a tile, or rounding its centre, fails this check.
const width=32,pad=haloSize(width,width,8,8),stride=width+2*pad;
const plane=new Float32Array(stride*stride);
for(let y=-pad;y<width+pad;y++)for(let x=-pad;x<width+pad;x++)plane[(y+pad)*stride+x+pad]=100+3*x-7*y;
const result=downsample(plane,width,width,8,8,pad);
for(let y=0;y<8;y++)for(let x=0;x<8;x++)assert.ok(Math.abs(result[y*8+x]-(100+3*((x+.5)*4-.5)-7*((y+.5)*4-.5)))<1e-4);

// The retained output border is real neighbouring ground, registered to the
// same centres as the interior. A clamped output pad fails at every edge.
{
    const outPad=2,inputPad=haloSize(width,width,8,8,outPad),stride=width+2*inputPad;
    const input=new Float32Array(stride*stride);
    for(let y=-inputPad;y<width+inputPad;y++)for(let x=-inputPad;x<width+inputPad;x++)input[(y+inputPad)*stride+x+inputPad]=100+3*x-7*y;
    const out=downsample(input,width,width,8,8,inputPad,outPad);
    assert.equal(out.length,12*12);
    for(let y=0;y<12;y++)for(let x=0;x<12;x++)assert.ok(Math.abs(out[y*12+x]-(100+3*((x-outPad+.5)*4-.5)-7*((y-outPad+.5)*4-.5)))<1e-4);
}

// At a padded raster's interior edge, the geographic normal must agree with
// an analytic spherical field. This exercises all face frames and both pads.
{
    const n=64,pad=2,w=n+2*pad,axis=[170,-290,130];let worst=0;
    const dot=(a,b)=>a.reduce((sum,v,k)=>sum+v*b[k],0);
    for(let face=0;face<6;face++)for(const i of [0,7])for(const j of [0,7]) {
        const tile={face,level:3,i,j},e=new Float32Array(w*w);
        for(let y=0;y<w;y++)for(let x=0;x<w;x++)e[y*w+x]=dot(axis,Cube.tileDirection(tile,(x+.5-pad)/n,(y+.5-pad)/n));
        const shades=Shade.cropShade(e,w,w,{tile,elevPad:pad}),angle=Shade.tileTexelAngle(tile,n,n);
        for(let y=pad;y<w-pad;y++)for(let x=pad;x<w-pad;x++) {
            const d=Cube.tileDirection(tile,(x+.5-pad)/n,(y+.5-pad)/n),frame=Shade.tangentFrame(d,Cube.FACES[face].u);
            const wanted=Look.hillshade(angle*dot(axis,frame.east),-angle*dot(axis,frame.north));
            worst=Math.max(worst,Math.abs(shades[y*w+x]-wanted));
        }
    }
    assert.ok(worst<0.002,`Padded spherical shade error ${worst}`);
    console.log(`preview: padded spherical normals max shade error ${worst.toFixed(6)}`);
}

const dir=await mkdtemp(join(tmpdir(),'planetgen-preview-'));
try {
    const settings={seamMode:'symmetric',level:0,blendKm:64,sketchFingerprint:'synthetic'};
    await writeFile(join(dir,'campaign-settings.json'),JSON.stringify(settings));
    const n=128,p=6,rasters=[];
    const height=d=>100+500*d[0]-700*d[1]+300*d[2];
    for(let face=0;face<6;face++) {
        const tile={face,level:0,i:0,j:0},name=Cube.tileName(tile),folder=join(dir,'crop-'+name);
        await mkdir(folder);const data=new Float32Array(n*n);rasters.push(data);
        for(let y=0;y<n;y++)for(let x=0;x<n;x++)data[y*n+x]=height(Cube.tileDirection(tile,(x+.5)/n,(y+.5)/n));
        await writeFile(join(folder,'output.elev'),Buffer.from(data.buffer));
        await writeFile(join(folder,'output.elev.json'),JSON.stringify({width:n,height:n}));
        await writeFile(join(folder,'seam-complete.json'),JSON.stringify({...settings,maskKey:null}));
    }
    const addHalo=await campaignHalo(dir);let worst=0,count=0;
    for(let face=0;face<6;face++) {
        const tile={face,level:0,i:0,j:0},data=await addHalo(tile,rasters[face],n,n,p);
        for(let y=-p;y<n+p;y++)for(let x=-p;x<n+p;x++) {
            if(x>=0&&x<n&&y>=0&&y<n)continue;
            const wanted=height(Cube.tileDirection(tile,(x+.5)/n,(y+.5)/n));
            worst=Math.max(worst,Math.abs(data[(y+p)*(n+2*p)+x+p]-wanted));count++;
        }
    }
    assert.ok(worst<1,`Cross-face halo interpolation error ${worst}`);
    // An expected source with no finalization marker must fail loudly.
    await writeFile(join(dir,'crop-f1l0x0y0','seam-complete.json'),JSON.stringify({sketchFingerprint:'other'}));
    await assert.rejects((await campaignHalo(dir))({face:0,level:0,i:0,j:0},rasters[0],n,n,p),/Unfinalized preview source/);
    console.log(`preview: slope preserved at every pixel centre; ${count} fold/corner halo samples, max ${worst.toFixed(3)} m error; stale source rejected`);
} finally {
    const target=resolve(dir);
    assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('planetgen-preview-'));
    await rm(target,{recursive:true,force:true});
}
