/** Run the real campaign control flow in a temporary directory with a fake
 * terrain worker. The separate CPU trial exercises the actual terrain model. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {HEIGHT_ENCODING} from './terrain-encoding.mjs';
const key='a'.repeat(64);
if(process.argv[2]==='--child') {
 const {mock}=await import('bun:test'),require=createRequire(import.meta.url),G=require('../src/climate-grid'),T=require('../src/tectonics');
 const dir=resolve(process.argv[3]),flags=process.argv.slice(4),grid=G.makeGrid(1600,1593);
 const map={r_xyz:grid.xyz,r_elevation:new Float32Array(grid.n).fill(T.metersToElevation(500)),r_temperature:new Float32Array(grid.n).fill(.5),r_moisture:new Float32Array(grid.n).fill(.5)};
 const annual=Object.fromEntries([['temperature',17],['temperature_std',3],['precipitation',900],['precipitation_cv',40]].map(([k,v])=>[k,new Float32Array(grid.n).fill(v)]));
 mock.module('./project-run.mjs',()=>({resolveRun:async()=>({project:'fixture',variant:'fixture',seed:211})}));
 mock.module('./saved-planet.mjs',()=>({loadSavedPlanet:async()=>({planet:{mesh:grid.mesh,map,body:{radiusKm:1593}},fingerprint:'saved-shape'})}));
 mock.module('./td-overlays.mjs',()=>({projectBakeDir:()=>dir}));
 mock.module('./finish-climate.mjs',()=>({prepareClimate:async()=>({key,coarse:{version:'seasonal-1',diagnostics:{converged:true}},fine:{annual}})}));
 mock.module('./td-jobs.mjs',()=>({tdWsl:()=>true,toWslPath:p=>p,stopTdWorker:async()=>{},finishBake:()=>{throw Error('Unexpected legacy finalizer');},runOnWorker:async(root,spec,job,request)=>{
   await mkdir(dir,{recursive:true});
   const marker=join(dir,'worker-calls.json'),calls=JSON.parse(await readFile(marker,'utf8').catch(()=> '[]'));calls.push(request.op);await writeFile(marker,JSON.stringify(calls));
   if(request.op==='generate') {
     assert(resolve(request.output_elev).startsWith(dir+require('path').sep));
     const a=new Float32Array(request.w*request.h).fill(500);
     await writeFile(request.output_elev,Buffer.from(a.buffer));await writeFile(request.output_elev+'.json',JSON.stringify({width:request.w,height:request.h,heightEncoding:HEIGHT_ENCODING}));
   }
   return {ok:true};
 }}));
 process.argv=['bun','bake-campaign.mjs','--project=fixture','--variant=fixture','--level=3','--seam=symmetric','--px-per-cell=1','--tiles=f0l3x1y1',...flags];
 await import('./bake-campaign.mjs');
} else {
 const dir=await mkdtemp(join(tmpdir(),'planetgen-campaign-climate-'));
 async function run(...flags) {
   const proc=Bun.spawn([process.execPath,import.meta.path,'--child',dir,...flags],{stdout:'pipe',stderr:'pipe'});
   const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
   return {out,err,code};
 }
 let result=await run('--dry-run');assert.equal(result.code,0,result.err);assert.match(result.out,/climate seasonal/);
 assert.equal(await stat(join(dir,'campaign-settings.json')).catch(()=>null),null);
 result=await run();assert.equal(result.code,0,result.err);
 const settingsPath=join(dir,'campaign-settings.json'),settingsText=await readFile(settingsPath,'utf8'),settings=JSON.parse(settingsText);
 assert.equal(settings.climate.key,key);
 for(const name of ['tile.json','campaign-complete.json'])assert.equal(JSON.parse(await readFile(join(dir,'crop-f0l3x1y1',name),'utf8')).climate.key,key);
 assert.deepEqual(JSON.parse(await readFile(join(dir,'worker-calls.json'),'utf8')),['import','generate']);
 result=await run();assert.equal(result.code,0,result.err);assert.match(result.out,/1 already baked/);
 assert.deepEqual(JSON.parse(await readFile(join(dir,'worker-calls.json'),'utf8')),['import','generate']);
 result=await run('--climate=preview','--force');assert.notEqual(result.code,0);assert.match(result.err,/new variant/);
 assert.equal(await readFile(settingsPath,'utf8'),settingsText);
 console.log('Campaign dry run writes nothing; new bake stamps seasonal; resume skips matching tiles; mode change with --force fails before worker');
}
