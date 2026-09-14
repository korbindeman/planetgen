/** Mechanism tests, not a score against Earth's geographical accidents. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),C=require('../src/seasonal-climate'),G=require('../src/climate-grid'),Artifact=require('../src/climate-artifact');
const near=(a,b,e=1e-7)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b} (tolerance ${e})`);
const check=(name,fn)=>{fn();console.log('ok '+name);};
check('daily sunlight: equinox, polar night, polar day',()=>{
    near(C.insolation(0,0),1361/Math.PI);near(C.insolation(Math.PI/2,-0.4),0);
    near(C.insolation(Math.PI/2,0.4),1361*Math.sin(0.4));
});
const grid=G.makeGrid(400,6371),n=grid.n,area=grid.area.reduce((a,b)=>a+b,0);
check('closed sphere finite-volume areas',()=>near(area/(4*Math.PI*(6371e3)**2),1,1e-9));
check('implicit transport moves water without creating it or going negative',()=>{
    const q=Float64Array.from({length:n},(_,r)=>r<20?15:0),flux=Float64Array.from(grid.edges,()=>1000000);
    const total=a=>a.reduce((s,v,r)=>s+v*grid.area[r],0),before=total(q);
    G.transport(grid,q,flux,2*C.DAY,100,1e-10,8e5);
    near(total(q)/before,1,1e-12);assert.ok(q.every(x=>x>=0));assert.ok(q.slice(20).some(x=>x>0));
});
check('WorldClim units and sample SD, with finite arid BIO15',()=>{
    const t=Float32Array.from({length:12},(_,i)=>i),p=Float32Array.from({length:12},(_,i)=>i*2);
    const result=C.summarize(t,p,1);near(result.temperature[0],5.5);near(result.temperature_std[0],Math.sqrt(13),1e-6);
    near(result.precipitation[0],132);near(result.precipitation_cv[0],100*Math.sqrt(52)/12,1e-5);
    const dry=C.summarize(new Float32Array(12),new Float32Array(12),1);near(dry.precipitation_cv[0],0);
});
const options={climateCells:400,climateMaxYears:25,climateMinYears:6};
const body={radiusKm:6371,axialTiltDeg:0,rotationHours:24,gravityG:1};
const ocean=C.run({grid,land:new Float64Array(n),height:new Float64Array(n)},body,options);
check('aquaplanet reaches a repeating cycle and closes its water budget',()=>{
    assert.ok(ocean.diagnostics.converged);assert.ok(ocean.diagnostics.history.every(y=>Math.abs(y.waterBudgetMm)<1e-5));
    assert.ok(ocean.annual.temperature_std.every(x=>x<0.2));assert.ok(ocean.annual.precipitation.some(x=>x>500));
});
const dry=C.run({grid,land:new Float64Array(n).fill(1),height:new Float64Array(n)},body,options);
check('a planet without an ocean depletes its initial water without an invented source',()=>{
    assert.ok(dry.diagnostics.converged);assert.ok(dry.annual.precipitation.reduce((s,v)=>s+v,0)/n<1);
    assert.ok(dry.diagnostics.history.every(y=>y.oceanEvaporationMm===0));
    assert.ok(dry.diagnostics.history.every(y=>Math.abs(y.waterBudgetMm)<1e-5));
});
check('artifact round trip preserves monthly climate and rejects torn or stale files',()=>{
    const payload=Artifact.encode(ocean,'fixture'),decoded=Artifact.decode(payload,'fixture');
    assert.deepEqual(decoded.monthly.temperature,ocean.monthly.temperature);
    assert.throws(()=>Artifact.decode(payload,'different'),/different saved inputs/);
    assert.throws(()=>Artifact.decode({...payload,monthly:{...payload.monthly,precipitation:'AA=='}},'fixture'),/Truncated/);
    assert.throws(()=>Artifact.decode({...payload,diagnostics:{converged:false}},'fixture'),/stable annual cycle/);
});
console.log('Climate mechanism checks passed');
