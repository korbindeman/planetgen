/* Spherical finite volumes and field transfer for Finish climate. No DOM/GL.
 * Barycentric dual areas sum to 4*pi*R^2. Every transport edge is visited once;
 * its outgoing mass is exactly its neighbour's incoming mass. */
'use strict';
const Sphere = require('./sphere-mesh');
const Tectonics = require('./tectonics');

const dot = (p, a, b) => p[3*a]*p[3*b]+p[3*a+1]*p[3*b+1]+p[3*a+2]*p[3*b+2];
function areas(mesh, xyz, radiusM) {
    const area = new Float64Array(mesh.numRegions);
    for (let t=0;t<mesh.numTriangles;t++) {
        const a=mesh.s_begin_r(3*t), b=mesh.s_begin_r(3*t+1), c=mesh.s_begin_r(3*t+2);
        const det=xyz[3*a]*(xyz[3*b+1]*xyz[3*c+2]-xyz[3*b+2]*xyz[3*c+1])
            +xyz[3*a+1]*(xyz[3*b+2]*xyz[3*c]-xyz[3*b]*xyz[3*c+2])
            +xyz[3*a+2]*(xyz[3*b]*xyz[3*c+1]-xyz[3*b+1]*xyz[3*c]);
        const share=2*Math.atan2(Math.abs(det),1+dot(xyz,a,b)+dot(xyz,b,c)+dot(xyz,c,a))*radiusM**2/3;
        area[a]+=share; area[b]+=share; area[c]+=share;
    }
    return area;
}
function makeGrid(cells, radiusKm) {
    const {mesh,r_xyz:points}=Sphere.makeSphere(cells,0,()=>0.5);
    const xyz=Float64Array.from(points), n=mesh.numRegions, radiusM=radiusKm*1000;
    const area=areas(mesh,xyz,radiusM), centre=new Float64Array(mesh.numTriangles*3);
    for(let t=0;t<mesh.numTriangles;t++) {
        for(let j=0;j<3;j++) { const r=mesh.s_begin_r(t*3+j); for(let k=0;k<3;k++)centre[t*3+k]+=xyz[r*3+k]; }
        const len=Math.hypot(centre[t*3],centre[t*3+1],centre[t*3+2]);
        for(let k=0;k<3;k++)centre[t*3+k]/=len;
    }
    const edges=[];
    for(let s=0;s<mesh.numSides;s++) {
        const opposite=mesh.s_opposite_s(s); if(opposite<s)continue;
        const a=mesh.s_begin_r(s),b=mesh.s_begin_r(opposite),ta=mesh.s_inner_t(s),tb=mesh.s_inner_t(opposite);
        const distance=Math.acos(Math.max(-1,Math.min(1,dot(xyz,a,b))))*radiusM;
        const width=Math.acos(Math.max(-1,Math.min(1,dot(centre,ta,tb))))*radiusM;
        const dx=xyz[3*b]-xyz[3*a],dy=xyz[3*b+1]-xyz[3*a+1],dz=xyz[3*b+2]-xyz[3*a+2];
        const norm=Math.hypot(dx,dy,dz);
        edges.push({a,b,distance,width,conductance:width/distance,dx:dx/norm,dy:dy/norm,dz:dz/norm});
    }
    const adjacent=Array.from({length:n},()=>[]);
    edges.forEach((e,i)=>{adjacent[e.a].push(i);adjacent[e.b].push(i);});
    const offsets=new Int32Array(n+1),neighbours=new Int32Array(edges.length*2),edgeIds=new Int32Array(edges.length*2),conductances=new Float64Array(edges.length*2);
    let cursor=0;
    for(let r=0;r<n;r++){offsets[r]=cursor;for(const id of adjacent[r]){const e=edges[id];neighbours[cursor]=e.a===r?e.b:e.a;edgeIds[cursor]=id;conductances[cursor]=e.conductance;cursor++;}}offsets[n]=cursor;
    const lat=Float64Array.from({length:n},(_,r)=>Math.asin(Math.max(-1,Math.min(1,xyz[r*3+2]))));
    return {mesh,xyz,n,area,edges,adjacent,lat,radiusKm,offsets,neighbours,edgeIds,conductances};
}
function weightsAt(grid, position, scratch={}) {
    const neighbours=scratch.neighbours||(scratch.neighbours=[]);
    const cells=scratch.cells||(scratch.cells=[]),weights=scratch.weights||(scratch.weights=[]);
    const hint=Math.max(0,Math.min(grid.n-1,Math.floor((1-position[2])*0.5*(grid.n-1))));
    const at=Tectonics.nearestRegion(grid.mesh,grid.xyz,position,hint,neighbours);
    Tectonics.sampleWeights(grid.mesh,grid.xyz,position,at,neighbours,cells,weights);
    return {cells,weights,at};
}
function sample(grid,field,position,scratch) {
    const {cells,weights}=weightsAt(grid,position,scratch);
    return Tectonics.sampleField(field,cells,weights);
}
function terrainFromPlanet(grid,planet) {
    const {mesh,map}=planet,xyz=map.r_xyz;
    const fineArea=areas(mesh,xyz,grid.radiusKm*1000), mass=new Float64Array(grid.n);
    const land=new Float64Array(grid.n),height=new Float64Array(grid.n),scratch={};
    for(let r=0;r<mesh.numRegions;r++) {
        const z=map.r_meters ? map.r_meters[r] : Tectonics.elevationToMeters(map.r_elevation[r]);
        const {cells,weights}=weightsAt(grid,[xyz[3*r],xyz[3*r+1],xyz[3*r+2]],scratch);
        for(let j=0;j<cells.length;j++) {
            const c=cells[j],w=fineArea[r]*weights[j]; mass[c]+=w;
            if(z>=0) {land[c]+=w;height[c]+=z*w;}
        }
    }
    const source={mesh,xyz,n:mesh.numRegions},sourceHeight=map.r_meters||Float32Array.from(map.r_elevation,Tectonics.elevationToMeters);
    for(let r=0;r<grid.n;r++) {
        // A coarse input can leave a climate cell unsupported. Sample it locally.
        if(!mass[r]) {
            const z=sample(source,sourceHeight,[grid.xyz[3*r],grid.xyz[3*r+1],grid.xyz[3*r+2]],scratch);
            land[r]=z>=0?1:0;height[r]=Math.max(0,z);
        } else {height[r]=land[r]>0?height[r]/land[r]:0;land[r]/=mass[r];}
    }
    return {land,height};
}
/** Backward Euler conservative transport. Coefficients are m^2/s across edges.
 * Solving to a residual (not clipping negative water) keeps the water budget
 * valid even on small planets where a daily step crosses several cells. */
