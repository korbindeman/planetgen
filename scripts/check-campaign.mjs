import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {loadUserProjects} from './td-projects.mjs';
import {loadSavedPlanet} from './saved-planet.mjs';
const require=createRequire(import.meta.url);
const Cube=require('../src/cubesphere'),Tile=require('../src/td-tile');
const {faceWeights,sourceTile,sourcesForTile}=require('../src/campaign-seam');
const Projects=require('../src/projects'),Shape=require('../src/shape-artifact');
const radius=1593,blendKm=64,band=Math.SQRT2*Math.sin(blendKm/radius),level=3;
const cells=Cube.tileCells(level,radius,23);
const halo=Math.ceil(blendKm/(Cube.tileEdgeKm(level,radius)/cells)*1.6)+1;
const normalize=d=>{const r=Math.hypot(...d);return d.map(v=>v/r);};
let samples=0;
for(let face=0;face<6;face++) for(let y=-2;y<=34;y++) for(let x=-2;x<=34;x++) {
 const d=Cube.faceDirection(face,x/16-1,y/16-1),ws=faceWeights(d,band);
 assert(Math.abs(ws.reduce((s,v)=>s+v.weight,0)-1)<1e-12);
 assert(ws.length>=1&&ws.length<=3);
 for(const w of ws) {
  const t=sourceTile(w.face,d,level);
  const rect=Cube.tileBakeRect(t,cells,1,Tile.haloCellsFor(t,halo));
  const p=Cube.bakePixel(t,rect,d);
  assert(p.x>2/256&&p.x<rect.width-2/256&&p.y>2/256&&p.y<rect.height-2/256,'Raw overlap must cover every contributing face');
 }
 samples++;
}
// Unequal independent face fields expose a join hidden by testing one shared
// analytic height function. Their composite must remain continuous at all folds.
const field=d=>faceWeights(d,band).reduce((z,w)=>z+w.weight*(w.face*500+Math.sin(53*d[0]+31*d[1])*100),0);
for(let sx of [-1,1]) for(let sy of [-1,1]) for(let sz of [-1,1]) {
 for(const t of [0,.5,1]) {
  const d=normalize([sx,sy,sz*t]),h=1e-6;
  const l=field(normalize([d[0]-h,d[1],d[2]]));
  const m=field(d),r=field(normalize([d[0]+h,d[1],d[2]]));
  assert(Math.abs(r-l)<.2,'Fold height jump');
  assert(Math.abs(r-2*m+l)<1e-4,'Fold slope crease');
 }
}
await loadUserProjects(process.cwd(),Projects);
for(let face=0;face<6;face++)for(let j=0;j<8;j++)for(let i=0;i<8;i++) {
 const tile={face,level:3,i,j},sources=sourcesForTile(tile,3584,band);
 for(let y=0;y<=16;y++)for(let x=0;x<=16;x++) {
  const d=Cube.tileDirection(tile,(.5+3583*x/16)/3584,(.5+3583*y/16)/3584);
  for(const w of faceWeights(d,band))assert(sources.has(Cube.tileName(sourceTile(w.face,d,3))),'Source bounds omit a contributing raw field');
 }
}
const id='v1788487334818';
const {planet}=await loadSavedPlanet(process.cwd(),'quarter',id);
const stored=Shape.toFields(JSON.parse(await readFile(`preview/quarter/v/${id}/shape.json`,'utf8')));
assert.equal(planet.config.shapeSeed,1226542989);
for(const name of ['r_meters','r_elevation','r_moisture','r_temperature','r_drainTo'])
 if(stored[name]) assert.deepEqual(planet.map[name],stored[name],`Saved ${name} changed during loading`);
console.log(`campaign: ${samples} overlap samples; fold/corner continuity; saved Glep fields and distinct shape seed preserved`);
