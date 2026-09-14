/** Write an isolated conditioning import for a one-cell CPU terrain trial. */
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {resolveRun} from './project-run.mjs';
import {loadSavedPlanet} from './saved-planet.mjs';
import {prepareClimate} from './finish-climate.mjs';
import {writeTdFolder} from './td-geotiff.mjs';
const require=createRequire(import.meta.url),Projects=require('../src/projects'),Cube=require('../src/cubesphere'),Td=require('../src/seasonal-td'),Render=require('../src/software-render');
const args=Object.fromEntries(process.argv.slice(2).map(s=>s.replace(/^--/,'').split('=')));
const root=process.cwd(),out=resolve(args.out||'work/climate/terrain-trial');
const run=await resolveRun(root,Projects,args.project,null,args.variant);
if(!run.variant)throw new Error('A saved variant is required');
const {planet,fingerprint}=await loadSavedPlanet(root,run.project,run.variant);
const climate=await prepareClimate(planet,fingerprint,out);
let chosen=-1;
for(let r=0;r<planet.mesh.numRegions;r++)if(planet.map.r_meters[r]>400&&planet.map.r_meters[r]<1200&&climate.fine.annual.temperature[r]>10&&climate.fine.annual.precipitation[r]>700){chosen=r;break;}
if(chosen<0)throw new Error('No temperate or warm wet trial cell');
const xyz=Array.from(planet.map.r_xyz.subarray(chosen*3,chosen*3+3)),ll=Cube.xyzToLonLat(xyz),tile=Cube.tileAt(ll.lon,ll.lat,3);
const cells=Cube.tileCells(3,planet.body.radiusKm,23),face={face:tile.face,level:0,i:0,j:0},rect=Cube.tileBakeRect(face,8*cells,64,null);
const pixel=Cube.bakePixel(face,rect,xyz),row=Math.floor(pixel.y),col=Math.floor(pixel.x),layers=Td.layersForBakeRect(planet,climate.fine,face,rect);
const origin_i=-(rect.originJ+rect.height),origin_j=rect.originI;
await mkdir(out,{recursive:true});await writeTdFolder(join(out,'conditioning'),layers,Cube.tileBBox(face));
const start_i=origin_i+row,start_j=origin_j+col,k=row*rect.width+col;
await writeFile(join(out,'trial.json'),JSON.stringify({climateKey:climate.key,sourceFingerprint:fingerprint,origin_i,origin_j,start_i,start_j,width:1,height:1,lon:ll.lon,lat:ll.lat,
 expected:Object.fromEntries(['heightmap','temperature','temperature_std','precipitation','precipitation_cv'].map(key=>[key,layers[key][k]]))},null,2));
console.log(out);
