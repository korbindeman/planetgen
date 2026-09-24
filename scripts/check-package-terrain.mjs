import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createRequire} from 'node:module';
import {HEIGHT_ENCODING} from './terrain-encoding.mjs';
import {createPackageTerrain,reduceInterior,reduceNodes,fillLevelSkirts} from './package-terrain.mjs';
const require=createRequire(import.meta.url),Cube=require('../src/cubesphere');

// Reductions are unrounded box averages of Float32 heights. A sub-metre
// coast survives every mip until a node is encoded.
{
    const n=8,full=Float32Array.from({length:4*n*n},(_,k)=>((k*173)%3000-1700)/7);
    const expected=reduceInterior(full,2*n),children=[];
    for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
        const k=2*y*2*n+2*x;
        assert.equal(expected[y*n+x],Math.fround((full[k]+full[k+1]+full[k+2*n]+full[k+2*n+1])/4));
    }
    for(let qy=0;qy<2;qy++)for(let qx=0;qx<2;qx++) {
        const c=new Float32Array((n+2)**2).fill(-12345);
        for(let y=0;y<n;y++)for(let x=0;x<n;x++)c[(y+1)*(n+2)+x+1]=full[(qy*n+y)*2*n+qx*n+x];
        children.push(c);
    }
    const actual=reduceNodes(children,n);
    for(let y=0;y<n;y++)for(let x=0;x<n;x++)assert.equal(actual[(y+1)*(n+2)+x+1],expected[y*n+x]);
    assert.ok(Math.abs(reduceInterior(Float32Array.of(0.3,0.3,-0.1,-0.1),2)[0]-0.1)<1e-6);
}

// An independent spherical analytic field checks all folded rims and corners
// at multiple mips. Copying each node's last row fails this slope check.
let samples=0,worst=0;
const analytic=d=>130+310*d[0]-490*d[1]+270*d[2];
for(let lod=0;lod<=2;lod++) {
    const n=1<<lod,r=64,stride=r+2,nodes=new Map();
    for(let face=0;face<6;face++)for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
        const tile={face,level:lod,i:x,j:n-1-y},data=new Float32Array(stride*stride).fill(-32768);
        for(let py=0;py<r;py++)for(let px=0;px<r;px++)data[(py+1)*stride+px+1]=analytic(Cube.tileDirection(tile,(px+.5)/r,(py+.5)/r));
        nodes.set(`${face}/${lod}/${x}/${y}`,data);
    }
    fillLevelSkirts(nodes,lod,r);
    for(let face=0;face<6;face++)for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
        const tile={face,level:lod,i:x,j:n-1-y},data=nodes.get(`${face}/${lod}/${x}/${y}`);
        for(let py=-1;py<=r;py++)for(let px=-1;px<=r;px++) {
            if(px>=0&&px<r&&py>=0&&py<r)continue;
            const expected=analytic(Cube.tileDirection(tile,(px+.5)/r,(py+.5)/r));
            worst=Math.max(worst,Math.abs(data[(py+1)*stride+px+1]-expected));samples++;
        }
    }
}
// Unrounded skirts leave only interpolation of the curved field.
assert.ok(worst<0.5,`Folded mip skirt error ${worst}`);
console.log(`package terrain: ${samples} mip border samples, max analytic error ${worst.toFixed(3)} m`);

