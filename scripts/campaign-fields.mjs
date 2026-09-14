import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Mask=require('../src/campaign-mask');
const {faceWeights}=require('../src/campaign-seam');

export async function readFineMask(dir,settings) {
    const text=await readFile(join(dir,'fine-mask.json'),'utf8').catch(err=>{
        if(err.code==='ENOENT') return null; throw err;
    });
    if(!text) return null;
    const manifest=JSON.parse(text);
    if(manifest.sketchFingerprint!==settings.sketchFingerprint||manifest.level!==settings.level)
        throw new Error('Fine mask belongs to different campaign inputs');
    const faces=[];
    for(let face=0;face<6;face++) {
        const f=JSON.parse(await readFile(join(dir,`face-${face}-mask.json`),'utf8'));
        if(f.base.length!==f.rect.width*f.rect.height||f.weight.length!==f.base.length)
            throw new Error('Truncated face mask '+face);
        f.base=Float32Array.from(f.base);f.weight=Float32Array.from(f.weight);faces.push(f);
    }
    const band=Math.SQRT2*Math.sin(settings.blendKm/settings.radiusKm);
    return {...manifest,tiles:new Set(manifest.tiles),faces,
        base(d,weights=faceWeights(d,band)) {
            return weights.reduce((z,w)=>z+w.weight*Mask.sample(faces[w.face],d,'base'),0);
        }};
}
