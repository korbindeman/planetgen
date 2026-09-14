/** Run the spherical finalizer on a sub-metre source and corrupt each stamp.
 * Independent raw fixtures avoid a model/GPU dependency and preserve real IO. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createRequire} from 'node:module';
import {HEIGHT_ENCODING} from './terrain-encoding.mjs';
const require=createRequire(import.meta.url),Cube=require('../src/cubesphere');
const root=await mkdtemp(join(tmpdir(),'planetgen-finalizer-precision-'));
const dir=join(root,'preview','fixture','v','v1'),name='f0l3x4y4',folder=join(dir,'crop-'+name);
const tile=Cube.parseTileName(name),rect=Cube.tileBakeRect(tile,14,1),ppc=4;
const settings={seamMode:'symmetric',blendKm:64,radiusKm:1593,level:3,sketchFingerprint:'precision-fixture',heightEncoding:HEIGHT_ENCODING};
const meta={...tile,name,cells:rect.width,bakeHeight:rect.height,tileCells:14,pxPerCell:ppc,
    bakeStep:rect.step,originI:rect.originI,originJ:rect.originJ,
    sketchFingerprint:settings.sketchFingerprint,heightEncoding:HEIGHT_ENCODING};
const size={width:rect.width*ppc,height:rect.height*ppc,heightEncoding:HEIGHT_ENCODING};
const complete={sketchFingerprint:settings.sketchFingerprint,heightEncoding:HEIGHT_ENCODING};
const records={'tile.json':meta,'raw.elev.json':size,'campaign-complete.json':complete};
async function run() {
    const child=Bun.spawn([process.execPath,join(import.meta.dir,'blend-campaign.mjs'),'--project=fixture','--variant=v1',`--tiles=${name}`,'--paint=false'],{cwd:root,stdout:'pipe',stderr:'pipe'});
    const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    return {out,err,code};
}
try {
    await mkdir(folder,{recursive:true});
    await writeFile(join(dir,'campaign-settings.json'),JSON.stringify(settings));
    for(const [file,record] of Object.entries(records))await writeFile(join(folder,file),JSON.stringify(record));
    const raw=Float32Array.from({length:size.width*size.height},(_,k)=>(k%size.width+.5-size.width/2)*.00001);
    await writeFile(join(folder,'raw.elev'),Buffer.from(raw.buffer));
    let result=await run();assert.equal(result.code,0,result.err);
    const bytes=await readFile(join(folder,'output.elev'));
    const values=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);
    assert(values.some(z=>z>0)&&values.some(z=>z<0),'Finalizer erased shoreline signs');
    assert(values.every(z=>Math.abs(z)<.001),'Finalizer enlarged the source relief');
    for(const file of ['output.elev.json','seam-complete.json'])
        assert.equal(JSON.parse(await readFile(join(folder,file),'utf8')).heightEncoding,HEIGHT_ENCODING);
    const done=await readFile(join(folder,'seam-complete.json'));
    for(const [file,record] of Object.entries(records)) {
        await writeFile(join(folder,file),JSON.stringify({...record,heightEncoding:undefined}));
        result=await run();assert.notEqual(result.code,0);assert.match(result.err,/encoding differs/);
        assert.deepEqual(await readFile(join(folder,'output.elev')),bytes,'Rejected input changed finalized terrain');
        assert.deepEqual(await readFile(join(folder,'seam-complete.json')),done,'Rejected input changed its completion');
        await writeFile(join(folder,file),JSON.stringify(record));
    }
    console.log('Terrain finalizer: real spherical sampling preserves sub-metre signs and stamps; mixed metadata/completion/raster inputs fail without changing output');
} finally {
    const target=resolve(root);
    assert(target.startsWith(resolve(tmpdir())+sep)&&target.split(sep).at(-1).startsWith('planetgen-finalizer-precision-'));
    await rm(target,{recursive:true,force:true});
}
