/** Replay coarse terrain from a validation artifact without rebuilding Shape. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),C=require('../src/seasonal-climate'),A=require('../src/climate-artifact'),G=require('../src/climate-grid'),R=require('../src/software-render');
const [source,out='work/climate/replay']=process.argv.slice(2);
const old=A.decode(JSON.parse(await readFile(source,'utf8')));
const start=performance.now(),result=C.run(old.grid,old.body,old.options,d=>console.log(`Year ${d.year}: ${d.temperatureDeltaC.toFixed(3)} C / ${(100*d.rainRelativeDelta).toFixed(2)}%`));
await mkdir(out,{recursive:true});
await writeFile(out+'/coarse.json',JSON.stringify(A.encode(result,old.sourceFingerprint)));
const width=720,height=360,fields={width,height,heightmap:new Float32Array(width*height),temperature:new Float32Array(width*height),precipitation:new Float32Array(width*height)},scratch={};
for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
 const lat=Math.PI*(.5-(y+.5)/height),lon=2*Math.PI*((x+.5)/width-.5),p=[Math.cos(lat)*Math.cos(lon),Math.cos(lat)*Math.sin(lon),Math.sin(lat)],k=y*width+x;
 fields.heightmap[k]=G.sample(result.grid,result.grid.land,p,scratch)>.5?G.sample(result.grid,result.grid.height,p,scratch):-1000;
 for(const key of ['temperature','precipitation'])fields[key][k]=G.sample(result.grid,result.annual[key],p,scratch);
}
await writeFile(out+'/annual.png',R.drawWorldSheet(fields,[],[]));
console.log(JSON.stringify({seconds:(performance.now()-start)/1000,converged:result.diagnostics.converged}));
