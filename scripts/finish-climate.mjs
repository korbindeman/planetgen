/** Prepare physical seasonal climate from immutable saved Layout/Shape inputs.
 * May be imported by a new campaign. No GPU, no terrain output, no global state.
 */
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {loadSavedPlanet} from './saved-planet.mjs';
import {resolveRun} from './project-run.mjs';
const require=createRequire(import.meta.url),Grid=require('../src/climate-grid'),Climate=require('../src/seasonal-climate');
const Artifact=require('../src/climate-artifact'),Downscale=require('../src/climate-downscale'),Projects=require('../src/projects');
const Params=require('../src/params');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const algorithm=createHash('sha256');
for(const file of ['climate-grid.js','seasonal-climate.js','climate-downscale.js','seasonal-td.js','climate-artifact.js'])algorithm.update(await readFile(join(root,'src',file)));
algorithm.update(await readFile(fileURLToPath(import.meta.url)));
const algorithmHash=algorithm.digest('hex');
function checkReady(coarse) {
    if(!coarse.diagnostics.converged)throw new Error('Finish climate did not converge; no bake-ready artifact written');
    if(!coarse.diagnostics.history?.length||coarse.diagnostics.history.some(d=>
        !Number.isFinite(d.waterBudgetMm)||!Number.isFinite(d.maxTransportCorrection)||!Number.isFinite(d.maxEnergyResidual)||
        Math.abs(d.waterBudgetMm)>0.01||d.maxTransportCorrection>0.001||d.maxEnergyResidual>0.01))throw new Error('Finish climate numerical budget check failed');
}

export async function prepareClimate(planet,sourceFingerprint,directory,options={},log=console.log) {
    // Approximately the same physical circulation grain on different bodies;
    // a quarter-radius planet needs far fewer atmospheric cells than Earth.
    const cells=Math.max(1000,Math.round(Climate.DEFAULTS.climateCells*(planet.body.radiusKm/6371)**2));
    const settings={...Climate.DEFAULTS,climateCells:cells,...options};
    const invalid=Params.checkFinishClimate(settings);if(invalid.length)throw new Error(invalid.join('; '));
    const key=createHash('sha256').update(JSON.stringify({version:Climate.VERSION,algorithmHash,sourceFingerprint,body:planet.body,settings})).digest('hex');
    const path=join(directory,`seasonal-${key}.json`);let coarse;
    const cached=await readFile(path,'utf8').catch(err=>{if(err.code==='ENOENT')return null;throw err;});
    if(cached){
        const payload=JSON.parse(cached);
        if(payload.key!==key||JSON.stringify(payload.options)!==JSON.stringify(settings)||JSON.stringify(payload.body)!==JSON.stringify(planet.body))throw new Error('Finish climate cache identity mismatch');
        coarse=Artifact.decode(payload,sourceFingerprint);checkReady(coarse);log('Finish climate: loaded '+key.slice(0,12));
    }
    else {
        const grid=Grid.makeGrid(settings.climateCells,planet.body.radiusKm),terrain=Grid.terrainFromPlanet(grid,planet);
        const started=performance.now();
        coarse=Climate.run({grid,...terrain},planet.body,settings,d=>log(`Climate year ${d.year}: annual-cycle change ${d.temperatureDeltaC.toFixed(3)} C, ${(100*d.rainRelativeDelta).toFixed(2)}% rain`));
        checkReady(coarse);
        coarse.diagnostics.elapsedSeconds=(performance.now()-started)/1000;
        await mkdir(directory,{recursive:true});const temp=path+`.${process.pid}.tmp`;
        const payload={...Artifact.encode(coarse,sourceFingerprint),key,algorithmHash};
        await writeFile(temp,JSON.stringify(payload));await rename(temp,path);
        // Use the same packed precision on first run and resume. Otherwise
        // fractional coasts/height round differently in the downscaler.
        coarse=Artifact.decode(payload,sourceFingerprint);
        log(`Finish climate: ${coarse.diagnostics.elapsedSeconds.toFixed(1)} s; saved ${path}`);
    }
    const fine=Downscale.downscale(coarse,planet);
    return {key,path,coarse,fine};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    const args=Object.fromEntries(process.argv.slice(2).map(s=>{const [k,...v]=s.replace(/^--/,'').split('=');return [k,v.join('=')];}));
    for(const key of Object.keys(args))if(!['project','variant','cells','out'].includes(key))throw new Error('Unknown climate argument: '+key);
    const run=await resolveRun(root,Projects,args.project,null,args.variant);
    if(!run.variant)throw new Error('Finish climate needs a saved variant');
    const saved=await loadSavedPlanet(root,run.project,run.variant);
    const options={};if(args.cells)options.climateCells=Number(args.cells);
    const directory=args.out?resolve(args.out):join(root,'preview',run.project,'v',run.variant,'climate');
    const result=await prepareClimate(saved.planet,saved.fingerprint,directory,options);
    console.log(JSON.stringify({key:result.key,path:result.path,downscale:result.fine.diagnostics}));
}
