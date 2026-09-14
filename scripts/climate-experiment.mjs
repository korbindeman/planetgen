/** Isolated physics experiments; compile a recorded candidate without editing
 * the production solver. Inputs/output match the real-Earth benchmark. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import Module,{createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
const require=createRequire(import.meta.url),G=require('../src/climate-grid'),A=require('../src/climate-artifact');
const root=resolve('work/earth-climate'),sourcePath=require.resolve('../src/seasonal-climate');
const recordedSource=process.argv.find(a=>a.startsWith('--before='))?.slice(9)||sourcePath;
const source=await readFile(recordedSource,'utf8'),inputBytes=await readFile(root+'/input.json'),input=JSON.parse(inputBytes);
const fingerprint=createHash('sha256').update(inputBytes).digest('hex');
const experiments=JSON.parse(await readFile(process.argv[2],'utf8'));
for(const experiment of experiments) {
    const {name,changes=[],options={}}=experiment;
    if(!/^[a-z0-9_-]+$/.test(name)||name==='baseline')throw Error('Use a unique experiment name');
    let candidate=source;
    for(const [before,after] of changes) {
        if(candidate.split(before).length!==2)throw Error(`Patch does not match exactly once: ${before}`);
        candidate=candidate.replace(before,after);
    }
    const module=new Module(sourcePath);module.filename=sourcePath;module.paths=Module._nodeModulePaths(dirname(sourcePath));module._compile(candidate,sourcePath);
    const C=module.exports,settings={...C.DEFAULTS,climateCells:input.cells,...options},grid=G.makeGrid(input.cells,input.body.radiusKm);
    const out=root+'/'+name;await mkdir(out);
    await writeFile(out+'/run.json',JSON.stringify({name,experimental:true,ready:false,sourceFingerprint:fingerprint}));
    await writeFile(out+'/candidate.js',candidate);await writeFile(out+'/experiment.json',JSON.stringify(experiment,null,2));
    const start=performance.now();
    try {
        const result=C.run({grid,land:input.land,height:input.height},input.body,settings,d=>console.log(`${name} year ${d.year}: ${d.temperatureDeltaC.toFixed(3)} C, rain ${(100*d.rainRelativeDelta).toFixed(2)}%`));
        const ready=result.diagnostics.converged&&result.diagnostics.history.every(d=>Math.abs(d.waterBudgetMm)<.01&&d.maxTransportCorrection<.001&&d.maxEnergyResidual<.01);
        await writeFile(out+'/run.json',JSON.stringify({name,experimental:true,seconds:(performance.now()-start)/1000,ready,sourceFingerprint:fingerprint,candidateSha256:createHash('sha256').update(candidate).digest('hex'),options:settings,diagnostics:result.diagnostics},null,2));
        if(!ready){console.log(`${name} FAILED numerical readiness`);continue;}
        await writeFile(out+'/climate.json',JSON.stringify(A.encode(result,fingerprint)));
        await writeFile(out+'/monthly.json',JSON.stringify({n:grid.n,temperature:Array.from(result.monthly.temperature),precipitation:Array.from(result.monthly.precipitation)}));
        console.log(`${name} ready in ${((performance.now()-start)/1000).toFixed(1)} seconds`);
    } catch(error) {
        await writeFile(out+'/failure.txt',error.stack);console.error(`${name} FAILED: ${error.message}`);
    }
}
