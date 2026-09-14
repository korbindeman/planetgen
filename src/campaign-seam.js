/* A single spherical blend of overlapping face fields, independent of output
 * tile or bake order. This also handles the three-way junctions at corners. */
'use strict';
const Cube=require('./cubesphere');
function smooth(t) { t=Math.max(0,Math.min(1,t)); return t*t*t*(t*(t*6-15)+10); }
function faceWeights(direction, band) {
 const ax=Math.abs(direction[0]),ay=Math.abs(direction[1]),az=Math.abs(direction[2]);
 if(ax-Math.max(ay,az)>=band) return [{face:direction[0]>=0?0:2,weight:1}];
 if(ay-Math.max(ax,az)>=band) return [{face:direction[1]>=0?1:3,weight:1}];
 if(az-Math.max(ax,ay)>=band) return [{face:direction[2]>=0?4:5,weight:1}];
 const c=Cube.FACES.map(f=>f.n[0]*direction[0]+f.n[1]*direction[1]+f.n[2]*direction[2]);
 const out=[]; let total=0;
 for(let face=0;face<6;face++) {
  let weight=1;
  for(let other=0;other<6&&weight>0;other++) if(face!==other)
   weight*=smooth((c[face]-c[other]+band)/(2*band));
  if(weight>0) {out.push({face,weight});total+=weight;}
 }
 for(const item of out) item.weight/=total;
 return out;
}
function sourceTile(face,direction,level) {
 const p=Cube.faceCoords(face,direction), n=1<<level;
 if(!p) throw new Error('Blend asks for a source behind its face');
 return {face,level,i:Math.max(0,Math.min(n-1,Math.floor((p.a+1)*n/2))),
  j:Math.max(0,Math.min(n-1,Math.floor((p.b+1)*n/2)))};
}
function sourcesForTile(tile,side,band) {
 const lo=.5/side,hi=1-lo,faces=new Set(),corners=[];
 for(const y of [lo,.5,hi]) for(const x of [lo,.5,hi]) {
  const d=Cube.tileDirection(tile,x,y);
  for(const w of faceWeights(d,band))faces.add(w.face);
  if(x!==.5&&y!==.5)corners.push(d);
 }
 const result=new Set();
 for(const face of faces) {
  // On a front-facing tile the projected ratios are linear-fractional
  // functions of tan(a),tan(b). Their extrema lie at rectangle corners.
  const bounds=corners.map(d=>sourceTile(face,d,tile.level));
  const i0=Math.min(...bounds.map(t=>t.i)),i1=Math.max(...bounds.map(t=>t.i));
  const j0=Math.min(...bounds.map(t=>t.j)),j1=Math.max(...bounds.map(t=>t.j));
  for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++)result.add(Cube.tileName({face,level:tile.level,i,j}));
 }
 return result;
}
module.exports={faceWeights,sourceTile,sourcesForTile};
