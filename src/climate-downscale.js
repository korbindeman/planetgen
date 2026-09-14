/* Transfer a monthly climate to the saved Shape. Temperature uses a lapse
 * correction. Precipitation redistributes each source cell's water between
 * fine cells by wind exposure, preserving that source volume every month. */
'use strict';
const Grid=require('./climate-grid');
const Climate=require('./seasonal-climate');
const Tectonics=require('./tectonics');
function downscale(climate,planet) {
    const {grid}=climate,{mesh,map}=planet,n=mesh.numRegions,xyz=map.r_xyz;
    const area=Grid.areas(mesh,xyz,grid.radiusKm*1000),starts=new Int32Array(n+1),ids=[],weights=[];
    const surfaceHeight=new Float64Array(n),reference=new Float64Array(n),gradient=new Float64Array(n*3);
    const coarseHeight=Float64Array.from(grid.height,(h,r)=>h*grid.land[r]),scratch={};
    for(let r=0;r<n;r++) {
        starts[r]=ids.length;
        const w=Grid.weightsAt(grid,[xyz[3*r],xyz[3*r+1],xyz[3*r+2]],scratch);
        for(let k=0;k<w.cells.length;k++){ids.push(w.cells[k]);weights.push(w.weights[k]);reference[r]+=coarseHeight[w.cells[k]]*w.weights[k];}
        surfaceHeight[r]=Math.max(0,map.r_meters?map.r_meters[r]:Tectonics.elevationToMeters(map.r_elevation[r]));
    }
    starts[n]=ids.length;
    const cells=Int32Array.from(ids),blend=Float64Array.from(weights),neighbours=[];
    for(let r=0;r<n;r++) {
        mesh.r_circulate_r(neighbours,r);
        for(const q of neighbours) {
            const dx=xyz[3*q]-xyz[3*r],dy=xyz[3*q+1]-xyz[3*r+1],dz=xyz[3*q+2]-xyz[3*r+2];
            const distance2=(dx*dx+dy*dy+dz*dz)*grid.radiusKm*1000;
            const dh=(surfaceHeight[q]-reference[q])-(surfaceHeight[r]-reference[r]);
            const factor=2/neighbours.length*dh/Math.max(1,distance2);
            gradient[3*r]+=dx*factor;gradient[3*r+1]+=dy*factor;gradient[3*r+2]+=dz*factor;
        }
    }
    // Exposure represents a regional slope, not each noisy sketch facet.
    for(let pass=0;pass<2;pass++) {
        const next=gradient.slice();
        for(let r=0;r<n;r++) {
            mesh.r_circulate_r(neighbours,r);
            for(let axis=0;axis<3;axis++) {
                let sum=gradient[3*r+axis];for(const q of neighbours)sum+=gradient[3*q+axis];
                next[3*r+axis]=sum/(neighbours.length+1);
            }
        }
        gradient.set(next);
    }
    const temperature=new Float32Array(n*12),precipitation=new Float32Array(n*12),snowCover=new Float32Array(n*12),seaIce=new Float32Array(n*12);
    const exposure=new Float64Array(n),denominator=new Float64Array(grid.n),lapse=climate.options.climateLapseRate/1000;
    let maxConservationError=0;
    for(let month=0;month<12;month++) {
        denominator.fill(0);
        for(let r=0;r<n;r++) {
            let t=0,wx=0,wy=0,wz=0,snow=0,ice=0;
            for(let k=starts[r];k<starts[r+1];k++) {
                const c=cells[k],w=blend[k],source=month*grid.n+c;
                t+=climate.monthly.temperature[source]*w;snow+=climate.monthly.snowCover[source]*w;ice+=climate.monthly.seaIce[source]*w;
                wx+=climate.monthly.winds[3*source]*w;wy+=climate.monthly.winds[3*source+1]*w;wz+=climate.monthly.winds[3*source+2]*w;
            }
            const dest=month*n+r;
            temperature[dest]=t-lapse*(surfaceHeight[r]-reference[r]);snowCover[dest]=snow;seaIce[dest]=ice;
            // Residual relief only: the coarse solver already rained over its
            // mountains. Limit the unresolved correction to a modest factor.
            const lift=wx*gradient[3*r]+wy*gradient[3*r+1]+wz*gradient[3*r+2];
            exposure[r]=Math.exp(Math.max(-0.4,Math.min(0.4,lift/0.025)));
            for(let k=starts[r];k<starts[r+1];k++)denominator[cells[k]]+=area[r]*blend[k]*exposure[r];
        }
        let before=0,after=0,unsupported=0;
        for(let c=0;c<grid.n;c++) {
            const water=climate.monthly.precipitation[month*grid.n+c]*grid.area[c];
            before+=water;if(!denominator[c])unsupported+=water;
        }
        if(unsupported>before*1e-5)throw new Error('Shape is too coarse to receive the climate grid; use fewer climate cells');
        for(let r=0;r<n;r++) {
            let p=0;
            for(let k=starts[r];k<starts[r+1];k++) {
                const c=cells[k];p+=climate.monthly.precipitation[month*grid.n+c]*grid.area[c]/denominator[c]*blend[k]*exposure[r];
            }
            precipitation[month*n+r]=p;after+=precipitation[month*n+r]*area[r];
        }
        maxConservationError=Math.max(maxConservationError,Math.abs(before-after)/Math.max(1,before));
    }
    return {n,monthly:{temperature,precipitation,snowCover,seaIce},annual:Climate.summarize(temperature,precipitation,n),diagnostics:{maxConservationError}};
}
module.exports={downscale};
