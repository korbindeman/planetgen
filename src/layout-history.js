/* A composed tectonic past, evaluated once. No crust advection or time steps.
 * Continental polygons and their boundary histories share geometry; coastlines
 * remain interpolated elevation contours, independent of plate ownership.
 */
'use strict';
const SimplexNoise = require('simplex-noise');
const {makeRandFloat} = require('@redblobgames/prng');
const T = require('./tectonics');
const Composition = require('./layout-composition');
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const unit = a => {const m=Math.hypot(...a)||1;return a.map(x=>x/m);};
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
const smooth = x => {x=clamp(x,0,1);return x*x*(3-2*x);};

/* Cyclic WFC: active margin and an opening rift cannot meet directly; a
 * passive/transform transition must separate them. Pins give a continent a
 * mixed history, propagation and backtracking complete the boundary ring.
 * This is a small constraint grammar, not a claim of dynamic reconstruction.
 */
function collapseMargins(rand) {
 const compatible=(a,b)=>!(a==='active'&&b==='rift'||a==='rift'&&b==='active');
 function solve(domains) {
  let changed=true;
  while(changed) {changed=false;for(let i=0;i<8;i++) for(const j of [(i+7)%8,(i+1)%8]) {
   const keep=domains[i].filter(a=>domains[j].some(b=>compatible(a,b)));
   if(!keep.length)return null;if(keep.length!==domains[i].length){domains[i]=keep;changed=true;}
  }}
  let pick=-1;for(let i=0;i<8;i++)if(domains[i].length>1&&(pick<0||domains[i].length<domains[pick].length))pick=i;
  if(pick<0)return domains.map(d=>d[0]);
  const choices=domains[pick].map(x=>({x,r:rand()})).sort((a,b)=>a.r-b.r);
  for(const {x} of choices){const next=domains.map(d=>d.slice());next[pick]=[x];const result=solve(next);if(result)return result;}
  return null;
 }
 const d=Array.from({length:8},()=>['passive','rift']);
 d[0]=['active'];d[1]=['active'];d[4]=['passive'];d[5]=['rift'];
 const ring=solve(d),offset=[0,3,4,7][Math.floor(rand()*4)];
 return Array.from({length:8},(_,k)=>ring[(k-offset+8)%8]);
}
function connectPartition(mesh,map) {
 const n=mesh.numRegions,seen=new Uint8Array(n),cores=map.plates.map(()=>[]),nb=[];
 for(let r=0;r<n;r++)if(!seen[r]){
  const id=map.r_plate[r],q=[r];seen[r]=1;
  for(let i=0;i<q.length;i++){mesh.r_circulate_r(nb,q[i]);for(const j of nb)if(!seen[j]&&map.r_plate[j]===id){seen[j]=1;q.push(j);}}
  if(q.length>cores[id].length)cores[id]=q;
 }
 // Retain each plate's connected core and regrow only detached scraps.
 // Every added cell touches its owner, so connectivity is constructive.
 map.r_plate.fill(-1);const queue=[];
 cores.forEach((cells,id)=>{for(const r of cells){map.r_plate[r]=id;queue.push(r);}});
 for(let i=0;i<queue.length;i++){const r=queue[i];mesh.r_circulate_r(nb,r);for(const q of nb)if(map.r_plate[q]<0){map.r_plate[q]=map.r_plate[r];queue.push(q);}}
 // An enclosed plate with one neighbor contributes no plate junction.
 for(let pass=0;pass<map.plates.length;pass++){
  const touches=map.plates.map(()=>new Set());
  for(let r=0;r<n;r++){mesh.r_circulate_r(nb,r);for(const q of nb)if(map.r_plate[r]!==map.r_plate[q])touches[map.r_plate[r]].add(map.r_plate[q]);}
  let pick=-1;for(let p=0;p<touches.length;p++)if(touches[p].size===1&&touches[[...touches[p]][0]].size>1){pick=p;break;}
  if(pick<0)break;const into=[...touches[pick]][0];for(let r=0;r<n;r++)if(map.r_plate[r]===pick)map.r_plate[r]=into;
 }
 const used=new Set(map.r_plate),remap=new Map();
 map.plates=map.plates.filter((p,i)=>{if(!used.has(i))return false;remap.set(i,remap.size);return true;});
 for(let r=0;r<n;r++)map.r_plate[r]=remap.get(map.r_plate[r]);
}
function compose(seed,options={}) {
 return Composition.compose(seed,options,collapseMargins);
}
// Layout has one world ocean. Polygon unions can enclose accidental pockets
// even when every authored seaway has an outlet. Restore those pockets to
// low continental basins before deriving elevation, crust or plate ownership.
function closeAccidentalSeas(mesh,sd) {
 const seen=new Uint8Array(sd.length),components=[],neighbors=[];
 for(let r=0;r<sd.length;r++)if(sd[r]<0&&!seen[r]){
  const q=[r];seen[r]=1;
  for(let k=0;k<q.length;k++){mesh.r_circulate_r(neighbors,q[k]);for(const j of neighbors)if(sd[j]<0&&!seen[j]){seen[j]=1;q.push(j);}}
  components.push(q);
 }
 components.sort((a,b)=>b.length-a.length);
 for(const cells of components.slice(1))for(const r of cells)sd[r]=.035;
 return components.slice(1).map(c=>c.length);
}
function generate(mesh,map,seed,options={}) {
 const rand=makeRandFloat(seed^0x61a830d9),noise=new SimplexNoise(makeRandFloat(seed^0x81fd1));
 const plan=compose(seed,options),blocks=plan.blocks,n=mesh.numRegions;
 const meters=new Float32Array(n),owner=new Int32Array(n),sd=new Float32Array(n),shelfWidths=new Float32Array(n),types=[];
 const f=p=>noise.noise3D(...p);
 const macro=p=>f(p.map(x=>x*3));
 for(const name of ['r_crust_age','r_thickness','r_orogeny','r_arc','r_arcPeak','r_arcAge','r_hotspot','r_hotspotPeak','r_hotspotAge','r_convergence'])map[name]=new Float32Array(n);
 map.r_crust_type=new Uint8Array(n);map.r_boundary=new Uint8Array(n);map.r_orogenyDir=new Float32Array(3*n);map.r_arcDir=new Float32Array(3*n);
 const coordinates=new Array(n);
 for(let r=0;r<n;r++) {
  const p=Array.from(map.r_xyz.slice(3*r,3*r+3));let best=-Infinity,own=0,edge=0;
  const warp=.016*f(p.map(x=>x*17))+.007*f(p.map(x=>x*37));
  const coords=coordinates[r]=blocks.map(b=>Composition.project(b,p));
  for(let i=0;i<blocks.length;i++) {
   const b=blocks[i],hit=Composition.nearestEdge(b,...coords[i]),d=hit.sd+warp;
   if(d>best){best=d;own=i;edge=hit.edge;}
  }
  for(const sea of plan.seas){
   const hit=Composition.nearestEdge(sea,...Composition.project(sea,p));
   best=Math.min(best,-hit.sd+warp*.5);
  }
  // Arc crust is emplaced after basin opening, but is placed outside the
  // gateway so that it cannot turn a marginal sea into an enclosed lake.
  for(let i=0;i<blocks.length;i++)if(blocks[i].kind==='arc'){
   const hit=Composition.nearestEdge(blocks[i],...coords[i]);
   if(hit.sd>best){best=hit.sd;own=i;edge=hit.edge;}
  }
  sd[r]=best;owner[r]=own;
  const b=blocks[own],state=b.margins[Math.floor(edge/b.verts.length*8)];
  types[r]=state==='rift'?'rift':'passive';
  // A present active boundary must be supported by an authored young range.
  // The local margin ring supplies the passive/rift prior elsewhere.
  for(const belt of plan.belts)if(!belt.old&&!belt.collision){
   const hit=Composition.pathDistance(belt.points,...coords[belt.block]);
   // Continue the incoming oceanic plate out to its basin. A narrow strip
   // at the coast would be disconnected and lost in partition repair.
   if(hit.distance<belt.width+.115 || best<0&&hit.distance<.72&&hit.along>.015&&hit.along<.985){types[r]='active';break;}
  }
 }
 plan.closedPockets=closeAccidentalSeas(mesh,sd);
 for(let r=0;r<n;r++) {
  const p=Array.from(map.r_xyz.slice(3*r,3*r+3)),coords=coordinates[r],best=sd[r];
  const base=130+90*(.5+.5*macro(p));
  // A shelf is shallow continental crust, followed by a separate slope.
  // Its regional width varies with the margin history. The old single ramp
  // dropped immediately into deep water around every landmass, visually
  // separating even related fragments from their continental assembly.
  const regional=smooth(.5+macro(p)*1.3);
  const shelf=shelfWidths[r]=blocks[owner[r]].kind==='arc'?.016:types[r]==='active'?.018+.022*regional:.028+.090*regional;
  const slope=smooth((-best-shelf)/(.065+shelf*.65));
  const shelfDepth=130+220*(1-regional);
  let h=best>=0?base*smooth(best/.022):-shelfDepth*smooth(-best/shelf)-(T.oceanDepthMeters(35+110*smooth(-best/.7))-shelfDepth)*slope;
  if(best>0){
   let relief=0,ancient=0,basementHeight=0,basementWeight=0;
   for(const province of plan.provinces){
    const [x,y]=coords[province.block];
    if(province.kind==='basement'){
     if(blocks[province.block].group!==blocks[owner[r]].group)continue;
     const hit=Composition.nearestEdge(province,x,y),weight=Math.exp(Math.max(-40,Math.min(0,hit.sd/.045)));
     const dx=x-province.center[0],dy=y-province.center[1],c=Math.cos(province.strike),s=Math.sin(province.strike);
     const u=dx*c+dy*s,v=-dx*s+dy*c;
     const folded=noise.noise2D(u*12+province.phase,v*37+noise.noise2D(u*9,v*9)*.8);
     const regional=noise.noise2D(u*8+31,v*15+province.phase);
     const height=Math.max(40,province.level+dx*province.tilt[0]+dy*province.tilt[1]+province.grain*(.70*folded+.55*regional));
     basementHeight+=weight*height;basementWeight+=weight;
     continue;
    }
    if(province.kind==='collision-platform'){
     const hit=Composition.nearestEdge(province,x,y);
     relief+=province.height*smooth(.5+hit.sd/.07);
     continue;
    }
    if(province.kind==='orogenic-branch'){
     const hit=Composition.pathDistance(province.points,x,y);
     const fade=Math.pow(1-hit.along,.65);
     ancient=Math.max(ancient,province.height*Math.exp(-Math.pow(hit.distance/province.width,2))*fade);
     continue;
    }

   }
   if(basementWeight>0)ancient=Math.max(ancient,basementHeight/basementWeight);
   for(const belt of plan.belts){
    const [x,y]=coords[belt.block],hit=Composition.pathDistance(belt.points,x,y);
    const interpolate=values=>values[hit.segment]*(1-hit.fraction)+values[hit.segment+1]*hit.fraction;
    const width=interpolate(belt.widths),strengthAlong=interpolate(belt.strengths);
    const envelope=smooth(hit.along/.12)*smooth((1-hit.along)/.12);
    const segment=.72+.28*Math.pow(Math.sin(hit.along*Math.PI*belt.segments+belt.phase),2);
    // Fold belts have a shared strike, with subsidiary ridges behind the
    // front. Offsets bend along strike; saddles stay within the same system.
    const across=hit.side*belt.inlandSide;
    let crest=0;
    for(let j=0;j<belt.strands;j++){
     const offset=j*width*1.40+width*.22*Math.sin(hit.along*12+belt.phase+j);
     crest=Math.max(crest,Math.pow(.66,j)*Math.exp(-Math.pow((across-offset)/(width*(.62+j*.10)),2)));
    }
    const peak=crest*segment*envelope;
    const inland=hit.side*belt.inlandSide>0;
    const skirtWidth=width*1.8+(inland?belt.hinterland:belt.foreland);
    const skirt=Math.exp(-Math.pow(hit.distance/skirtWidth,2))*envelope;
    const exposed=belt.old||belt.collision||blocks[belt.block].kind==='arc'?1:smooth((.19-best)/.10);
    const height=belt.amplitude*strengthAlong*(.78*peak+.22*skirt);
    // The front stays on an exposed margin. Its broad inherited shoulder
    // reaches inland; suppressing it by coast distance flattened every range
    // into the same thin ribbon. Ancient overlaps do not stack into domes.
    if(belt.old)ancient=Math.max(ancient,height);
    else {relief+=height*exposed;ancient=Math.max(ancient,belt.amplitude*strengthAlong*.28*skirt*(1-exposed));}
    const strength=peak*(belt.old?.18:1)*exposed;
    if(strength>map.r_orogeny[r]){
     const host=blocks[belt.block],strike=unit(host.u.map((v,k)=>v*hit.strike[0]+host.v[k]*hit.strike[1]));
     map.r_orogeny[r]=strength;map.r_orogenyDir.set(strike,3*r);
     if(host.kind==='arc'){map.r_arc[r]=peak;map.r_arcPeak[r]=peak;map.r_arcAge[r]=belt.age;map.r_arcDir.set(strike,3*r);}
    }
   }
   let lowland=0;
   for(const basin of plan.basins){
    const hit=Composition.pathDistance(basin.points,...coords[basin.block]);
    lowland=Math.max(lowland,basin.strength*Math.exp(-Math.pow(hit.distance/basin.width,2)));
   }
   h+=(relief+ancient*(1-lowland))*smooth(best/.035);
  }
  h+=(T.DEFAULTS.seaLevelThicknessKm-(options.seaLevelThicknessKm??T.DEFAULTS.seaLevelThicknessKm))*145;
  meters[r]=h;map.r_crust_type[r]=best>-shelf?T.CRUST_CONTINENTAL:T.CRUST_OCEANIC;
  map.r_crust_age[r]=35+110*smooth(-best/.7);
  map.r_thickness[r]=map.r_crust_type[r]===T.CRUST_CONTINENTAL?(options.seaLevelThicknessKm||33)+h/145:7;
 }
 // Static multi-site partition: continents anchor major plates, oceanic
 // plates fill the intervening basins. Boundary types are authored below.
 const oceanSites=[];
 const anchors=plan.plateSeeds;
 const requested=Math.round((options.plates||20)*(options.radiusKm||6371)/6371);
 const oceanCount=clamp(requested-anchors.length,3,16);
 for(let k=0;k<oceanCount;k++){
  let best=-Infinity,pick=0;for(let trial=0;trial<150;trial++){
   const r=Math.floor(rand()*n);if(sd[r]>-.05)continue;
   const p=Array.from(map.r_xyz.slice(r*3,r*3+3));let score=-sd[r];
   for(const s of oceanSites)score=Math.min(score,Math.acos(clamp(dot(p,s),-1,1)));
   if(score>best){best=score;pick=r;}
  }oceanSites.push(Array.from(map.r_xyz.slice(pick*3,pick*3+3)));
 }
 map.plates=[...anchors,...oceanSites].map((c,id)=>({id,name:`${id<anchors.length?'C':'O'}${id+1}`,pole:c,omega:0,sites:[c],bornMyr:-Math.round(40+rand()*160),parent:-1,scale:1}));
 map.r_plate=new Int32Array(n);map.plate_is_ocean=new Set(oceanSites.map((_,i)=>anchors.length+i));
 for(let r=0;r<n;r++){
  if(sd[r]>0){map.r_plate[r]=blocks[owner[r]].group;continue;}
  const p=Array.from(map.r_xyz.slice(r*3,r*3+3));
  let best=types[r]==='active'?Infinity:-sd[r],pick=blocks[owner[r]].group;
  oceanSites.forEach((s,k)=>{const d=Math.acos(clamp(dot(p,s),-1,1))*.6;if(d<best){best=d;pick=anchors.length+k;}});
  let marineCost=Infinity;
  for(const system of plan.marine){
   const last=system.points.at(-1),end=[last[0]+system.normal[0]*.35,last[1]+system.normal[1]*.35];
   const xy=coordinates[r][system.host],hit=Composition.pathDistance([...system.points,end],...xy);
   const outer=Composition.pathDistance(system.trench,...xy);
   const arc=Composition.pathDistance(system.arc,...xy);
   const side=(xy[0]-system.center[0])*system.normal[0]+(xy[1]-system.center[1])*system.normal[1];
   const outerSide=(xy[0]-system.arc[3][0])*system.normal[0]+(xy[1]-system.arc[3][1])*system.normal[1];
   const arcSide=(xy[0]-arc.point[0])*system.normal[0]+(xy[1]-arc.point[1])*system.normal[1];
   const behindArc=arcSide<.055&&arc.distance<.34&&(arc.along>.01&&arc.along<.99||arc.distance<.13);
   const cost=Math.min(hit.distance/.13,arc.distance/.34);
   if(((hit.distance<.13&&side<.70&&outerSide<.08)||(outer.distance<.07&&outerSide<0)||behindArc)&&cost<marineCost){pick=system.group;marineCost=cost;}
  }
  map.r_plate[r]=pick;
 }
 connectPartition(mesh,map);
 // Cleanup can accrete a whole basin, or just an island cut off by a
 // continental promontory. Retain the island's extinct history without
 // claiming active uplift on a plate that no longer owns it.
 for(const [index,block] of blocks.entries())if(block.kind==='arc'){
  const exposed=[];
  for(let r=0;r<n;r++){
   if(sd[r]<=0||Composition.nearestEdge(block,...coordinates[r][index]).sd<=0)continue;
   if(blocks.some((b,i)=>b.kind!=='arc'&&Composition.nearestEdge(b,...coordinates[r][i]).sd>0))continue;
   exposed.push(r);
  }
  block.status=exposed.length&&exposed.every(r=>map.plates[map.r_plate[r]].id===block.group)?'active':'accreted';
  if(block.status==='accreted')for(let r=0;r<n;r++)if(owner[r]===index&&map.r_arc[r]>0){
   map.r_arc[r]=0;map.r_orogeny[r]*=.18;
  }
 }
 for(const system of plan.marine){
  system.status=blocks.some(b=>b.kind==='arc'&&b.group===system.group&&b.status==='active')?'active':'accreted';
  if(system.status==='active')continue;
  for(let r=0;r<n;r++)if(blocks[owner[r]].group===system.group&&map.r_arc[r]>0){
   map.r_arc[r]=0;map.r_arcAge[r]=system.age;map.r_orogeny[r]*=.18;
  }
 }
 map.plate_is_ocean=new Set(map.plates.flatMap((p,i)=>p.id>=anchors.length?[i]:[]));
 const neighbors=[],edges=[];
 for(let r=0;r<n;r++){
  mesh.r_circulate_r(neighbors,r);
  for(const q of neighbors)if(q>r&&map.r_plate[r]!==map.r_plate[q]){
   const a=map.plates[map.r_plate[r]].id,b=map.plates[map.r_plate[q]].id;
   let type=T.BOUNDARY_DIVERGENT,role='spreading';
   const collision=plan.events.find(e=>e.type==='collision'&&[a,b].includes(blocks[e.host].group)&&[a,b].includes(blocks[e.child].group));
   const system=plan.marine.find(s=>s.status==='active'&&(s.group===a||s.group===b));
   if(collision&&Math.max(sd[r],sd[q])>-.025){type=T.BOUNDARY_CONVERGENT;role='collision';}
   else if(system){
    const d=Math.min(Composition.pathDistance(system.trench,...coordinates[r][system.host]).distance,Composition.pathDistance(system.trench,...coordinates[q][system.host]).distance);
    type=d<.14?T.BOUNDARY_CONVERGENT:T.BOUNDARY_TRANSFORM;role=d<.14?'subduction':'basin-transform';
   }else if(Math.max(sd[r],sd[q])>-.075){
    type=types[r]==='active'||types[q]==='active'?T.BOUNDARY_CONVERGENT:T.BOUNDARY_TRANSFORM;
    role=type===T.BOUNDARY_CONVERGENT?'subduction':'continental-transform';
   }
   const edge={r,q,a,b,type,role};
   if(role==='subduction'){
    edge.overriding=system?system.group:sd[r]>sd[q]?a:b;
    edge.subducting=edge.overriding===a?b:a;
   }
   edges.push(edge);
  }
 }
 // Opening boundaries change to transform where their strike follows the
 // pair's extension axis. Each pair has one axis; no random modulo labels.
 const pairAxes=new Map();
 for(const e of edges)if(e.role==='spreading'){
  const key=[e.a,e.b].sort((a,b)=>a-b).join(':'),pa=map.plates[map.r_plate[e.r]].pole,pb=map.plates[map.r_plate[e.q]].pole;
  if(!pairAxes.has(key))pairAxes.set(key,unit(pb.map((v,k)=>v-pa[k])));
  const axis=pairAxes.get(key),normal=unit(Array.from(map.r_xyz.slice(e.q*3,e.q*3+3)).map((v,k)=>v-map.r_xyz[e.r*3+k]));
  if(Math.abs(dot(axis,normal))<.33){e.type=T.BOUNDARY_TRANSFORM;e.role='ridge-transform';}
 }
 // Both cells of an edge receive the same role. Convergence wins at a
 // junction, then spreading; neighbor iteration order never decides it.
 const priority=t=>t===T.BOUNDARY_CONVERGENT?3:t===T.BOUNDARY_DIVERGENT?2:t===T.BOUNDARY_TRANSFORM?1:0;
 const trenchCells=new Set();
 for(const e of edges){
  for(const r of [e.r,e.q])if(priority(e.type)>priority(map.r_boundary[r]))map.r_boundary[r]=e.type;
  if(e.role==='subduction')trenchCells.add(e.subducting===e.a?e.r:e.q);
 }
 plan.interactions=edges;
 // Age is distance from the authored spreading system. Interpolated cooling
 // replaces the first prototype's hard ridge steps.
 const hops=new Int32Array(n);hops.fill(-1);const queue=[];
 for(let r=0;r<n;r++)if(sd[r]<0&&map.r_boundary[r]===T.BOUNDARY_DIVERGENT){hops[r]=0;queue.push(r);}
 for(let i=0;i<queue.length;i++){const r=queue[i];mesh.r_circulate_r(neighbors,r);for(const q of neighbors)if(sd[q]<0&&hops[q]<0){hops[q]=hops[r]+1;queue.push(q);}}
 for(let r=0;r<n;r++)if(sd[r]<0){
  const p=map.r_xyz.slice(r*3,r*3+3);let age=Math.min(190,3+Math.max(0,hops[r])*9);
  for(const system of plan.marine){
   const sea=plan.seas[system.sea];
   if(map.plates[map.r_plate[r]].id===system.group||Composition.nearestEdge(sea,...Composition.project(sea,p)).sd>0)age=system.age;
  }
  map.r_crust_age[r]=age;
  const slope=smooth((-sd[r]-shelfWidths[r])/(.065+shelfWidths[r]*.65)),old=-T.oceanDepthMeters(35+110*smooth(-sd[r]/.7));
  meters[r]+=slope*(-T.oceanDepthMeters(age)+old*-1+80*macro(p));
  if(trenchCells.has(r))meters[r]-=1600*slope;
 }
 map.r_meters=meters;for(let r=0;r<n;r++)map.r_elevation[r]=T.metersToElevation(meters[r]);
 map.hotspots=[];map.extra_ocean_seeds=[];map.elapsedMyr=0;map.nextPlateId=Math.max(...map.plates.map(p=>p.id))+1;map.targetPlateCount=map.plates.length;
 map.layoutHistory=plan;
 return map;
}
module.exports={generate,compose,collapseMargins};

