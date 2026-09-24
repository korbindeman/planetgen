/* End-to-end writer check: a synthetic Float32 campaign through
 * createPackageTerrain and buildPackage, read back by the independent reader.
 * The field crosses sea level with sub-metre relief, so metre rounding alone
 * would move the coastline. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createRequire} from 'node:module';
import {HEIGHT_ENCODING} from './terrain-encoding.mjs';
import {createPackageTerrain} from './package-terrain.mjs';
import {buildPackage} from './package-build.mjs';
import {quantizeNode,decodeNode} from './package-encoding.mjs';
import {openPlanet,reconstruct,nodeHeights,validatePlanet} from './read-planet.mjs';
const require=createRequire(import.meta.url),Cube=require('../src/cubesphere');

const width=32,level=1,cells=4,nodeRes=4,leafLod=4,radiusKm=1593,band=64,errorM=12;
const sketchFingerprint='build-fixture',stride=nodeRes+2;
// Sub-metre coasts near the equator, relief well outside the band near the poles.
const field=d=>0.9*Math.sin(9*d[0]+2*d[2])+0.6*Math.cos(7*d[1])-0.2+400*d[2]**3;

const dir=await mkdtemp(join(tmpdir(),'planetgen-package-build-'));
try {
    const settings={seamMode:'symmetric',level,cells,pxPerCell:width/cells,radiusKm,blendKm:64,
        sketchFingerprint,heightEncoding:HEIGHT_ENCODING};
    await writeFile(join(dir,'campaign-settings.json'),JSON.stringify(settings));
    for(let face=0;face<6;face++)for(let j=0;j<2;j++)for(let i=0;i<2;i++) {
        const tile={face,level,i,j},folder=join(dir,'crop-'+Cube.tileName(tile));
        await mkdir(folder);const values=new Float32Array(width*width);
        for(let y=0;y<width;y++)for(let x=0;x<width;x++)values[y*width+x]=field(Cube.tileDirection(tile,(x+.5)/width,(y+.5)/width));
        await writeFile(join(folder,'output.elev'),Buffer.from(values.buffer));
        await writeFile(join(folder,'output.elev.json'),JSON.stringify({width,height:width,heightEncoding:HEIGHT_ENCODING}));
        await writeFile(join(folder,'seam-complete.json'),JSON.stringify({...settings,maskKey:null}));
    }
    const terrain=await createPackageTerrain({bakeDir:dir,planet:{body:{radiusKm}},sketchFingerprint,
        level,cells,tileSide:width,nodeRes,leafLod});
    const outPath=join(dir,'fixture.planet');
    const stats=await buildPackage({terrain,outPath,level,nodeRes,leafLod,denseLod:2,absoluteLod:2,
        errorM,fractionBandM:band,identity:{body:'fixture',variant:'v-test',seed:1,radius_m:radiusKm*1000,
            tile_cells:cells,sketch_fingerprint:sketchFingerprint}});
    const report=validatePlanet(outPath);
    assert.equal(report.nodes,stats.nodes);assert.equal(report.fractional,stats.fractional);
    assert.ok(stats.pruned>0&&stats.fractional>0&&stats.fractional<stats.nodes,JSON.stringify(stats));

    const planet=openPlanet(outPath);
    try {
        assert.equal(planet.version,2);
        assert.deepEqual(planet.manifest.height_fraction,{encoding:'int8-centimetres-v1',band_m:band,sea_level_m:0});
        assert.equal(planet.manifest.pruning.method,'bilinear-subtree-v2');
        // The Float32 source of a tile-subtree node, skirt included.
        const source=async(face,lod,x,y)=>{
            const scale=1<<(lod-level),n=1<<level,ti=Math.floor(x/scale),tj=n-1-Math.floor(y/scale);
            const {ext,span}=await terrain.extendedTile(face,ti,tj,lod),out=new Float32Array(stride*stride);
            const sx=x%scale,sy=y%scale;
            for(let r=0;r<stride;r++)out.set(ext.subarray((sy*nodeRes+r)*span+sx*nodeRes,(sy*nodeRes+r)*span+sx*nodeRes+stride),r*stride);
            return out;
        };
        const upsample=(parent,qx,qy)=>{
            const out=new Float64Array(stride*stride),half=nodeRes/2;
            const p=(x,y)=>parent[Math.min(nodeRes+1,Math.max(0,y+1))*stride+Math.min(nodeRes+1,Math.max(0,x+1))];
            for(let y=-1;y<=nodeRes;y++)for(let x=-1;x<=nodeRes;x++) {
                const fx=qx*half+(x+.5)/2-.5,fy=qy*half+(y+.5)/2-.5,x0=Math.floor(fx),y0=Math.floor(fy),tx=fx-x0,ty=fy-y0;
                out[(y+1)*stride+x+1]=p(x0,y0)*(1-tx)*(1-ty)+p(x0+1,y0)*tx*(1-ty)+p(x0,y0+1)*(1-tx)*ty+p(x0+1,y0+1)*tx*ty;
            }
            return out;
        };
        let checked=0,roundingFlips=0,present=new Set(planet.index.keys());
        for(const [key,entry] of planet.index) {
            const [face,lod,x,y]=key.split('/').map(Number);
            const heights=nodeHeights(planet,face,lod,x,y);
            if(lod>0) {
                const parent=nodeHeights(planet,face,lod-1,x>>1,y>>1),child=upsample(parent,x&1,y&1);
                let worst=0;for(let k=0;k<heights.length;k++)worst=Math.max(worst,Math.abs(heights[k]-child[k]));
                assert.ok(worst<=entry.predictorErrorM,`${key}: ${worst} exceeds declared ${entry.predictorErrorM} m`);
            }
            if(lod<level)continue;
            const src=await source(face,lod,x,y),expected=quantizeNode(src,band);
            assert.deepEqual([...reconstruct(planet,face,lod,x,y)],[...expected.metres],`${key}: metre channel`);
            assert.deepEqual([...heights],[...decodeNode(expected.metres,expected.centimetres)],`${key}: heights`);
            for(let k=0;k<src.length;k++) {
                const h=src[k],limit=Math.abs(h)<band?0.01:0.5;
                assert.ok(Math.abs(heights[k]-h)<=limit+1e-9,`${key}[${k}]: ${heights[k]} for ${h}`);
                assert.equal(heights[k]>0,h>0,`${key}[${k}]: ${heights[k]} changes the side of sea level of ${h}`);
                if((Math.round(h)>0)!==(h>0))roundingFlips++;
            }
            checked++;
        }
        // An absent leaf is described by its retained ancestor: within the
        // prune budget of the source and on the same side of sea level.
        let absent=0;
        const n=1<<leafLod;
        for(let face=0;face<6;face++)for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
            if(present.has(`${face}/${leafLod}/${x}/${y}`))continue;
            let a=leafLod;while(!present.has(`${face}/${a}/${x>>(leafLod-a)}/${y>>(leafLod-a)}`))a--;
            const s=1<<(leafLod-a),ax=x>>(leafLod-a),ay=y>>(leafLod-a),anc=nodeHeights(planet,face,a,ax,ay);
            const P=(i,j)=>anc[Math.min(nodeRes+1,Math.max(0,j+1))*stride+Math.min(nodeRes+1,Math.max(0,i+1))];
            const src=await source(face,leafLod,x,y);
            for(let py=0;py<nodeRes;py++)for(let px=0;px<nodeRes;px++) {
                const fx=((x-ax*s)*nodeRes+px+.5)/s-.5,fy=((y-ay*s)*nodeRes+py+.5)/s-.5;
                const x0=Math.floor(fx),y0=Math.floor(fy),tx=fx-x0,ty=fy-y0;
                const h=P(x0,y0)*(1-tx)*(1-ty)+P(x0+1,y0)*tx*(1-ty)+P(x0,y0+1)*(1-tx)*ty+P(x0+1,y0+1)*tx*ty;
                const want=src[(py+1)*stride+px+1];
                assert.ok(Math.abs(h-want)<=errorM,`pruned ${face}/${x}/${y}`);
                assert.equal(h>0,want>0,`pruned ${face}/${x}/${y} changes land and water`);
            }
            absent++;
        }
        assert.ok(roundingFlips>0,'the fixture must contain heights that metre rounding would misclassify');
        console.log(`package build: ${stats.nodes} nodes (${stats.fractional} with centimetres, ${stats.pruned} pruned);`
            +` ${checked} nodes match their Float32 source, ${absent} absent leaves certified;`
            +` metre rounding alone would have moved ${roundingFlips} samples across sea level`);
    } finally {planet.close();}
} finally {
    const target=resolve(dir);
    assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('planetgen-package-build-'));
    await rm(target,{recursive:true,force:true});
}
