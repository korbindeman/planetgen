/** Bound CPU drawing work; model and bake still receive the full saved Shape. */
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),G=require('../src/climate-grid'),P=require('../src/planet');
export function climateView(planet,limit=64000) {
    if(planet.mesh.numRegions<=limit)return {planet,remap:field=>field};
    const grid=G.makeGrid(limit,planet.body.radiusKm),source={mesh:planet.mesh,xyz:planet.map.r_xyz,n:planet.mesh.numRegions},ids=[],weights=[],starts=new Int32Array(grid.n+1),scratch={};
    for(let r=0;r<grid.n;r++) {
        starts[r]=ids.length;
        const w=G.weightsAt(source,Array.from(grid.xyz.subarray(3*r,3*r+3)),scratch);
        ids.push(...w.cells);weights.push(...w.weights);
    }
    starts[grid.n]=ids.length;
    const remap=field=>Float32Array.from({length:grid.n},(_,r)=>{let v=0;for(let j=starts[r];j<starts[r+1];j++)v+=field[ids[j]]*weights[j];return v;});
    const map={...planet.map,r_xyz:Float32Array.from(grid.xyz)};
    for(const key of ['r_elevation','r_moisture','r_temperature','r_meters'])map[key]=remap(planet.map[key]);
    map.t_xyz=P.generateTriangleCenters(grid.mesh,map);
    for(const key of ['t_elevation','t_moisture','t_temperature'])map[key]=new Float32Array(grid.mesh.numTriangles);
    P.assignTriangleValues(grid.mesh,map);
    return {planet:{...planet,mesh:grid.mesh,map,geometry:P.buildQuadGeometry(grid.mesh,map)},remap};
}