const dir=await mkdtemp(join(tmpdir(),'planetgen-package-terrain-'));
try {
    const width=32,level=1,cells=4,nodeRes=4,leafLod=4,radiusKm=1593,sketchFingerprint='terrain-fixture';
    const settings={seamMode:'symmetric',level,cells,pxPerCell:width/cells,radiusKm,blendKm:64,sketchFingerprint};
    await writeFile(join(dir,'campaign-settings.json'),JSON.stringify(settings));
    const all=[];
    for(let face=0;face<6;face++)for(let j=0;j<2;j++)for(let i=0;i<2;i++) {
        const tile={face,level,i,j},name=Cube.tileName(tile),folder=join(dir,'crop-'+name);all.push(name);
        await mkdir(folder);const values=new Float32Array(width*width);
        for(let y=0;y<width;y++)for(let x=0;x<width;x++)values[y*width+x]=analytic(Cube.tileDirection(tile,(x+.5)/width,(y+.5)/width));
        await writeFile(join(folder,'output.elev'),Buffer.from(values.buffer));
        await writeFile(join(folder,'output.elev.json'),JSON.stringify({width,height:width}));
        await writeFile(join(folder,'seam-complete.json'),JSON.stringify({...settings,maskKey:null}));
    }
    const options={bakeDir:dir,planet:{body:{radiusKm}},sketchFingerprint,level,cells,tileSide:width,nodeRes,leafLod};
    const terrain=await createPackageTerrain(options);
    const raw=await readFile(join(dir,'crop-f0l1x0y0','output.elev'));
    let expected=Float32Array.from(new Float32Array(raw.buffer,raw.byteOffset,raw.length/4)),side=width;
    for(let lod=leafLod;lod>=level;lod--) {
        const got=await terrain.extendedTile(0,0,0,lod);
        assert.equal(got.span,side+2);assert.equal(got.covered,true);
        for(let y=0;y<side;y++)for(let x=0;x<side;x++)assert.equal(got.ext[(y+1)*got.span+x+1],expected[y*side+x]);
        if(lod>level){expected=reduceInterior(expected,side);side/=2;}
    }
    const marker=join(dir,'crop-f0l1x0y0','seam-complete.json');
    await writeFile(marker,JSON.stringify({...settings,sketchFingerprint:'stale',maskKey:null}));
    await assert.rejects(createPackageTerrain(options),/Unfinalized package source/);
    await writeFile(marker,JSON.stringify({...settings,maskKey:null}));
    await assert.rejects(createPackageTerrain({...options,sketchFingerprint:'other'}),/Package inputs differ/);

    // Precision metadata must agree at the campaign, DEM and finalizer.
    // Legacy sources remain readable but cannot be relabelled as corrected.
    settings.heightEncoding=HEIGHT_ENCODING;
    await writeFile(join(dir,'campaign-settings.json'),JSON.stringify(settings));
    await assert.rejects(createPackageTerrain(options),/encoding differs/);
    for(const name of all) {
        await writeFile(join(dir,'crop-'+name,'output.elev.json'),JSON.stringify({width,height:width,heightEncoding:HEIGHT_ENCODING}));
        await writeFile(join(dir,'crop-'+name,'seam-complete.json'),JSON.stringify({...settings,maskKey:null}));
    }
    await createPackageTerrain(options);
    await writeFile(marker,JSON.stringify({...settings,heightEncoding:undefined,maskKey:null}));
    await assert.rejects(createPackageTerrain(options),/encoding differs/);
    await writeFile(marker,JSON.stringify({...settings,maskKey:null}));

    // A mask-skipped tile must use exactly the campaign's spherical seabed,
    // even if an unrelated old DEM happens to exist at its tile path.
    const skipped='f0l1x0y0',maskKey='fine-fixture';
    await writeFile(join(dir,'fine-mask.json'),JSON.stringify({level,sketchFingerprint,maskKey,tiles:all.filter(n=>n!==skipped)}));
    for(let face=0;face<6;face++) {
        const rect=Cube.tileBakeRect({face,level:0,i:0,j:0},8,6),base=Array(rect.width*rect.height).fill(-1700);
        await writeFile(join(dir,`face-${face}-mask.json`),JSON.stringify({face,rect,base,weight:base.map(()=>0)}));
    }
    for(const name of all)await writeFile(join(dir,'crop-'+name,'seam-complete.json'),JSON.stringify({...settings,maskKey}));
    const masked=await createPackageTerrain(options),ocean=await masked.extendedTile(0,0,0,leafLod);
    assert.equal(ocean.covered,false);
    for(let y=0;y<width;y++)for(let x=0;x<width;x++)assert.equal(ocean.ext[(y+1)*ocean.span+x+1],-1700);
    await writeFile(join(dir,'crop-f1l1x0y0','output.elev'),new Uint8Array(4));
    await assert.rejects(createPackageTerrain(options),/Truncated package source/);
    console.log('package terrain: exact interior mip chain; stale, mismatched and truncated sources rejected; masked ocean uses shared fallback');
} finally {
    const target=resolve(dir);
    assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('planetgen-package-terrain-'));
    await rm(target,{recursive:true,force:true});
}
