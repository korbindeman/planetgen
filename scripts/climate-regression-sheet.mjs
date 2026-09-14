/** Before/after climate on exactly the same generated geography. CPU only. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import Module,{createRequire} from 'node:module';
import {resolveRun} from './project-run.mjs';
import {prepareClimate} from './finish-climate.mjs';
import {climateView} from './climate-view.mjs';
const require=createRequire(import.meta.url),P=require('../src/planet'),Projects=require('../src/projects'),G=require('../src/climate-grid'),D=require('../src/climate-downscale'),A=require('../src/climate-artifact'),R=require('../src/software-render'),Td=require('../src/td-export');
const args=Object.fromEntries(process.argv.slice(2).map(s=>{const [key,...value]=s.replace(/^--/,'').split('=');return [key,value.join('=')];}));
if(!args.before)throw Error('--before must name the recorded previous solver source');
const oldSource=await readFile(args.before,'utf8'),oldPath=require.resolve('../src/seasonal-climate'),module=new Module(oldPath);
module.filename=oldPath;module.paths=Module._nodeModulePaths(dirname(oldPath));module._compile(oldSource,oldPath);
const Old=module.exports,seeds=(args.seeds||'1,2,3,4,5,6,7,8,9,10,11,12').split(',').map(Number),out=resolve(args.out||'work/climate/improvement-sheet');
const maps={before:[],after:[]},globes={before:[],after:[]},report=[];
await mkdir(out,{recursive:true});
for(const seed of seeds) {
    const run=await resolveRun(process.cwd(),Projects,args.project,seed),planet=P.generatePlanet({...run,detailPass:true,quiet:true});
    const fingerprint=createHash('sha256').update(JSON.stringify(planet.config)).update(Buffer.from(planet.map.r_meters.buffer)).digest('hex');
    const directory=join(out,String(seed));await mkdir(directory,{recursive:true});
    const after=await prepareClimate(planet,fingerprint,directory,{},()=>{}),grid=G.makeGrid(after.coarse.options.climateCells,planet.body.radiusKm);
    const oldOptions={...Old.DEFAULTS,climateCells:after.coarse.options.climateCells};
    const previous=Old.run({grid,...G.terrainFromPlanet(grid,planet)},planet.body,oldOptions);
    if(!previous.diagnostics.converged)throw Error(`Previous model did not converge on seed ${seed}`);
    const packed=A.encode(previous,fingerprint);await writeFile(join(directory,'before.json'),JSON.stringify(packed));
    const before=D.downscale(A.decode(packed),planet),{planet:view,remap}=climateView(planet);
    for(const [label,climate] of [['before',before],['after',after.fine]]) {
        view.map.r_temperature=Float32Array.from(remap(climate.annual.temperature),v=>(v-Td.TEMP_OFFSET)/Td.TEMP_SCALE);
        view.map.r_moisture=Float32Array.from(remap(climate.annual.precipitation),v=>Math.pow(Math.max(0,Math.min(1,(v-Td.PRECIP_MIN)/Td.PRECIP_RANGE)),1/Td.PRECIP_POWER));
        P.assignTriangleValues(view.mesh,view.map);view.geometry=P.buildQuadGeometry(view.mesh,view.map);
        const map=R.captureEquirect(view,{overlay:'climate'}),globe=R.captureGlobe(view,{overlay:'climate'});
        await writeFile(join(directory,`map-${label}.png`),map);await writeFile(join(directory,`globe-${label}.png`),globe);
        maps[label].push({seed,png:map});globes[label].push({seed,png:globe});
    }
    report.push({seed,body:planet.body,sourceFingerprint:fingerprint,before:previous.diagnostics,after:after.coarse.diagnostics,downscale:after.fine.diagnostics});
    console.log(`Seed ${seed}: before ${previous.diagnostics.years} years; after ${after.coarse.diagnostics.years} years / ${after.coarse.diagnostics.elapsedSeconds.toFixed(1)} s`);
}
for(const [name,series] of [['maps',maps],['globes',globes]]) {
    const view=name==='maps'?'equirect':'globe';
    const before=R.seedSheet(series.before,view),after=R.seedSheet(series.after,view);
    await writeFile(join(out,`${name}-before.png`),before);await writeFile(join(out,`${name}-after.png`),after);
    await writeFile(join(out,`${name}-compare.png`),R.compareSheet(before,after,{left:'Previous seasonal climate',right:'Improved seasonal climate'}));
}
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
