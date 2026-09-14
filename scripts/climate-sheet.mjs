/** A multi-seed visual check, in an isolated output directory. No terrain bake. */
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {resolveRun} from './project-run.mjs';
import {prepareClimate} from './finish-climate.mjs';
import {climateView} from './climate-view.mjs';
const require=createRequire(import.meta.url),P=require('../src/planet'),Projects=require('../src/projects'),R=require('../src/software-render'),Td=require('../src/td-export');
const args=Object.fromEntries(process.argv.slice(2).map(s=>s.replace(/^--/,'').split('='))),out=resolve(args.out||'work/climate/sheet');
const seeds=(args.seeds||'1,2,3,4,5,6,7,8,9,10,11,12').split(',').map(Number),maps=[],globes=[],reports=[];
await mkdir(out,{recursive:true});
for(const seed of seeds) {
 const run=await resolveRun(process.cwd(),Projects,args.project,seed),planet=P.generatePlanet({...run,detailPass:true,quiet:true});
 const fingerprint=createHash('sha256').update(JSON.stringify(planet.config)).update(Buffer.from(planet.map.r_meters.buffer)).digest('hex');
 const prepared=await prepareClimate(planet,fingerprint,join(out,String(seed)),{},()=>{}),{planet:view,remap}=climateView(planet);
 view.map.r_temperature=Float32Array.from(remap(prepared.fine.annual.temperature),v=>(v-Td.TEMP_OFFSET)/Td.TEMP_SCALE);
 view.map.r_moisture=Float32Array.from(remap(prepared.fine.annual.precipitation),v=>Math.pow(Math.max(0,Math.min(1,(v-Td.PRECIP_MIN)/Td.PRECIP_RANGE)),1/Td.PRECIP_POWER));
 P.assignTriangleValues(view.mesh,view.map);view.geometry=P.buildQuadGeometry(view.mesh,view.map);
 const map=R.captureEquirect(view,{overlay:'climate'}),globe=R.captureGlobe(view,{overlay:'climate'});
 await writeFile(join(out,String(seed),'map.png'),map);await writeFile(join(out,String(seed),'globe.png'),globe);
 maps.push({seed,png:map});globes.push({seed,png:globe});reports.push({seed,key:prepared.key,solver:prepared.coarse.diagnostics,downscale:prepared.fine.diagnostics});
 console.log(`Seed ${seed}: ${prepared.coarse.diagnostics.years} years, ${prepared.coarse.diagnostics.elapsedSeconds.toFixed(1)} s`);
}
await writeFile(join(out,'maps.png'),R.seedSheet(maps,'equirect'));await writeFile(join(out,'globes.png'),R.seedSheet(globes,'globe'));
await writeFile(join(out,'report.json'),JSON.stringify(reports,null,2));