function makeTransport(grid,flux,dt,diffusivity=0) {
    const {n,area,edges,offsets,edgeIds,conductances}=grid,diagonal=new Float64Array(n),incoming=new Float64Array(edgeIds.length);
    for(let r=0;r<n;r++) {
        diagonal[r]=area[r]/dt;
        for(let k=offsets[r];k<offsets[r+1];k++) {
            const e=edgeIds[k],f=flux[e]*(edges[e].a===r?1:-1),mix=diffusivity*conductances[k];
            diagonal[r]+=Math.max(0,f)+mix;incoming[k]=Math.max(0,-f)+mix;
        }
    }
    return {diagonal,incoming};
}
function transport(grid,field,flux,dt,iterations=40,tolerance=1e-8,diffusivity=0,operator=null) {
    const {n,area,offsets,neighbours}=grid,old=field.slice();
    const {diagonal,incoming}=operator||makeTransport(grid,flux,dt,diffusivity);
    let residual=Infinity,sweeps=0;
    for(;sweeps<iterations;sweeps++) {
        let change=0;
        for(let k=0;k<n;k++) {
            const r=sweeps%2?n-1-k:k;let rhs=old[r]*area[r]/dt;
            for(let j=offsets[r];j<offsets[r+1];j++)rhs+=incoming[j]*field[neighbours[j]];
            const next=rhs/diagonal[r];change=Math.max(change,Math.abs(next-field[r]));field[r]=next;
        }
        residual=change;if(change<tolerance)break;
    }
    // Iteration residual can drift global water. Restore its small numerical
    // remainder multiplicatively; report it so an under-solved system fails QA.
    let before=0,after=0;for(let r=0;r<n;r++){before+=old[r]*area[r];after+=field[r]*area[r];}
    const correction=after>0?before/after:1;
    for(let r=0;r<n;r++)field[r]*=correction;
    return {residual,sweeps:sweeps+1,relativeCorrection:Math.abs(correction-1)};
}
module.exports={makeGrid,areas,weightsAt,sample,terrainFromPlanet,makeTransport,transport};
