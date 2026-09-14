/** Isolated real-Earth climate benchmark. No projects, variants or workers. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
const require=createRequire(import.meta.url),G=require('../src/climate-grid'),C=require('../src/seasonal-climate'),A=require('../src/climate-artifact'),P=require('../src/params'),W=require('../src/world');
const args=process.argv.slice(2),command=args.find(a=>!a.startsWith('--'))||'all';
const arg=(key,fallback)=>args.find(a=>a.startsWith(`--${key}=`))?.slice(key.length+3)??fallback;
const root=resolve(arg('out','work/earth-climate')),cells=Number(arg('cells','10000'));
const defaultName='run-'+new Date().toISOString().replace(/[-:]/g,'').replace(/\..*/,'').replace('T','-');
const checked=options=>{const errors=P.checkFinishClimate(options);if(errors.length)throw Error(errors.join('; '));return options;};
await mkdir(root,{recursive:true});
if(command==='all') {
    const python=arg('python',process.env.PLANETGEN_CLIMATE_PYTHON||'python');
    const launch=(exe,argv)=>new Promise((done,fail)=>{
        const child=spawn(exe,argv,{stdio:'inherit',windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MPLCONFIGDIR:root+'/mpl-cache'}});
        child.on('error',fail);child.on('exit',code=>code===0?done():fail(Error(`${exe} exited ${code}`)));
    });
    if(args.includes('--fetch'))await launch(python,['scripts/earth-climate-reference.py','--out',root+'/reference']);
    await launch(process.execPath,[import.meta.filename,'grid',`--out=${root}`,`--cells=${cells}`]);
    const prepare=['scripts/earth-climate-benchmark.py','prepare','--out',root];
    if(arg('worldclim',null))prepare.push('--worldclim',arg('worldclim',null));
    await launch(python,prepare);
    const name=arg('name',defaultName);
    await launch(process.execPath,[import.meta.filename,'run',`--out=${root}`,`--name=${name}`,`--options=${arg('options','{}')}`]);
    await launch(python,['scripts/earth-climate-benchmark.py','compare','--out',root,'--runs',name]);
} else if(command==='grid') {
    checked({climateCells:cells});
    const grid=G.makeGrid(cells,W.EARTH.radiusKm);
    await writeFile(root+'/grid.json',JSON.stringify({schema:1,cells,n:grid.n,radiusKm:grid.radiusKm,xyz:Array.from(grid.xyz),area:Array.from(grid.area)}));
    console.log(`Earth input grid: ${grid.n} spherical cells`);
} else if(command==='run') {
    const inputBytes=await readFile(root+'/input.json'),input=JSON.parse(inputBytes),name=arg('name',defaultName);
    if(!/^[a-z0-9_-]+$/.test(name))throw Error('Use a simple benchmark run name');
    const overrides=JSON.parse(arg('options','{}'));
    checked(overrides);
    if(overrides.climateCells!==undefined&&overrides.climateCells!==input.cells)throw Error('Rebuild the Earth input before changing climateCells');
    const options=checked({...C.DEFAULTS,climateCells:input.cells,...overrides});
    const sourceFingerprint=createHash('sha256').update(inputBytes).digest('hex');
    const grid=G.makeGrid(input.cells,input.body.radiusKm);
    if(input.schema!==1||input.land.length!==grid.n||input.height.length!==grid.n)throw Error('Invalid Earth benchmark input');
    if(input.land.some(x=>!Number.isFinite(x)||x<0||x>1)||input.height.some(x=>!Number.isFinite(x)||x<0))throw Error('Invalid Earth land/height');
    const hashes={};
    for(const file of ['src/seasonal-climate.js','src/climate-grid.js','src/sphere-mesh.js','src/tectonics.js','src/climate-artifact.js','scripts/benchmark-earth-climate.mjs'])hashes[file]=createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex');
    const directory=root+'/'+name;
    await mkdir(directory).catch(error=>{if(error.code==='EEXIST')throw Error('Benchmark run already exists; choose a new --name to preserve the comparison');throw error;});
    await writeFile(directory+'/run.json',JSON.stringify({name,ready:false,sourceFingerprint,hashes,options}));
    const started=performance.now();
    const result=C.run({grid,land:input.land,height:input.height},input.body,options,d=>console.log(`${name} year ${d.year}: ${d.temperatureDeltaC.toFixed(3)} C, rain ${(100*d.rainRelativeDelta).toFixed(2)}%`));
    const seconds=(performance.now()-started)/1000;
    const ready=result.diagnostics.converged&&result.diagnostics.history.every(d=>Math.abs(d.waterBudgetMm)<.01&&d.maxTransportCorrection<.001&&d.maxEnergyResidual<.01);
    await writeFile(directory+'/run.json',JSON.stringify({name,seconds,ready,sourceFingerprint,hashes,options,diagnostics:result.diagnostics},null,2));
    if(!ready)throw Error('Earth climate failed numerical readiness; inspect run.json');
    await writeFile(directory+'/climate.json',JSON.stringify(A.encode(result,sourceFingerprint)));
    await writeFile(directory+'/monthly.json',JSON.stringify({n:grid.n,temperature:Array.from(result.monthly.temperature),precipitation:Array.from(result.monthly.precipitation)}));
    console.log(`${name}: ready in ${seconds.toFixed(2)} s; ${directory}`);
} else throw Error('Usage: bun scripts/benchmark-earth-climate.mjs all|grid|run [--fetch] [--python=...] [--out=...] [--cells=10000] [--name=unique-run-name] [--options=JSON]');
