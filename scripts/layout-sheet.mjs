/** Layout-only review: consecutive seeds, ocean-centered maps, saved captures.
 * bun scripts/layout-sheet.mjs [--from=1] [--count=12]
 */
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const Planet=require('../src/planet');
const Render=require('../src/software-render');
const args=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split('=')));
const from=Number(args.from||1),count=Number(args.count||12);
const dir=resolve(args.out||'work/layout-history');await mkdir(dir,{recursive:true});
const tiles=[],summary=[];
for(let seed=from;seed<from+count;seed++){
 const p=Planet.generatePlanet({seed,project:'thalos',detailPass:false,quiet:true});
 const map=p.sim.map,n=map.r_elevation.length;
 let best=Infinity,seam=0;
 for(let lon=-180;lon<180;lon+=5){let land=0;
  for(let r=0;r<n;r++)if(map.r_elevation[r]>0){const a=Math.atan2(map.r_xyz[r*3+1],map.r_xyz[r*3])*180/Math.PI;const d=Math.abs(((a-lon+540)%360)-180);if(d<12)land+=12-d;}
  if(land<best){best=land;seam=lon;}
 }
 const lon0=((seam+360)%360)-180;
 const png=Render.captureEquirect(p,{overlay:'relief',lon0});
 tiles.push({seed,png});await writeFile(resolve(dir,`seed-${seed}.png`),png);
 await writeFile(resolve(dir,`seed-${seed}-history.json`),JSON.stringify(map.layoutHistory,null,2));
 // Geography QA on both the sphere and map, with plate and crust counterparts.
 if(seed<from+Number(args.views??3)){for(const overlay of ['relief','plates','crust']){
  await writeFile(resolve(dir,`seed-${seed}-${overlay}-globe.png`),Render.captureGlobe(p,{overlay}));
  await writeFile(resolve(dir,`seed-${seed}-${overlay}-map.png`),Render.captureEquirect(p,{overlay}));
 }}
 summary.push({seed,lon0,landCells:Array.from(map.r_elevation).filter(x=>x>0).length,plates:map.plates.length});
 console.log(`layout ${seed}`);
}
await writeFile(resolve(dir,'contact-sheet.png'),Render.seedSheet(tiles,'equirect'));
await writeFile(resolve(dir,'sheet.json'),JSON.stringify(summary,null,2));
console.log(resolve(dir,'contact-sheet.png'));
