import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),G=require('../src/climate-grid'),C=require('../src/seasonal-climate'),D=require('../src/climate-downscale'),Td=require('../src/seasonal-td'),Cube=require('../src/cubesphere'),T=require('../src/tectonics');
function terrain(cells,ridge=true) {
 const grid=G.makeGrid(cells,6371),land=new Float64Array(grid.n),height=new Float64Array(grid.n);
 for(let r=0;r<grid.n;r++) {const lon=Math.atan2(grid.xyz[3*r+1],grid.xyz[3*r]);land[r]=Math.abs(lon)<1.1&&Math.abs(grid.lat[r])<1.2?1:0;height[r]=land[r]*(200+(ridge?2000*Math.exp(-(((lon-.65)/.13)**2)):0));}
 return {grid,land,height};
}
const body={radiusKm:6371,rotationHours:24,axialTiltDeg:23.44,gravityG:1};
const opts={climateCells:800,climateMaxYears:30},base=terrain(800),landBefore=base.land.slice(),hBefore=base.height.slice();
const climate=C.run(base,body,opts);
assert(climate.diagnostics.converged);assert.deepEqual(base.land,landBefore);assert.deepEqual(base.height,hBefore);
const average=(values,predicate=()=>true,grid=climate.grid)=>{let v=0,a=0;for(let r=0;r<grid.n;r++)if(predicate(r)){v+=values[r]*grid.area[r];a+=grid.area[r];}assert(a>0);return v/a;};
const mid=r=>Math.abs(climate.grid.lat[r])>.5&&Math.abs(climate.grid.lat[r])<.85;
const landSwing=average(climate.annual.temperature_std,r=>mid(r)&&base.land[r]===1),seaSwing=average(climate.annual.temperature_std,r=>mid(r)&&base.land[r]===0);
assert(landSwing>seaSwing*1.5,'Land should have a greater seasonal swing than ocean');
const flat=C.run(terrain(800,false),body,{...opts,climateMonsoonStrength:0});
const ridge=C.run(terrain(800),body,{...opts,climateMonsoonStrength:0});
const windward=r=>{const lon=Math.atan2(base.grid.xyz[3*r+1],base.grid.xyz[3*r]);return lon>.68&&lon<.94&&Math.abs(base.grid.lat[r])<.28;};
const raisedRain=average(ridge.annual.precipitation,windward),flatRain=average(flat.annual.precipitation,windward);
console.log({landSwing,seaSwing,raisedRain,flatRain});
assert(raisedRain>flatRain*1.15,'A ridge exposed to moist trades should increase windward rain');
const shorter=C.run(terrain(800),body,{...opts,climateStepDays:1});assert(shorter.diagnostics.converged);
const rms=Math.sqrt(average(Float64Array.from(climate.annual.temperature,(t,r)=>(t-shorter.annual.temperature[r])**2)));
const rainChange=average(Float64Array.from(climate.annual.precipitation,(p,r)=>Math.abs(p-shorter.annual.precipitation[r])))/average(climate.annual.precipitation);
assert(rms<1&&rainChange<.2,'Halving timestep must preserve broad climate');
const fineGrid=G.makeGrid(4000,6371),finePlanet={mesh:fineGrid.mesh,map:{r_xyz:fineGrid.xyz,r_meters:Float32Array.from({length:fineGrid.n},(_,r)=>{const lon=Math.atan2(fineGrid.xyz[3*r+1],fineGrid.xyz[3*r]);return Math.abs(lon)<1.1&&Math.abs(fineGrid.lat[r])<1.2?200+2000*Math.exp(-(((lon-.65)/.13)**2)):-1000;})}};
finePlanet.map.r_elevation=Float32Array.from(finePlanet.map.r_meters,T.metersToElevation);
const fine=D.downscale(climate,finePlanet);assert(fine.diagnostics.maxConservationError<1e-6);
assert(Object.values(fine.annual).every(a=>a.every(Number.isFinite)));
const n=fineGrid.n,physical={annual:{temperature:new Float32Array(n).fill(17),temperature_std:new Float32Array(n).fill(3),precipitation:new Float32Array(n).fill(900),precipitation_cv:new Float32Array(n).fill(40)}};
const tile={face:0,level:0,i:0,j:0},rect=Cube.tileBakeRect(tile,20,0,null),layers=Td.layersForBakeRect(finePlanet,physical,tile,rect);
for(const [key,value] of [['temperature',17],['temperature_std',3],['precipitation',900],['precipitation_cv',40]])assert(layers[key].every(v=>Math.abs(v-value)<1e-3),'Physical channel was remapped: '+key);
const cold=C.circulation(climate.grid,new Float64Array(base.grid.n),0,body,{...C.DEFAULTS}),warmTheta=Float64Array.from(base.land,v=>v*10),warm=C.circulation(climate.grid,warmTheta,0,body,{...C.DEFAULTS});
assert(warm.wind.some((v,k)=>Math.abs(v-cold.wind[k])>1),'Land/sea thermal contrast must affect winds');
const fast=C.circulation(climate.grid,new Float64Array(base.grid.n),0,{...body,rotationHours:12},{...C.DEFAULTS});
assert(fast.wind.some((v,k)=>Math.abs(v-cold.wind[k])>1),'Day length must affect circulation');
console.log(JSON.stringify({landSwing,seaSwing,raisedRain,flatRain,timestepRmsC:rms,timestepRainChange:rainChange,downscaleConservation:fine.diagnostics.maxConservationError},null,2));
console.log('Seasonality, orographic rain, timestep stability, physical export, thermal winds, rotation and downscaling passed');
