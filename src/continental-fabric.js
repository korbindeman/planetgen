/* Continental crust assembled from joined regional polygons. These are
 * terranes within a continent, not the present-day plate partition.
 */
'use strict';
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const intersects=(a,b,c,d)=>cross(a,b,c)*cross(a,b,d)<-1e-12&&cross(c,d,a)*cross(c,d,b)<-1e-12;
function inside(poly,p){
 let yes=false;
 for(let i=0,j=poly.length-1;i<poly.length;j=i++){
  const a=poly[i],b=poly[j];
  if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;
 }
 return yes;
}
function outline(rand,length,width,form){
 // Start with an irregular craton, then weld polygons across exposed fronts.
 // The outline is the union boundary itself; there is no radial envelope.
 let verts=[[-.38,-.14],[-.17,-.34],[.22,-.27],[.39,.02],[.18,.29],[-.23,.24]];
 verts=verts.map(([x,y])=>[x*(.8+rand()*.4),y*(.8+rand()*.4)]);
 const terranes=[{verts:verts.map(p=>p.slice()),generation:0,parent:-1}],contacts=[];
 const count=form==='broad'?23:form==='compact'?12:17;
 const fronts=verts.map(()=>0),owners=verts.map(()=>0),preferred=rand()<.5?-1:1;
 let roots=0;
 for(let step=0;step<count;step++){
  let chosen=null;
  for(let attempt=0;attempt<70&&!chosen;attempt++){
   const weights=verts.map((a,k)=>{
    const b=verts[(k+1)%verts.length],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);
    return (fronts[k]===0&&roots>=3?0:len*Math.pow(.25+Math.abs(dy)/len,1.5)*(1+.45*fronts[k]));
   });
   let pick=rand()*weights.reduce((a,b)=>a+b,0),k=0;
   while(k<weights.length-1&&pick>weights[k])pick-=weights[k++];
   const start=verts[k],end=verts[(k+1)%verts.length];
   // Accretion occupies part of a front. Keeping the rest exposed leaves
   // bays between terranes instead of replacing each edge with a trapezoid.
   const share=.55+rand()*.35,offset=(1-share)*(.15+rand()*.70);
   const a=start.map((v,j)=>v+(end[j]-v)*offset),b=start.map((v,j)=>v+(end[j]-v)*(offset+share));
   const dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);
   if(len<.07)continue;
   const nx=dy/len,ny=-dx/len,depth=len*(.45+rand()*.75)/(1+.22*fronts[k]);
   const shift=(rand()-.5)*len*.60,front=.50+rand()*.38;
   const center=[(a[0]+b[0])*.5+nx*depth+dx/len*shift,(a[1]+b[1])*.5+ny*depth+dy/len*shift];
   const p=[center[0]-dx*front*.5,center[1]-dy*front*.5];
   const q=[center[0]+dx*front*.5,center[1]+dy*front*.5];
   if(inside(verts,p)||inside(verts,q))continue;
   const edges=[[a,p],[p,q],[q,b]];
   if(edges.some(([c,d])=>verts.some((v,i)=>i!==k&&intersects(c,d,v,verts[(i+1)%verts.length]))))continue;
   // Keep a branch shorter on one side of a pendant assembly. This is a
   // directional accretion bias, not a named continent or fixed longitude.
   if(form==='pendant'&&center[0]*preferred>.25&&Math.abs(center[1])>.55)continue;
   chosen={k,a,b,p,q,start,end};
  }
  if(!chosen)continue;
  const {k,a,b,p,q,start,end}=chosen,generation=fronts[k]+1,parent=owners[k];
  if(generation===1)roots++;
  verts.splice(k+1,0,a,p,q,b);fronts.splice(k,1,generation-1,generation,generation,generation,generation-1);
  owners.splice(k,1,parent,terranes.length,terranes.length,terranes.length,parent);
  const boundary=terranes[parent].verts,edge=boundary.findIndex((v,i)=>
   Math.hypot(v[0]-start[0],v[1]-start[1])<1e-10&&
   Math.hypot(boundary[(i+1)%boundary.length][0]-end[0],boundary[(i+1)%boundary.length][1]-end[1])<1e-10);
  if(edge<0)throw new Error('Accretion front lost its parent terrane');
  boundary.splice(edge+1,0,a.slice(),b.slice());
  terranes.push({verts:[a.slice(),p.slice(),q.slice(),b.slice()],generation,parent});
  contacts.push({points:[a.slice(),b.slice()],parent,child:terranes.length-1});
 }
 const xs=verts.map(p=>p[0]),ys=verts.map(p=>p[1]);
 const x0=(Math.min(...xs)+Math.max(...xs))*.5,y0=(Math.min(...ys)+Math.max(...ys))*.5;
 const sx=length/(Math.max(...xs)-Math.min(...xs)),sy=width*1.65/(Math.max(...ys)-Math.min(...ys));
 const fit=p=>[(p[0]-x0)*sx,(p[1]-y0)*sy];
 const fabric={verts:verts.map(fit),terranes:terranes.map(t=>({...t,verts:t.verts.map(fit)})),contacts:contacts.map(c=>({...c,points:c.points.map(fit)})),fragments:[]};
 // Open one old contact beneath a peripheral terrane. The two facing coasts
 // are the same inherited edge, separated by a resolvable marine strait.
 const leaves=fabric.terranes.map((t,i)=>({t,i})).filter(({t,i})=>t.generation>1&&!terranes.some(p=>p.parent===i));
 if(leaves.length&&rand()<.80){
  const {t,i}=leaves[Math.floor(rand()*leaves.length)],contact=fabric.contacts.find(c=>c.child===i);
  const [a,p,q,b]=t.verts,k=fabric.verts.findIndex(v=>Math.hypot(v[0]-p[0],v[1]-p[1])<1e-9);
  if(k>=0&&k+1<fabric.verts.length&&Math.hypot(fabric.verts[k+1][0]-q[0],fabric.verts[k+1][1]-q[1])<1e-9){
   const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),gap=.085+rand()*.035;
   const moved=t.verts.map(v=>[v[0]+dy/length*gap,v[1]-dx/length*gap]);
   const mainland=fabric.verts.filter((_,j)=>j!==k&&j!==k+1);
   const overlap=moved.some(p=>inside(mainland,p))||mainland.some(p=>inside(moved,p))||
    moved.some((a,j)=>mainland.some((b,h)=>intersects(a,moved[(j+1)%moved.length],b,mainland[(h+1)%mainland.length])));
   if(!overlap){
    t.verts=moved;t.detached=true;contact.rift=true;fabric.verts=mainland;
    fabric.fragments.push({verts:t.verts.map(p=>p.slice()),terrane:i});
   }
  }
 }
 const centers=fabric.terranes.map(t=>t.verts.reduce((c,p)=>[c[0]+p[0]/t.verts.length,c[1]+p[1]/t.verts.length],[0,0]));
 let ends=[0,0],longest=0;
 for(let i=0;i<centers.length;i++)for(let j=i+1;j<centers.length;j++){
  if(fabric.terranes[i].detached||fabric.terranes[j].detached)continue;
  const d=Math.hypot(centers[i][0]-centers[j][0],centers[i][1]-centers[j][1]);
  if(d>longest){longest=d;ends=[i,j];}
 }
 const ancestors=i=>{const path=[];for(;i>=0;i=fabric.terranes[i].parent)path.push(i);return path;};
 const a=ancestors(ends[0]),b=ancestors(ends[1]),join=a.find(i=>b.includes(i));
 const ids=[...a.slice(0,a.indexOf(join)+1),...b.slice(0,b.indexOf(join)).reverse()],path=[centers[ids[0]]];
 for(let k=1;k<ids.length;k++){
  const contact=fabric.contacts.find(c=>c.child===ids[k]&&c.parent===ids[k-1]||c.child===ids[k-1]&&c.parent===ids[k]);
  path.push(contact.points[0].map((v,j)=>(v+contact.points[1][j])*.5),centers[ids[k]]);
 }
 const lengths=path.slice(1).map((p,k)=>Math.hypot(p[0]-path[k][0],p[1]-path[k][1])),total=lengths.reduce((a,b)=>a+b,0);
 fabric.spine=Array.from({length:9},(_,k)=>{
  if(path.length===1)return path[0].slice();
  let distance=total*k/8,edge=0;
  while(edge<lengths.length-1&&distance>lengths[edge])distance-=lengths[edge++];
  const t=distance/(lengths[edge]||1);
  return path[edge].map((v,j)=>v*(1-t)+path[edge+1][j]*t);
 });
 // Regional shear bends the assembled crust and all of its contacts
 // together. Sequential shears are invertible: they cannot tear terranes
 // apart or put two unrelated contacts on top of each other. Subdivision
 // resolves the bend, rather than independently roughening polygon edges.
 const phase=rand()*Math.PI*2,phase2=rand()*Math.PI*2;
 const shear=p=>{
  let [x,y]=p;
  x+=length*.040*Math.sin(y/width*5.2+phase);
  y+=width*.085*Math.sin(x/length*9.0+phase2);
  x+=length*.015*Math.sin(y/width*11+phase2);
  return [x,y];
 };
 const subdivide=poly=>poly.flatMap((p,i)=>{
  const q=poly[(i+1)%poly.length];
  const count=Math.max(1,Math.ceil(Math.hypot((q[0]-p[0])/length,(q[1]-p[1])/width)/.12));
  return Array.from({length:count},(_,k)=>p.map((v,j)=>v+(q[j]-v)*k/count));
 });
 fabric.verts=subdivide(fabric.verts);
 for(const t of fabric.terranes)t.verts=subdivide(t.verts);
 for(const f of fabric.fragments)f.verts=subdivide(f.verts);
 transform(fabric,shear);
 fabric.deformation={kind:'regional-shear',phase,phase2};
 return fabric;
}
function transform(fabric,fn){
 fabric.verts=fabric.verts.map(fn);
 for(const terrane of fabric.terranes)terrane.verts=terrane.verts.map(fn);
 for(const contact of fabric.contacts)contact.points=contact.points.map(fn);
 for(const fragment of fabric.fragments)fragment.verts=fragment.verts.map(fn);
 fabric.spine=fabric.spine.map(fn);
}
module.exports={outline,transform};
