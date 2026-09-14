#!/usr/bin/env bun
/** Finalize overlapping raw face bakes into one continuous spherical field.
 * bun scripts/blend-campaign.mjs --project=quarter --variant=v... --tiles=...
 * Raw bake planes are immutable; rerunning never blends an already blended DEM.
 */
import {createRequire} from 'node:module';
import {readFile,writeFile,rename,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {readFineMask} from './campaign-fields.mjs';
import {paintCropTerrain} from './paint-td-terrain.mjs';
import {assertHeightEncoding} from './terrain-encoding.mjs';
const require=createRequire(import.meta.url);
const Cube=require('../src/cubesphere'), Seam=require('../src/td-seam');
const {faceWeights,sourceTile,sourcesForTile}=require('../src/campaign-seam');
const Mask=require('../src/campaign-mask');
const args=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split('=')));
if(!args.project||!/^v\d+$/.test(args.variant||'')) throw new Error('Pass --project and --variant');
const dir=resolve('preview',args.project,'v',args.variant);
const manifest=JSON.parse(await readFile(join(dir,'campaign-settings.json'),'utf8'));
assertHeightEncoding(manifest,manifest.heightEncoding,'Campaign');
if(manifest.seamMode!=='symmetric') throw new Error('Campaign has no overlapping raw face fields');
const band=Math.SQRT2*Math.sin(manifest.blendKm/manifest.radiusKm);
const fine=await readFineMask(dir,manifest);
const all=(await readdir(dir)).filter(n=>n.startsWith('crop-'));
const names=args.tiles?args.tiles.split(','):(fine?[...fine.tiles]:all.map(n=>n.slice(5)));
const cache=new Map();
async function load(name) {
 if(cache.has(name)) return cache.get(name);
 if(fine&&!fine.tiles.has(name)) {cache.set(name,null);return null;}
 const folder=join(dir,'crop-'+name);
 const meta=JSON.parse(await readFile(join(folder,'tile.json'),'utf8'));
 const complete=JSON.parse(await readFile(join(folder,'campaign-complete.json'),'utf8'));
 if(complete.sketchFingerprint!==manifest.sketchFingerprint) throw new Error('Different sketch on '+name);
 if(meta.maskKey&&meta.maskKey!==fine?.maskKey) throw new Error('Different fine mask on '+name);
 const size=JSON.parse(await readFile(join(folder,'raw.elev.json'),'utf8'));
 for(const record of [meta,complete,size])assertHeightEncoding(record,manifest.heightEncoding,name);
 const buf=await readFile(join(folder,'raw.elev'));
 if(buf.length!==size.width*size.height*4) throw new Error('Truncated raw field '+name);
 const src={meta,size,data:new Float32Array(buf.buffer,buf.byteOffset,buf.byteLength/4)};
 cache.set(name,src);return src;
}
function sample(src,d) {
 const {meta:m,size:s,data}=src;
 const p=Cube.bakePixel(m,{step:m.bakeStep,originI:m.originI,originJ:m.originJ,width:m.cells,height:m.bakeHeight},d);
 const x=p.x*s.width/m.cells,y=p.y*s.height/m.bakeHeight;
 if(x<2||y<2||x>s.width-2||y>s.height-2) throw new Error('Insufficient raw overlap on '+m.name);
 return Seam.sampleBicubic(data,s.width,s.height,x,y);
}
for(const name of names) {
 cache.clear();
 const tile=Cube.parseTileName(name);if(!tile) throw new Error('Invalid tile '+name);
 const own=await load(name);const side=own.meta.tileCells*own.meta.pxPerCell;
 const need=sourcesForTile(tile,side,band);
 for(const n of need) await load(n);
 const output=new Float32Array(side*side);let blended=0;
 for(let y=0;y<side;y++) for(let x=0;x<side;x++) {
  const d=Cube.tileDirection(tile,(x+.5)/side,(y+.5)/side);
  const weights=faceWeights(d,band);let z=0;
  for(const {face,weight} of weights) {
   const n=Cube.tileName(sourceTile(face,d,tile.level)),src=cache.get(n);
   const f=fine?.faces[face];
   const a=f?Mask.sample(f,d):1;
   if(a<=0) {z+=Mask.sample(f,d,'base')*weight;continue;}
   if(!src) throw new Error('Required source was not loaded: '+n);
   let height=sample(src,d);
   // The unmasked preflight can be reused. Masked raw fields already carry
   // this fade, whereas unmasked ones need it applied exactly once here.
   if(f&&!src.meta.maskKey&&a<1) height=height*a+Mask.sample(f,d,'base')*(1-a);
   z+=height*weight;
  }
  output[y*side+x]=z;if(weights.length>1) blended++;
 }
 const folder=join(dir,'crop-'+name);
 await writeFile(join(folder,'output.elev.tmp'),Buffer.from(output.buffer));
 await rename(join(folder,'output.elev.tmp'),join(folder,'output.elev'));
 await writeFile(join(folder,'output.elev.json'),JSON.stringify({width:side,height:side,heightEncoding:manifest.heightEncoding}));
 if(args.paint!=='false') await paintCropTerrain(folder);
 await writeFile(join(folder,'seam-complete.json'),JSON.stringify({sketchFingerprint:manifest.sketchFingerprint,heightEncoding:manifest.heightEncoding,blendKm:manifest.blendKm,maskKey:fine?.maskKey??null,at:Date.now()}));
 console.log(`${name}: ${blended} pixels share multiple faces`);
}
