/** Physical invariants for the improved transport; no Earth target fields. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import Module,{createRequire} from 'node:module';
import {dirname} from 'node:path';
const require=createRequire(import.meta.url),G=require('../src/climate-grid');
let C=require('../src/seasonal-climate');
const candidate=process.argv.find(a=>a.startsWith('--candidate='))?.slice(12);
if(candidate) {
    const path=require.resolve('../src/seasonal-climate'),module=new Module(path);
    module.filename=path;module.paths=Module._nodeModulePaths(dirname(path));module._compile(await readFile(candidate,'utf8'),path);C=module.exports;
}
const grid=G.makeGrid(400,6371),{n,area,xyz}=grid;
const theta=Float64Array.from({length:n},(_,r)=>-15+35*xyz[3*r]);
const before=theta.slice(),capacity=Float64Array.from({length:n},(_,r)=>xyz[3*r+2]>0?1.5e7:1.2e8);
const forcing=Float64Array.from(before,t=>203+2.1*t),dt=2*86400;
C.solveEnergy(grid,theta,capacity,forcing,dt,.55);
let stored=0,radiative=0,total=0;
for(let r=0;r<n;r++) {
    stored+=(theta[r]-before[r])*capacity[r]*area[r]/dt;
    radiative+=(forcing[r]-203-2.1*theta[r])*area[r];total+=area[r];
}
const errorWm2=Math.abs(stored-radiative)/total;
assert(errorWm2<.01,`Symmetric heat flux must cancel globally: ${errorWm2} W/m2`);
assert(Math.max(...theta)<Math.max(...before)&&Math.min(...theta)>Math.min(...before),'Heat mixing must reduce extremes without a spurious source');
function smoothing(mean) {
    const t=Float64Array.from({length:n},(_,r)=>mean+5*xyz[3*r]),old=t.slice(),c=new Float64Array(n).fill(1.5e7),f=Float64Array.from(t,v=>203+2.1*v);
    C.solveEnergy(grid,t,c,f,dt,.55);
    return old.reduce((s,v,r)=>s+(v-mean)**2*area[r],0)-t.reduce((s,v,r)=>s+(v-mean)**2*area[r],0);
}
const cold=smoothing(-35),warm=smoothing(25);
assert(warm>cold*1.5,'Latent transport should increase mixing in warm moist air relative to cold air');
console.log(JSON.stringify({heatBudgetErrorWm2:errorWm2,warmToColdMixing:warm/cold}));
console.log('Heat transfer conserves energy, reduces extremes, and strengthens with moisture capacity');
