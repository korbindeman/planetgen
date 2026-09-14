/* Continental assemblies, expressed as substantial crustal bodies and margins.
 * History is composed in place: no Euler integration, no reference outlines.
 * Large bays are negative space between branches, not noise in a round mask.
 */
'use strict';
const {makeRandFloat} = require('@redblobgames/prng');
const Fabric = require('./continental-fabric');
const TAU = Math.PI * 2;
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
const dot = (a,b) => a.reduce((s,v,k)=>s+v*b[k],0);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit = a => {const n=Math.hypot(...a)||1;return a.map(x=>x/n);};
function crosses(a,b,c,d) {
 const orient=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
 return orient(a,b,c)*orient(a,b,d)<-1e-14&&orient(c,d,a)*orient(c,d,b)<-1e-14;
}
function simpleOutline(verts) {
 // A bent peninsula or displaced subdivision can fold an edge back across
 // its neighbour. Uncrossing two edges reduces perimeter and preserves the
 // authored vertices, unlike a convex hull which would erase all the bays.
 const v=verts.slice();
 for(let pass=0;pass<v.length*v.length;pass++){
  let fixed=false;
  for(let i=0;i<v.length&&!fixed;i++)for(let j=i+2;j<v.length;j++){
   if(i===0&&j===v.length-1)continue;
   if(!crosses(v[i],v[(i+1)%v.length],v[j],v[(j+1)%v.length]))continue;
   v.splice(i+1,j-i,...v.slice(i+1,j+1).reverse());fixed=true;break;
  }
  if(!fixed)return v;
 }
 throw new Error('Could not uncross continental outline');
}
function world(b,x,y) {
 const r=Math.hypot(x,y),s=r?Math.sin(r)/r:1;
 return b.c.map((v,k)=>v*Math.cos(r)+(b.u[k]*x+b.v[k]*y)*s);
}
function project(b,p) {
 const d=clamp(dot(b.c,p),-1,1),r=Math.acos(d),s=r/Math.max(1e-8,Math.sqrt(1-d*d));
 return [dot(b.u,p)*s,dot(b.v,p)*s];
}
function frame(c,angle) {
 const east=unit(cross([0,0,1],c)),north=cross(c,east);
 return [east.map((v,k)=>v*Math.cos(angle)+north[k]*Math.sin(angle)),east.map((v,k)=>-v*Math.sin(angle)+north[k]*Math.cos(angle))];
}
function nearestEdge(b,x,y) {
 let inside=false,best=Infinity,edge=0;
 for(let k=0;k<b.verts.length;k++){
  const a=b.verts[k],c=b.verts[(k+1)%b.verts.length],dx=c[0]-a[0],dy=c[1]-a[1];
  if((a[1]>y)!==(c[1]>y)&&x<dx*(y-a[1])/dy+a[0])inside=!inside;
  const t=clamp(((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy),0,1);
  const ox=x-a[0]-t*dx,oy=y-a[1]-t*dy,d=ox*ox+oy*oy;
  if(d<best){best=d;edge=k;}
 }
 return {sd:(inside?1:-1)*Math.sqrt(best),edge};
}
function pathDistance(points,x,y) {
 let distance=Infinity,strike=[1,0],side=0,along=0,segment=0,fraction=0,point=points[0];
 for(let k=0;k<points.length-1;k++){
  const a=points[k],b=points[k+1],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);
  if(len<1e-10)continue;
  const t=clamp(((x-a[0])*dx+(y-a[1])*dy)/(len*len),0,1),ox=x-a[0]-t*dx,oy=y-a[1]-t*dy,d=Math.hypot(ox,oy);
  if(d<distance){distance=d;strike=[dx/len,dy/len];side=(dx*oy-dy*ox)/len;along=(k+t)/(points.length-1);segment=k;fraction=t;point=[a[0]+t*dx,a[1]+t*dy];}
 }
 return {distance,strike,side,along,segment,fraction,point};
}
function compose(seed,options,collapseMargins) {
 const rand=makeRandFloat(seed^0x28f93a71),placeRand=makeRandFloat(seed^0x451acd23),blocks=[],belts=[],provinces=[],basins=[],seas=[],plateSeeds=[],events=[],marine=[];
 const regionRand=makeRandFloat(seed^0x713ea593),riftRand=makeRandFloat(seed^0x184f9c21);
 const flip=rand()<.5?-1:1,mirror=rand()<.5?-1:1,origin=rand()*TAU;
 const scale=Math.sqrt(clamp((options.continentFraction||.42)/.42,.75,1.2));
 const position=(lon,lat)=>[Math.cos(lat)*Math.cos(lon),Math.cos(lat)*Math.sin(lon),Math.sin(lat)];
 function ribbon(c,length,width,angle,group,kind='core',fit=true,form='ribbon') {
  // Shrinking cannot rescue a polygon whose centre is already polar.
  const latitude=clamp(Math.asin(c[2]),-.98,.98),longitude=Math.atan2(c[1],c[0]);
  c=[Math.cos(latitude)*Math.cos(longitude),Math.cos(latitude)*Math.sin(longitude),Math.sin(latitude)];
  const [u,v]=frame(c,angle),phase=rand()*TAU;
  const b={c,u,v,size:length*.5,kind,group,margins:collapseMargins(rand),age:40+180*rand(),upland:rand(),phase,verts:[]};
  let spine=[];
  const solid=['welded','fragment','isthmus'].includes(kind);
  if(kind==='core'){
   const fabric=Fabric.outline(regionRand,length,width,form);
   b.verts=fabric.verts;b.fabric=fabric;spine=fabric.spine;
  }else{
   const upper=[],lower=[],taper=rand()<.5?-1:1;
   for(let k=0;k<7;k++){
    const t=k/6,x=(t-.5)*length,y=width*(.18*Math.sin(t*5+phase)+.10*(rand()-.5));
    const envelope=k===0||k===6?(solid?.20:.06):.75*Math.pow(Math.sin(t*Math.PI),.65);
    const broad=1+.6*taper*(t-.5);
    spine.push([x,y]);
    upper.push([x,y+width*envelope*broad*(.75+.4*rand())]);
    lower.push([x,y-width*envelope/broad*(.75+.4*rand())]);
   }
   b.verts=[...upper,...lower.reverse()];
   if(kind==='collider')b.verts=[[-length*.55,0],[-length*.12,width*.25],[length*.34,width*.58],[length*.48,width*.20],[length*.35,-width*.50],[-length*.08,-width*.34]];
  }
  // Regional coast bends preserve the terrane union and its larger bays.
  for(let pass=0;pass<2;pass++){
   const next=[];
   for(let k=0;k<b.verts.length;k++){
    const a=b.verts[k],z=b.verts[(k+1)%b.verts.length],dx=z[0]-a[0],dy=z[1]-a[1];
    const bend=(rand()-.5)*(kind==='core'?.18:solid?.22:.42),t=.35+.3*rand();
    next.push(a,[a[0]+t*dx+dy*bend,a[1]+t*dy-dx*bend]);
   }b.verts=next;
  }
  b.verts=simpleOutline(b.verts);
  // Fit the actual polygon; do not cut it off at a line of latitude.
  let fitX=1,fitY=1;
  const northX=Math.abs(u[2]),northY=Math.abs(v[2]),northMax=Math.max(northX,northY,.01);
  for(let pass=0;fit&&pass<24;pass++){
   if(b.verts.every(p=>Math.abs(world(b,p[0]*fitX,p[1]*fitY)[2])<Math.sin(1.13)))break;
   // Fit latitude without needlessly shrinking the east-west reach as well.
   fitX*=1-.06*northX/northMax;fitY*=1-.06*northY/northMax;
  }
  b.verts=b.verts.map(([x,y])=>[x*fitX,y*fitY]);b.spine=spine.map(([x,y])=>[x*fitX,y*fitY]);b.size*=fitX;
  if(b.fabric)Fabric.transform(b.fabric,([x,y])=>[x*fitX,y*fitY]);
  b.width=width*fitY;b.length=length*fitX;
  blocks.push(b);return b;
 }
 function clearance(a,b) {
  let gap=Infinity;
  for(const [from,to] of [[a,b],[b,a]])for(const p of from.verts){
   gap=Math.min(gap,-nearestEdge(to,...project(to,world(from,...p))).sd);
  }
  return gap;
 }
 function core(lon,lat,len,w,angle,role,parent=-1) {
  const group=plateSeeds.length,b=ribbon(position(lon,lat),len*scale,w*scale,angle,group,'core',false,role);
  b.role=role;b.parentCore=parent;
  blocks.pop();let selected=null,best=Infinity;
  // Place complete outlines, not just their centres. A separate deterministic
  // stream makes placement retries independent of the later history grammar.
  for(let trial=0;trial<4480;trial++){
   if(trial>0&&trial%320===0){
    if(selected)break;
    b.verts=b.verts.map(p=>p.map(x=>x*.91));b.spine=b.spine.map(p=>p.map(x=>x*.91));
    if(b.fabric)Fabric.transform(b.fabric,p=>p.map(x=>x*.91));
    b.length*=.91;b.width*=.91;b.size*=.91;
   }
   const dx=trial%320===0?0:(placeRand()-.5)*(trial<640?1.5:TAU);
   const dy=trial%320===0?0:trial<640?(placeRand()-.5)*.65:(placeRand()-.5)*1.4-lat;
   const c=position(lon+dx,clamp(lat+dy,-.80,.80));
   const turn=(placeRand()-.5)*.55,orientation=angle+turn,[u,v]=frame(c,orientation);
   b.c=c;b.u=u;b.v=v;
   const parts=[b,...(b.fabric?.fragments||[]).map(f=>({...b,verts:f.verts}))];
   const polar=Math.max(...parts.flatMap(a=>a.verts.map(p=>Math.abs(world(b,...p)[2]))));
   if(polar>Math.sin(1.10))continue;
   let gap=Infinity;for(const other of blocks)for(const part of parts)gap=Math.min(gap,clearance(part,other));
   if(gap<.12)continue;
   const score=dx*dx*.35+dy*dy*2+turn*turn*.12;
   if(score<best){best=score;selected={c,u,v};}
   if(score<.004)break;
  }
  if(!selected)throw new Error(`No separated non-polar placement for ${role} core ${group}`);
  Object.assign(b,selected);blocks.push(b);plateSeeds.push(b.c);
  for(const fragment of b.fabric?.fragments||[]){
   const id=blocks.length,child={...b,verts:fragment.verts,kind:'fragment'};
   delete child.fabric;blocks.push(child);
   events.push({type:'rift-remnant',host:blocks.indexOf(b),child:id});
  }
  return b;
 }
 function separatedCore(host,length,width,offset) {
  const group=plateSeeds.length,id=blocks.indexOf(host);
  const b=ribbon(host.c,length*scale,width*scale,Math.PI*.5,group,'core',false,'pendant');
  blocks.pop();b.role='pendant';b.parentCore=id;
  const regional=b.fabric,source=b.verts;
  const all=[...source,...regional.terranes.flatMap(t=>t.verts),...regional.fragments.flatMap(f=>f.verts)];
  const minX=Math.min(...all.map(p=>p[0])),maxX=Math.max(...all.map(p=>p[0]));
  const minY=Math.min(...all.map(p=>p[1])),maxY=Math.max(...all.map(p=>p[1]));
  // Split every shared edge at the inherited profile's breakpoints. Without
  // this, a long chord can skip across a bay and cross a neighboring terrane
  // even though the continuous mapping itself remains one-to-one.
  const resolveProfile=poly=>poly.flatMap((p,i)=>{
   const q=poly[(i+1)%poly.length],cuts=[0];
   if(Math.abs(q[0]-p[0])>1e-10)for(let k=1;k<12;k++){
    const t=(minX+(maxX-minX)*k/12-p[0])/(q[0]-p[0]);
    if(t>1e-8&&t<1-1e-8)cuts.push(t);
   }
   return cuts.sort((a,b)=>a-b).map(t=>p.map((v,j)=>v+(q[j]-v)*t));
  });
  regional.verts=resolveProfile(regional.verts);
  for(const t of regional.terranes)t.verts=resolveProfile(t.verts);
  for(const f of regional.fragments)f.verts=resolveProfile(f.verts);
  const resolvedSource=resolveProfile(source);
  let riftAngle=0,contours=[];
  const rift={c:host.c};
  function orientRift(angle){
   riftAngle=angle;const ca=Math.cos(angle),sa=Math.sin(angle);
   rift.u=host.u.map((x,k)=>x*ca+host.v[k]*sa);rift.v=host.v.map((x,k)=>x*ca-host.u[k]*sa);
   // Match the exposed assembly margin. Detached shelf fragments do not
   // become part of the facing continental coast.
   contours=blocks.filter(a=>a.group===host.group&&a.kind!=='fragment').map(a=>a.verts.map(p=>project(rift,world(a,...p))));
  }
  // The facing shore inherits a segment of its neighbour's margin. Opening
  // widens along that segment; the far coast and taper are independently
  // composed. This defines a present-day relation, without moving a plate.
  function lowerShore(x) {
   let y=Infinity;
   for(const verts of contours)for(let k=0;k<verts.length;k++){
    const a=verts[k],z=verts[(k+1)%verts.length];
    if((a[0]<=x&&z[0]>x)||(z[0]<=x&&a[0]>x))y=Math.min(y,a[1]+(z[1]-a[1])*(x-a[0])/(z[0]-a[0]));
   }return y;
  }
  const bend=(placeRand()-.5)*.35,opening=.12+placeRand()*.17;
  for(let trial=0;trial<360;trial++){
   if(trial%30===0)orientRift((placeRand()-.5)*(trial<30?.95:TAU));
   const fit=Math.pow(.90,Math.floor(trial/60)),depth=length*scale*fit*.76;
   const span=width*scale*1.75*Math.sqrt(fit),cx=host.length*(offset+(placeRand()-.5)*.40);
   const front=[];
   for(let k=0;k<=12;k++){
    const t=k/12,x=cx+(t-.5)*span,y=lowerShore(x)-.145-opening*t;
    front.push([x,y]);
   }
   if(front.some(p=>!Number.isFinite(p[1])))continue;
   const top=front[6][1];
   // Preserve the companion's regional assembly. The previous replacement
   // was a smooth, tapered polygon and discarded every terrane and contact,
   // leaving a large featureless landmass beside the more complex host.
   const inherit=([x,y])=>{
    const s=clamp((x-minX)/(maxX-minX),0,1),t=clamp((maxY-y)/(maxY-minY),0,1);
    const k=Math.min(11,Math.floor(s*12)),f=s*12-k;
    return [cx+(s-.5)*span,front[k][1]*(1-f)+front[k+1][1]*f-depth*t];
   };
   const outline=resolvedSource.map(inherit);
   const c=world(rift,cx+bend*.25,top-depth*.40),[u,v]=frame(c,heading(c,host.c));
   Object.assign(b,{c,u,v});
   b.verts=simpleOutline(outline.map(p=>project(b,world(rift,...p))));
   const convert=p=>project(b,world(rift,...inherit(p)));
   const parts=[b,...regional.fragments.map(f=>({...b,verts:f.verts.map(convert)}))];
   if(parts.some(part=>part.verts.some(p=>Math.abs(world(b,...p)[2])>Math.sin(1.10))))continue;
   if(blocks.some(other=>parts.some(part=>clearance(part,other)<.12)))continue;
   // Reprojection onto a new spherical frame bends even an affine profile
   // segment. Resolve that curve before joining its endpoints: on a narrow
   // terrane the chord otherwise crosses the opposite edge (seed 103).
   const resolveCurve=poly=>{
    const edge=(a,z,pa,pz,depth)=>{
     const mid=a.map((v,k)=>(v+z[k])*.5),pm=convert(mid);
     const error=Math.hypot(pm[0]-(pa[0]+pz[0])*.5,pm[1]-(pa[1]+pz[1])*.5);
     if(depth<10&&(error>1e-5||Math.hypot(pa[0]-pz[0],pa[1]-pz[1])>.05))
      return [...edge(a,mid,pa,pm,depth+1),...edge(mid,z,pm,pz,depth+1)];
     return [a];
    };
    return poly.flatMap((p,k)=>{const q=poly[(k+1)%poly.length];return edge(p,q,convert(p),convert(q),0);});
   };
   b.verts=simpleOutline(resolveCurve(resolvedSource).map(convert));
   regional.verts=resolveCurve(regional.verts);
   for(const t of regional.terranes)t.verts=resolveCurve(t.verts);
   for(const f of regional.fragments)f.verts=resolveCurve(f.verts);
   Fabric.transform(regional,convert);b.spine=regional.spine;
   b.length=depth;b.width=span*.65;b.size=depth*.5;
   blocks.push(b);plateSeeds.push(c);
   for(const fragment of regional.fragments){
    const child={...b,verts:fragment.verts,kind:'fragment'};delete child.fabric;
    blocks.push(child);events.push({type:'rift-remnant',host:blocks.indexOf(b),child:blocks.indexOf(child)});
   }
   events.push({type:'separated-margin',host:id,child:blocks.indexOf(b),opening,riftAngle});
   // One end of a rift may remain continental. Only the smaller anchor can
   // retain this short connection, so it cannot chain all assemblies into
   // a supercontinent. The other end stays an open marine passage.
   if(host.group===1&&placeRand()<.65){
    const nearest=b.verts.map(q=>({q:world(b,...q),d:-nearestEdge(host,...project(host,world(b,...q))).sd})).sort((a,b)=>a.d-b.d)[0];
    const local=project(host,nearest.q),edge=nearestEdge(host,...local).edge;
    const p=host.verts[edge],q=host.verts[(edge+1)%host.verts.length],dx=q[0]-p[0],dy=q[1]-p[1];
    const t=clamp(((local[0]-p[0])*dx+(local[1]-p[1])*dy)/(dx*dx+dy*dy),0,1);
    const a=world(host,p[0]+t*dx,p[1]+t*dy),z=nearest.q;
    const center=unit(a.map((v,k)=>v+z[k])),length=Math.acos(clamp(dot(a,z),-1,1))+.13;
    const neck=ribbon(center,length,.14,heading(center,a),group,'isthmus');
    if(blocks.some(other=>other!==neck&&other.group!==group&&other.group!==host.group&&clearance(neck,other)<.10))blocks.pop();
    else events.push({type:'incomplete-rift',host:id,child:blocks.indexOf(b),bridge:blocks.indexOf(neck)});
   }
   return b;
  }
  return null;
 }
 function belt(b,side,amplitude,width,old=false) {
  const pts=b.spine.slice(1,-1).map(([x,y],k)=>[x,y+side*b.width*(.33+.10*Math.sin(k+ b.phase))]);
  belts.push({block:blocks.indexOf(b),points:pts,width,amplitude,old,age:old?180:25+rand()*50});
 }
 // Coast samples are intersections with the composed outline, not a radius
 // implied by its bounding box. Contacts and uplift use this same geometry.
 function shore(b,angle) {
  const dx=Math.cos(angle),dy=Math.sin(angle);let distance=0;
  for(let k=0;k<b.verts.length;k++){
   const p=b.verts[k],q=b.verts[(k+1)%b.verts.length],ex=q[0]-p[0],ey=q[1]-p[1];
   const det=dx*ey-dy*ex;if(Math.abs(det)<1e-8)continue;
   const r=(p[0]*ey-p[1]*ex)/det,t=(p[0]*dy-p[1]*dx)/det;
   if(r>0&&t>=0&&t<=1)distance=Math.max(distance,r);
  }
  return [dx*distance,dy*distance];
 }
 function heading(c,toward) {const [east,north]=frame(c,0);return Math.atan2(dot(toward,north),dot(toward,east));}
 function shoreNormal(b,p) {
  // Use the coast's regional tangent. A ray from the continental centre can
  // be almost parallel to a coast; treating it as the normal drilled the
  // same narrow slot into otherwise unrelated continents.
  const k=nearestEdge(b,...p).edge,count=b.verts.length;
  const a=b.verts[(k+count-2)%count],z=b.verts[(k+3)%count];
  let n=unit([a[1]-z[1],z[0]-a[0],0]).slice(0,2);
  if(nearestEdge(b,p[0]+n[0]*.04,p[1]+n[1]*.04).sd>0)n=n.map(v=>-v);
  return n;
 }
 function margin(b,side,height,width,old=false) {
  const start=(side>0?0:Math.PI)+(.08+regionRand()*.28)*Math.PI;
  const lengths=b.verts.map((a,k)=>{const z=b.verts[(k+1)%b.verts.length];return Math.hypot(z[0]-a[0],z[1]-a[1]);});
  const total=lengths.reduce((a,b)=>a+b,0),extent=total*(.14+regionRand()*.17);
  const first=nearestEdge(b,...shore(b,start)).edge,count=Math.max(9,Math.ceil(extent/.055));
  const points=Array.from({length:count},(_,k)=>{
   let distance=k/(count-1)*extent,edge=first;
   while(distance>lengths[edge]){distance-=lengths[edge];edge=(edge+1)%b.verts.length;}
   const a=b.verts[edge],z=b.verts[(edge+1)%b.verts.length],t=distance/lengths[edge];
   const p=[a[0]*(1-t)+z[0]*t,a[1]*(1-t)+z[1]*t],normal=shoreNormal(b,p);
   return [p[0]-normal[0]*.035,p[1]-normal[1]*.035];
  });
  const item={block:blocks.indexOf(b),points,width,amplitude:height,old,age:old?150+rand()*200:20+rand()*60};
  belts.push(item);return item;
 }
 // Sample a hierarchy of bodies and their relationships before local detail.
 // Longitude and hemisphere reflect the whole arrangement after composition.
 const count=clamp(4+Math.floor(rand()*2)+Math.round(((options.cratons||6)-6)/4),3,6);
 const cores=[],separation=2.05+rand()*1.10,lean=(rand()-.5)*.55;
 const independentThird=rand()<.30,secondaryForm=rand()<.55?'fan':rand()<.5?'broad':'compact';
 // Distribute a shared footprint budget. Extra land grows several substantial
 // continents instead of feeding two giant cores which absorb every neighbor.
 const shares=Array.from({length:count},(_,i)=>i===0?1.8+rand()*.4:i===1?1.15+rand()*.45:i<4?.85+rand()*.5:.35+rand()*.35);
 const shareTotal=shares.reduce((a,b)=>a+b,0),footprint=4.4+rand()*.5;
 for(let i=0;i<count;i++){
  const thirdAnchor=i===2&&independentThird;
  const role=i===0?'broad':i===1?secondaryForm:thirdAnchor?'compact':i<4?'pendant':'satellite';
  const parent=i<2||thirdAnchor?-1:i===2?0:i===3?(rand()<.45?0:1):(i-2)%2;
  const host=parent<0?null:cores[parent];
  const longitude=i<2?(i-.5)*separation:thirdAnchor?lean+(rand()-.5)*.75:Math.atan2(host.c[1],host.c[0])+(parent===0?1:-1)*(i>3?-.70-rand()*.45:.25+rand()*.55)+lean;
  const latitude=i===0?.44+rand()*.20:i===1?.02+rand()*.35:thirdAnchor?-.30-rand()*.18:-.23-rand()*.13-(i>3?.12:0),area=footprint*shares[i]/shareTotal;
  const aspect=i===0?2.8+rand()*.6:i===1?(secondaryForm==='broad'?2.2+rand()*.6:1.7+rand()*.7):i<4?1.8+rand()*.5:1.5+rand()*.5;
  const length=Math.sqrt(area*aspect),width=Math.sqrt(area/aspect);
  const angle=i===0?(rand()-.5)*.35:i===1?(secondaryForm==='fan'?(rand()<.5?-1:1)*(.45+rand()*.7):(rand()-.5)*1.3):thirdAnchor?(rand()-.5)*2:i<4?Math.PI*.5+(rand()-.5)*.55:(rand()-.5)*1.5;
  const related=i===2&&!thirdAnchor||i===3&&rand()<.5?separatedCore(host,length,width,(parent===0?1:-1)*(.12+rand()*.12)):null;
  const built=related||core(longitude,latitude,length,width,angle,role,host?blocks.indexOf(host):-1);
  cores.push(built);
 }
 const inheritanceOrder=cores.map((b,i)=>({i,key:regionRand()})).sort((a,b)=>a.key-b.key).map(x=>x.i);
 for(let i=0;i<cores.length;i++){
  const host=cores[i],id=blocks.indexOf(host);
  // Regional inheritance distinguishes a subdued platform from a raised,
  // dissected shield. Age is metadata for this composition, not a simulation.
  const inheritance=(inheritanceOrder.indexOf(i)+regionRand()*.6)/cores.length;
  host.inheritance=inheritance<.34?'low-platform':inheritance<.70?'mixed-shield':'raised-shield';
  const inheritedHeight=inheritance<.34?.50:inheritance<.70?1:1.65;
  const active=rand()<.70;
  if(active)margin(host,rand()<.5?1:-1,1700+rand()*2300,.025+rand()*.035);
  if(rand()<.65)margin(host,rand()<.5?1:-1,450+rand()*850,.045+rand()*.045,true);
  // Basement is a mosaic of tilted crustal regions. Their contacts are
  // inherited structures; their interiors do not each get a radial mound.
  const terranes=host.fabric?.terranes||[{verts:host.verts,generation:0,parent:-1}];
  const tilt=regionRand()*TAU,level=100+550*inheritedHeight;
  for(const [j,terrane] of terranes.entries()){
   const center=terrane.verts.reduce((c,p)=>[c[0]+p[0]/terrane.verts.length,c[1]+p[1]/terrane.verts.length],[0,0]);
   const regionalTilt=(Math.cos(tilt)*center[0]/host.length+Math.sin(tilt)*center[1]/host.width)*450;
   const direction=terrane.verts[1].map((v,k)=>v-terrane.verts[0][k]),strike=Math.atan2(direction[1],direction[0]);
   provinces.push({block:id,kind:'basement',verts:terrane.verts,center,level:Math.max(80,level*(.30+regionRand()*.50)+regionalTilt),tilt:[Math.cos(tilt)*160/host.length,Math.sin(tilt)*160/host.width],strike,grain:70+regionRand()*110*inheritedHeight,phase:host.phase+j});
  }
  for(const contact of host.fabric?.contacts||[]){
   if(contact.rift)continue;
   if(contact.parent!==0&&regionRand()>.25)continue;
   const [a,b]=contact.points,dx=b[0]-a[0],dy=b[1]-a[1];
   const points=[a,[a[0]+dx*.34-dy*.10,a[1]+dy*.34+dx*.10],[a[0]+dx*.70+dy*.07,a[1]+dy*.70-dx*.07],b];
   belts.push({block:id,points,width:.025+regionRand()*.025,amplitude:(400+regionRand()*700)*inheritedHeight,old:true,age:200+regionRand()*700,kind:'inherited-contact'});
  }
  const side=regionRand()<.5?-1:1;
  // A broad lowland corridor runs out through a passive margin. It suppresses
  // old uplift, not the young ranges; detailed drainage remains downstream.
  let outlet,opening=-Infinity;
  for(let candidate=0;candidate<12;candidate++){
   const p=shore(host,regionRand()*TAU);
   let score=host.width;
   for(const range of belts)if(range.block===id&&!range.old)score=Math.min(score,pathDistance(range.points,...p).distance);
   // Give the broad lowland a preferred flank, while the range clearance
   // keeps its outlet away from young uplift.
   score-=side*p[1]*.30;
   if(score>opening){opening=score;outlet=p;}
  }
  const interior=host.spine[Math.floor(host.spine.length*.5)];
  const head=[interior[0]-outlet[0]*.25,interior[1]-side*host.width*.25];
  basins.push({block:id,points:[head,[outlet[0]*.35+head[0]*.65,outlet[1]*.25+head[1]*.75],outlet.map(v=>v*1.05)],width:host.width*(.18+rand()*.12),strength:.80+rand()*.15});
 }
 // A marine basin is a connected part of an interaction, not a polygonal
 // hole. Its centreline runs from the interior through a gateway into ocean.
 // The same frame owns the adjoining arc, trench and small overriding plate.
 const landDistance=p=>Math.max(...blocks.map(b=>nearestEdge(b,...project(b,p)).sd));
 function channel(host,points,widths) {
  const left=[],right=[];
  for(let k=0;k<points.length;k++){
   const a=points[Math.max(0,k-1)],b=points[Math.min(points.length-1,k+1)],d=unit([b[0]-a[0],b[1]-a[1],0]);
   left.push([points[k][0]-d[1]*widths[k],points[k][1]+d[0]*widths[k]]);
   right.push([points[k][0]+d[1]*widths[k],points[k][1]-d[0]*widths[k]]);
  }
  const sea={c:host.c,u:host.u,v:host.v,verts:simpleOutline([...left,...right.reverse()]),kind:'connected-seaway'};
  seas.push(sea);return seas.length-1;
 }
 // Extension reuses a long basement contact that reaches an exposed coast.
 // A tapering failed arm makes an embayment; a complete opening separates
 // a crustal fragment. Both sides retain their inherited basement and plate.
 // This is regional extension, not fjords or noise-cut coastline texture.
 for(const host of cores){
  const id=blocks.indexOf(host),used=[];
  const candidates=(host.fabric?.contacts||[]).filter(c=>!c.rift).map(contact=>({contact,key:riftRand()})).sort((a,b)=>a.key-b.key);
  const budget=1+Math.floor(riftRand()*3);
  for(const {contact} of candidates){
   if(used.length>=budget)break;
   let [a,b]=contact.points.map(p=>p.slice());
   const length=Math.hypot(b[0]-a[0],b[1]-a[1]);
   if(length<.24)continue;
   if(riftRand()<.5)[a,b]=[b,a];
   const direction=unit([b[0]-a[0],b[1]-a[1],0]).slice(0,2);
   const entry=a.map((v,k)=>v-direction[k]*.075);
   if(landDistance(world(host,...entry))>-.015)continue;
   if(used.some(p=>Math.hypot(p[0]-a[0],p[1]-a[1])<.30))continue;
   const complete=riftRand()<.30&&landDistance(world(host,...b.map((v,k)=>v+direction[k]*.08)))<-.015;
   const reach=complete?length+.10:length*(.50+riftRand()*.30);
   const width=Math.min(.085,length*(.12+riftRand()*.08));
   const bend=(riftRand()-.5)*.10;
   const points=Array.from({length:7},(_,k)=>{
    const t=k/6,d=-.10+(reach+.10)*t,offset=bend*Math.sin(Math.PI*t);
    return [a[0]+direction[0]*d-direction[1]*offset,a[1]+direction[1]*d+direction[0]*offset];
   });
   const widths=points.map((p,k)=>{
    const t=k/6;
    return width*(.65+.50*Math.sin(Math.PI*t))*(complete?1:Math.min(1,(1-t)*4))+.008;
   });
   const sea=channel(host,points,widths);
   seas[sea].kind='rift-embayment';
   events.push({type:'continental-extension',host:id,sea,contact:contact.child,complete,age:60+riftRand()*140});
   used.push(a);
  }
 }
 const marineHosts=cores.slice(0,3).map(b=>({b,key:rand()})).sort((a,b)=>a.key-b.key);
 for(let index=0;index<marineHosts.length;index++){
  const host=marineHosts[index].b,id=blocks.indexOf(host),kind=index===0?'remnant-seaway':'arc-basin';
  let chosen=null;
  // Select an exposed coast of the whole assembly, clear of other land and
  // the poles. Shared margins between welded blocks are not ocean contacts.
  for(let trial=0;trial<70;trial++){
   const angle=(rand()<.8?-1:1)*(.55+rand()*2.05),p=shore(host,angle),n=shoreNormal(host,p),t=[-n[1],n[0]];
   const at=(x,y)=>[p[0]+t[0]*x+n[0]*y,p[1]+t[1]*x+n[1]*y];
   if(landDistance(world(host,...at(0,.24)))>-.09)continue;
   if(Math.abs(world(host,...at(0,.42))[2])>.85)continue;
   const sign=landDistance(world(host,...at(.32,-.15)))>landDistance(world(host,...at(-.32,-.15)))?1:-1;
   if(kind==='remnant-seaway'&&landDistance(world(host,...at(sign*.30,-.14)))<.07)continue;
   const front=world(host,...at(kind==='remnant-seaway'?sign*.20:0,kind==='remnant-seaway'?.04:.32));
   if(marine.some(m=>m.arc.some(q=>dot(front,world(blocks[m.host],...q))>Math.cos(.60))))continue;
   chosen={p,n,t,at,sign};break;
  }
  if(!chosen)continue;
  const {p,n,t,at,sign}=chosen,span=.45+rand()*.30;
  let points,widths;
  if(kind==='remnant-seaway'){
   const depth=.13+rand()*.10;
   points=[at(sign*span,-depth*.65),at(sign*span*.7,-depth),at(sign*span*.32,-depth*.70),at(0,-.025),at(-sign*.08,.22),at(-sign*.12,.42)];
   widths=[.045,.12+rand()*.055,.10,.085,.12,.18];
  }else{
   points=[at(-span*.50,.075),at(-span*.24,.13),at(span*.08,.16),at(span*.42,.14),at(span*.67,.20),at(span*.85,.38)];
   widths=[.025,.095,.12,.095,.07,.10];
  }
  const sea=channel(host,points,widths),center=points[2],group=plateSeeds.length;
  plateSeeds.push(world(host,...center));
  const arcPoints=Array.from({length:7},(_,k)=>{
   const s=k/6;return kind==='arc-basin'?at((s-.5)*span*1.45,.29+.105*Math.sin(Math.PI*s)):
    at(sign*(span*.28+(s-.5)*span*.6),-.035+.10*Math.sin(Math.PI*s));
  });
  const trench=arcPoints.map(q=>[q[0]+n[0]*.06,q[1]+n[1]*.06]);
  marine.push({kind,host:id,group,sea,center,points,widths,arc:arcPoints,trench,normal:n,span,age:kind==='remnant-seaway'?80+rand()*70:20+rand()*60});
  // A broken arc has a few resolvable islands, not a continuous wall. The
  // narrow continental promontory at one end leaves navigable straits.
  const islands=kind==='arc-basin'?3:2;
  for(let j=0;j<islands;j++){
   const q=arcPoints[1+j*2],c=world(host,...q),island=ribbon(c,.12+rand()*.08,.035+rand()*.025,heading(c,host.c)+Math.PI*.5,group,'arc');
   belt(island,0,1100+rand()*1200,.022+rand()*.013);
  }
  // Inherited uplift on one basin shoulder; the other shoulder can remain
  // a low foreland. This avoids the old all-around mountain rim.
  const shoulder=points.slice(0,3).map(q=>[q[0]-n[0]*.15,q[1]-n[1]*.15]);
  belts.push({block:id,points:shoulder,width:.035,amplitude:850+rand()*900,old:true,age:120+rand()*100});
  events.push({type:kind,host:id,sea,group});
 }
 // One or two collisions, assigned to different large hosts. The contact
 // follows a shore, and its plateau is rotated toward the host interior.
 const collisionCount=rand()<.30?2:1;
 const area=b=>Math.abs(b.verts.reduce((sum,p,k)=>{const q=b.verts[(k+1)%b.verts.length];return sum+p[0]*q[1]-q[0]*p[1];},0))*.5;
 const hosts=cores.map(b=>({b,key:regionRand(),area:area(b)})).sort((a,b)=>b.area-a.area).slice(0,2).sort((a,b)=>a.key-b.key);
 for(let event=0;event<collisionCount;event++){
  const host=hosts[event].b,id=blocks.indexOf(host);
  const collisionStrength=event===0?1:.52+regionRand()*.15;
  let angle=-.6-rand()*1.8,p=shore(host,angle),clearance=-Infinity;
  for(let trial=0;trial<80;trial++){
   const candidate=-.3-rand()*2.5,q=shore(host,candidate),site=world(host,...q),normal=shoreNormal(host,q);
   const offshore=world(host,q[0]+normal[0]*.20,q[1]+normal[1]*.20);
   let score=Math.min(.10-Math.max(0,Math.abs(site[2])-.80),-landDistance(offshore));
   score=Math.min(score,.10-landDistance(site));
   for(const sea of seas)score=Math.min(score,-nearestEdge(sea,...project(sea,site)).sd);
   if(score>clearance){angle=candidate;p=q;clearance=score;}
   if(clearance>=.08)break;
  }
  const normal=shoreNormal(host,p),tangent=[-normal[1],normal[0]];
  const length=.42+rand()*.25,center=world(host,p[0]+normal[0]*length*.29,p[1]+normal[1]*length*.29);
  const group=plateSeeds.length;plateSeeds.push(center);
  const inland=world(host,p[0]-normal[0]*.20,p[1]-normal[1]*.20);
  const child=ribbon(center,length,.19+rand()*.14,heading(center,inland),group,'collider');
  const extent=Math.min(.85+rand()*.50,host.length*.80),bend=.025+rand()*.035;
  const points=Array.from({length:9},(_,k)=>{const t=k/8,s=(t-.5)*extent,d=-bend*Math.sin(t*Math.PI);return [p[0]+tangent[0]*s+normal[0]*d,p[1]+tangent[1]*s+normal[1]*d];});
  belts.push({block:id,points,width:.026+rand()*.020,amplitude:(2300+rand()*1300)*collisionStrength,old:false,age:(event===0?10:65)+rand()*40,collision:true});
  // The thickened province runs behind the contact. A compact Gaussian at
  // its midpoint made a circular mountain knot on almost every continent.
  const back=points.map((q,k)=>{
   const depth=(.10+.10*Math.sin(Math.PI*k/8))*(.8+regionRand()*.4);
   return [q[0]-normal[0]*depth,q[1]-normal[1]*depth];
  });
  provinces.push({block:id,verts:simpleOutline([...points,...back.reverse()]),height:(700+rand()*650)*collisionStrength,kind:'collision-platform'});
  const end=points[rand()<.5?0:8],target=shore(host,angle+(rand()<.5?-1:1)*1.2);
  belts.push({block:id,points:[end,[end[0]*.65+target[0]*.2,end[1]*.6+target[1]*.2],target.map(v=>v*.78)],width:.035+rand()*.025,amplitude:700+rand()*1100,old:true,age:100+rand()*120});
  events.push({type:'collision',host:id,child:blocks.indexOf(child),contact:p});
 }
 // Along-strike provinces, with a broad hinterland on one side and a short
 // front on the other. These parameters describe the whole range system;
 // they are not independent cell noise or another set of radial mountains.
 for(const range of belts){
  const host=blocks[range.block],phase=regionRand()*TAU;
  range.widths=range.points.map((p,k)=>range.width*(.80+.40*Math.sin(k*.70+phase)+.25*regionRand()));
  range.strengths=range.points.map((p,k)=>.70+.28*Math.sin(k*.85+phase+1)+.20*regionRand());
  const hit=pathDistance(range.points,0,0);
  range.inlandSide=hit.side<0?-1:1;
  range.hinterland=range.old?0:(range.collision?.12:.09)+regionRand()*.10;
  range.foreland=range.old?0:.035+regionRand()*.035;
  // Several overlapping uplift segments form one belt. Their phase and
  // strike stay coherent across the range, with saddles between segments.
  // Smaller rear strands are thrust systems, not independent mountain dots.
  range.segments=3+Math.floor(regionRand()*4);
  range.phase=phase;
  range.strands=range.old?1:2+Math.floor(regionRand()*2);
  // One inherited branch ties a young mountain system into the continental
  // interior. It fades before crossing the opposite passive margin.
  if(range.old||host.kind!=='core'||regionRand()>.65)continue;
  const end=host.spine[Math.floor(host.spine.length*(.25+regionRand()*.50))];
  const p=range.points[2+Math.floor(regionRand()*4)];
  provinces.push({block:range.block,kind:'orogenic-branch',points:[p,[(p[0]+end[0])*.5+host.width*.08,(p[1]+end[1])*.5],end],width:.07+regionRand()*.07,height:range.amplitude*(.20+regionRand()*.20)});
 }
 // Apply global reflection/longitude only after the local construction. Frames
 // and attached history transform together, preserving all contacts and bays.
 const transform=p=>[p[0]*Math.cos(origin)-p[1]*mirror*Math.sin(origin),p[0]*Math.sin(origin)+p[1]*mirror*Math.cos(origin),p[2]*flip];
 for(const block of [...blocks,...seas])for(const key of ['c','u','v'])block[key]=transform(block[key]);
 return {version:7,kind:'assembled-history',arrangement:independentThird?'three-anchors':'paired-anchors',blocks,belts,provinces,basins,seas,marine,events,plateSeeds:plateSeeds.map(transform)};
}
module.exports={compose,project,world,nearestEdge,pathDistance};
