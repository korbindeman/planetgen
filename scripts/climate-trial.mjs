/** Isolated CPU development trial. Never starts a terrain worker. */
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),C=require('../src/seasonal-climate'),G=require('../src/climate-grid');
const cells=Number(process.argv[2]||1000),radiusKm=Number(process.argv[3]||6371);
const grid=G.makeGrid(cells,radiusKm),land=new Float64Array(grid.n),height=new Float64Array(grid.n);
for(let r=0;r<grid.n;r++) {
    const lon=Math.atan2(grid.xyz[r*3+1],grid.xyz[r*3]),lat=grid.lat[r];
    land[r]=Math.abs(lon)<1.15&&Math.abs(lat)<1.2?1:0;
    height[r]=land[r]*(300+2500*Math.exp(-(((lon+0.7)/0.12)**2)));
}
const started=performance.now();
const result=C.run({grid,land,height},{radiusKm,axialTiltDeg:23.44,rotationHours:24,gravityG:1},
    {climateCells:cells,climateMaxYears:20},d=>console.log(JSON.stringify(d)));
const values=Object.fromEntries(Object.entries(result.annual).map(([key,a])=>[key,{min:Math.min(...a),max:Math.max(...a),mean:a.reduce((s,v)=>s+v,0)/a.length}]));
console.log(JSON.stringify({elapsedSeconds:(performance.now()-started)/1000,values,converged:result.diagnostics.converged}));
await mkdir('work/climate',{recursive:true});
await writeFile(`work/climate/trial-${cells}-${radiusKm}.json`,JSON.stringify({values,diagnostics:result.diagnostics}));
