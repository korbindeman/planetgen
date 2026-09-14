import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Mask=require('../src/campaign-mask');
// A coast diagonal to the lattice, with clipped/negative job origins. All
// jobs must be windows of one square partition, not independently tiled.
const field={windowCells:2,rect:{width:96,height:96,originI:-48,originJ:-48},
  weight:Float32Array.from({length:96*96},(_,k)=>Math.max(0,Math.min(1,(k%96+Math.floor(k/96)-70)/7)))};
const owners=new Map();let requests=0;
for(let i=-32;i<32;i+=7)for(let j=-32;j<32;j+=9) {
 const rect={originI:j,originJ:i,width:17,height:19};
 const windows=Mask.windows(field,rect);requests+=windows.length;
 for(const w of windows) {
  assert(w.w===w.h&&[2,4,8].includes(w.w));
  const key=`${w.i}/${w.j}/${w.w}`;
  for(let y=w.i;y<w.i+w.h;y++)for(let x=w.j;x<w.j+w.w;x++) {
   const pixel=`${y}/${x}`;
   if(owners.has(pixel)) assert.equal(owners.get(pixel),key,'Overlapping jobs changed their model query');
   owners.set(pixel,key);
  }
 }
}
console.log(`mask: ${requests} square requests share one global partition across clipped job boundaries`);
