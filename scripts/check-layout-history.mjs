/** Contract checks for the static history path, not an aesthetic score. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Planet=require('../src/planet');
const Artifact=require('../src/layout-artifact');
const Composition=require('../src/layout-composition');
const T=require('../src/tectonics');
function waterComponents(mesh,heights){
 const seen=new Uint8Array(heights.length),nb=[],sizes=[];
 for(let r=0;r<heights.length;r++)if(heights[r]<0&&!seen[r]){
  const q=[r];seen[r]=1;
  for(let i=0;i<q.length;i++){mesh.r_circulate_r(nb,q[i]);for(const j of nb)if(heights[j]<0&&!seen[j]){seen[j]=1;q.push(j);}}
  sizes.push(q.length);
 }
 return sizes;
}
function assertSimpleOutline(verts,label){
 const side=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
 for(let i=0;i<verts.length;i++)for(let j=i+2;j<verts.length;j++){
  if(i===0&&j===verts.length-1)continue;
  const a=verts[i],b=verts[(i+1)%verts.length],c=verts[j],d=verts[(j+1)%verts.length];
  assert(!(side(a,b,c)*side(a,b,d)<-1e-14&&side(c,d,a)*side(c,d,b)<-1e-14),label);
 }
}
// A failing geometry seed can be rerun without rebuilding the whole review.
// With no flag this remains the two standard consecutive batches.
const selected=process.argv.find(arg=>arg.startsWith('--seeds='));
const seeds=selected?selected.slice(8).split(',').map(Number):[...Array.from({length:12},(_,i)=>i+1),...Array.from({length:12},(_,i)=>i+101)];
assert(seeds.length&&seeds.every(seed=>Number.isInteger(seed)&&seed>0&&seed<=2147483647),'--seeds needs comma-separated positive integer seeds');
for(const seed of seeds){
 const p=Planet.generatePlanet({seed,detailPass:false,quiet:true});
 const m=p.sim.map,n=p.sim.mesh.numRegions;
 assert.equal(m.elapsedMyr,0);
 assert(m.plates.every(p=>p.omega===0),'static plate records');
 assert.equal(waterComponents(p.sim.mesh,m.r_meters).length,1,`seed ${seed}: physical elevation has one world ocean`);
 assert.equal(waterComponents(p.sim.mesh,m.r_elevation).length,1,`seed ${seed}: display elevation has one world ocean`);
 for(let r=0;r<n;r++)assert.equal(m.r_meters[r]>0,m.r_elevation[r]>0,`seed ${seed}: coast sign agrees across fields`);
 for(const name of [...Artifact.F32,...Artifact.PACKED3]){
  assert(m[name],name);
  assert(Array.from(m[name]).every(Number.isFinite),`seed ${seed}: finite ${name}`);
 }
 for(let r=0;r<n;r++){
  assert(m.r_plate[r]>=0 && m.r_plate[r]<m.plates.length,'valid ownership');
  assert(!(m.r_elevation[r]>0 && Math.abs(m.r_xyz[r*3+2])>Math.sin(70*Math.PI/180)),`seed ${seed}: polar ocean`);
 }
 for(const b of m.layoutHistory.blocks)for(let k=0;k<8;k++){
  const a=b.margins[k],c=b.margins[(k+1)%8];
  assert(!(a==='active'&&c==='rift'||a==='rift'&&c==='active'),'compatible boundary history');
 }
 for(const b of [...m.layoutHistory.blocks,...m.layoutHistory.seas])assertSimpleOutline(b.verts,`seed ${seed}: ${b.kind} has no crossing outline edges`);
 for(const b of m.layoutHistory.blocks)if(b.kind==='core')
  assert(b.fabric?.terranes.length>1,`seed ${seed}: separated companions retain regional crust`);
 for(const b of m.layoutHistory.blocks)if(b.fabric){
  const {terranes,contacts,fragments,spine}=b.fabric;
  assert(spine.flat().every(Number.isFinite),'finite regional spine');
  terranes.forEach((t,i)=>{
   assertSimpleOutline(t.verts,`seed ${seed}: terrane ${i} is uncrossed`);
   assert(i===0?t.parent===-1:t.parent>=0&&t.parent<i,'regional assembly has no cycles');
  });
  for(const c of contacts){
   assert.equal(terranes[c.child].parent,c.parent,'contact follows the assembly tree');
   if(!c.rift)for(const p of c.points)for(const i of [c.parent,c.child])
    assert(terranes[i].verts.some(q=>Math.hypot(p[0]-q[0],p[1]-q[1])<1e-8),'contact joins both terrane boundaries');
  }
  for(const f of fragments)assert(terranes[f.terrane].detached,'fragment is detached regional crust');
 }
 // The source geometry must reserve water between independent assemblies.
 // Sample edge interiors too: separated centres or vertices alone can miss
 // long crossing edges. Colliders and explicit incomplete-rift necks can
 // deliberately join a pair, but cannot chain unrelated assemblies together.
 const independent=m.layoutHistory.blocks.filter(b=>['core','welded','fragment'].includes(b.kind));
 for(const a of independent)for(const b of independent)if(a.group!==b.group){
  for(let k=0;k<a.verts.length;k++){
   const v=a.verts[k],w=a.verts[(k+1)%a.verts.length];
   for(const t of [0,.5]){
    const xyz=Composition.world(a,v[0]*(1-t)+w[0]*t,v[1]*(1-t)+w[1]*t);
    assert(Composition.nearestEdge(b,...Composition.project(b,xyz)).sd<-.06,
     `seed ${seed}: unrelated continental outlines preserve an ocean gap`);
   }
  }
 }
 const fields=Artifact.toFields(Artifact.fromMap(m,{seed,n}));
 assert.deepEqual(fields.layoutHistory,m.layoutHistory,'snapshot retains authored history');
 const necks=m.layoutHistory.events.filter(e=>e.type==='incomplete-rift');
 assert(necks.length<=1,'at most one retained continental neck');
 for(const [index,block] of m.layoutHistory.blocks.entries())if(block.kind==='core'&&block.parentCore>=0){
  assert(block.parentCore<index,'continental relationship has no forward references');
  assert.equal(m.layoutHistory.blocks[block.parentCore].kind,'core','companion refers to a continental core');
 }
 for(const event of m.layoutHistory.events){
  assert(m.layoutHistory.blocks[event.host], 'event has a host');
  if(event.type==='continental-extension'){
   assert(m.layoutHistory.blocks[event.host].fabric.contacts.some(c=>c.child===event.contact),'extension retains its inherited contact');
   assert.equal(m.layoutHistory.seas[event.sea].kind,'rift-embayment');
  }
  if(event.type==='rift-remnant'){
   const host=m.layoutHistory.blocks[event.host],child=m.layoutHistory.blocks[event.child];
   assert(child&&child.kind==='fragment'&&child.group===host.group,'rift remnant keeps its continental plate');
  }
  if(event.type==='separated-margin'||event.type==='incomplete-rift'){
   const host=m.layoutHistory.blocks[event.host],child=m.layoutHistory.blocks[event.child];
   assert(child&&child.group!==host.group,'related continents retain distinct crustal ownership');
   if(event.type==='incomplete-rift'){
    const bridge=m.layoutHistory.blocks[event.bridge];
    assert(bridge&&bridge.kind==='isthmus'&&bridge.group===child.group,'retained connection belongs to its child');
    assert.equal(host.group,1,'a retained connection cannot accrete the largest assembly');
   }
  }
  if(event.type!=='collision')continue;
  const host=m.layoutHistory.blocks[event.host],child=m.layoutHistory.blocks[event.child];
  assert(child && child.group!==host.group,'collider has distinct crustal ownership');
  const contact=Composition.world(host,...event.contact);
  let supported=false;
  for(let r=0;r<n;r++){
   const dot=contact[0]*m.r_xyz[r*3]+contact[1]*m.r_xyz[r*3+1]+contact[2]*m.r_xyz[r*3+2];
   if(dot>Math.cos(.13) && m.r_meters[r]>500 && m.r_orogeny[r]>.15){supported=true;break;}
  }
  assert(supported,`seed ${seed}: collision survives coastline and sea composition`);
 }
 const seen=new Uint8Array(n),nb=[],components=Array(m.plates.length).fill(0),sizes=Array(m.plates.length).fill(0);
 for(let r=0;r<n;r++)if(!seen[r]){const id=m.r_plate[r],q=[r];seen[r]=1;components[id]++;
  for(let i=0;i<q.length;i++){sizes[id]++;p.sim.mesh.r_circulate_r(nb,q[i]);for(const j of nb)if(!seen[j]&&m.r_plate[j]===id){seen[j]=1;q.push(j);}}
 }
 console.log(`seed ${seed}: ${m.plates.length} plates; components ${components.join(',')}`);
 assert(components.every(c=>c===1),`seed ${seed}: plates are single connected bodies`);
 const touches=m.plates.map(()=>new Set());
 for(let r=0;r<n;r++){p.sim.mesh.r_circulate_r(nb,r);for(const q of nb)if(m.r_plate[r]!==m.r_plate[q])touches[m.r_plate[r]].add(m.r_plate[q]);}
 assert(touches.every(t=>t.size>1),`seed ${seed}: no enclave plates`);
 for(const system of m.layoutHistory.marine){
  if(system.status!=='active')continue;
  for(const b of m.layoutHistory.blocks.filter(b=>b.kind==='arc'&&b.group===system.group&&b.status==='active')){
   for(let r=0;r<n;r++){
    if(m.r_meters[r]<=0)continue;
    const xyz=m.r_xyz.slice(r*3,r*3+3);
    if(Composition.nearestEdge(b,...Composition.project(b,xyz)).sd<=0)continue;
    // Where arc and continental crust overlap, the union may weld them.
    if(m.layoutHistory.blocks.some(a=>a.kind!=='arc'&&Composition.nearestEdge(a,...Composition.project(a,xyz)).sd>0))continue;
    assert.equal(m.plates[m.r_plate[r]].id,b.group,`seed ${seed}: exposed active arc stays on its overriding plate`);
   }
  }
 }
 for(const e of m.layoutHistory.interactions){
  assert.notEqual(m.r_plate[e.r],m.r_plate[e.q],'record describes an actual boundary');
  if(e.role==='collision')assert.equal(e.type,T.BOUNDARY_CONVERGENT);
  if(e.role==='spreading')assert(m.r_meters[e.r]<0&&m.r_meters[e.q]<0,'spreading stays offshore');
  if(e.role==='subduction'){
   assert.notEqual(e.overriding,e.subducting,'subduction has polarity');
   assert([e.a,e.b].includes(e.overriding)&&[e.a,e.b].includes(e.subducting),'polarity refers to the touching plates');
  }
 }
}
const a=Planet.generatePlanet({seed:19,simSteps:1,quiet:true});
const b=Planet.generatePlanet({seed:19,simSteps:60,quiet:true});
assert.deepEqual(a.sim.map.r_meters,b.sim.map.r_meters,'no time integration');
console.log('static history contracts passed');
