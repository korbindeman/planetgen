/** Finish climate validation; all outputs are isolated from active campaigns. */
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {resolveRun} from './project-run.mjs';
import {loadSavedPlanet} from './saved-planet.mjs';
import {prepareClimate} from './finish-climate.mjs';
import {climateView} from './climate-view.mjs';
const require=createRequire(import.meta.url),Planet=require('../src/planet'),Projects=require('../src/projects');
const Render=require('../src/software-render'),Td=require('../src/td-export'),Tectonics=require('../src/tectonics');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=Object.fromEntries(process.argv.slice(2).map(s=>s.replace(/^--/,'').split('=')));
const run=await resolveRun(root,Projects,args.project,args.seed,args.variant);
let planet,fingerprint;
if(run.variant)({planet,fingerprint}=await loadSavedPlanet(root,run.project,run.variant));
else {planet=Planet.generatePlanet({...run,detailPass:true,quiet:true});fingerprint=createHash('sha256').update(JSON.stringify(planet.config)).update(Buffer.from(planet.map.r_meters.buffer)).digest('hex');}
const out=resolve(args.out||`work/climate/${run.project}-${run.variant||run.seed}`);
await mkdir(out,{recursive:true});
const view=climateView(planet),display=view.planet;
const before={globe:Render.captureGlobe(display,{overlay:'climate'}),map:Render.captureEquirect(display,{overlay:'climate'})};
const opts={};if(args.cells)opts.climateCells=Number(args.cells);
const climate=await prepareClimate(planet,fingerprint,out,opts);
const n=planet.mesh.numRegions,monthly=climate.fine.monthly,annual=climate.fine.annual;
function changeFields(t,p) {
    display.map.r_temperature=Float32Array.from(view.remap(t),v=>(v-Td.TEMP_OFFSET)/Td.TEMP_SCALE);
    display.map.r_moisture=Float32Array.from(view.remap(p),v=>Math.pow(Math.max(0,Math.min(1,(v-Td.PRECIP_MIN)/Td.PRECIP_RANGE)),1/Td.PRECIP_POWER));
    Planet.assignTriangleValues(display.mesh,display.map);display.geometry=Planet.buildQuadGeometry(display.mesh,display.map);
}
function physicalMap(t,p) {
    const raw=Planet.rasterizeEquirect(display.mesh,{...display.map,r_temperature:view.remap(t),r_moisture:view.remap(p)},720,360,0);
    return {width:raw.width,height:raw.height,heightmap:Float32Array.from(raw.elev,Tectonics.elevationToMeters),temperature:raw.temp,precipitation:raw.moist};
}
changeFields(annual.temperature,annual.precipitation);
const globe=Render.captureGlobe(display,{overlay:'climate'}),map=Render.captureEquirect(display,{overlay:'climate'});
await writeFile(join(out,'climate-globe.png'),globe);
await writeFile(join(out,'climate-map.png'),map);
await writeFile(join(out,'climate-globe-compare.png'),Render.compareSheet(before.globe,globe,{left:'Preview climate',right:'Seasonal climate'}));
await writeFile(join(out,'climate-map-compare.png'),Render.compareSheet(before.map,map,{left:'Preview climate',right:'Seasonal climate'}));
await writeFile(join(out,'surface-globe.png'),Render.captureGlobe(display));
await writeFile(join(out,'surface-map.png'),Render.captureEquirect(display));
await writeFile(join(out,'annual-fields.png'),Render.drawWorldSheet(physicalMap(annual.temperature,annual.precipitation),[],[]));
const seasons=[];
for(const month of [0,3,6,9]) {
    const t=monthly.temperature.subarray(month*n,(month+1)*n),p=Float32Array.from(monthly.precipitation.subarray(month*n,(month+1)*n),v=>v*12);
    const png=Render.drawWorldSheet(physicalMap(t,p),[],[]);await writeFile(join(out,`month-${month+1}-fields.png`),png);
    seasons.push({seed:`Month ${month+1}, rain annualized`,png});
}
await writeFile(join(out,'seasons.png'),Render.seedSheet(seasons,'equirect'));
function stats(a,landOnly=false) {
    const x=Array.from(a).filter((_,r)=>!landOnly||planet.map.r_elevation[r]>=0).sort((a,b)=>a-b);
    return {min:x[0],p10:x[Math.floor(x.length*.1)],median:x[Math.floor(x.length*.5)],p90:x[Math.floor(x.length*.9)],max:x.at(-1)};
}
const report={source:run,climateKey:climate.key,solver:climate.coarse.diagnostics,downscale:climate.fine.diagnostics,
    land:Object.fromEntries(Object.entries(annual).map(([key,value])=>[key,stats(value,true)]))};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(out);
