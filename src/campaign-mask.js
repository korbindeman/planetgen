/* A mask of output windows on the shared face lattice. Conditioning remains
 * whole-face; this only decides which fine elevations the model must produce. */
const Cube = require('./cubesphere');
const Planet = require('./planet');
const Tectonics = require('./tectonics');

const smooth = t => { t = Math.max(0, Math.min(1, t)); return t*t*t*(t*(t*6-15)+10); };

function createFace(planet, face, level, cells, options = {}) {
    const {shelfM = 0, bufferKm = 46, fadeKm = 46, windowCells = 2} = options;
    const tile = {face, level: 0, i: 0, j: 0};
    const rect = Cube.tileBakeRect(tile, (1 << level)*cells, options.contextPad ?? 64);
    const raw = Planet.rasterizeBakeRect(planet.mesh, planet.map, tile, rect, 0);
    const {width:w, height:h} = rect;
    const base = Float32Array.from(raw.elev, Tectonics.elevationToMeters);
    const seeds = new Uint8Array(w*h);
    for(let k=0;k<base.length;k++) if(base[k] >= Math.min(0,shelfM)) seeds[k]=1;
    // Protect small islands that fall between raster centers. Positive mesh
    // vertices define every positive triangle in the saved continuous field.
    const xyz=planet.map.r_xyz, heights=planet.map.r_elevation;
    for(let k=0;k<heights.length;k++) if(Tectonics.elevationToMeters(heights[k]) >= Math.min(0,shelfM)) {
        const d=[xyz[3*k],xyz[3*k+1],xyz[3*k+2]];
        const f=Cube.FACES[face];
        if(d[0]*f.n[0]+d[1]*f.n[1]+d[2]*f.n[2]<=0) continue;
        const p=Cube.bakePixel(tile,rect,d),x=Math.floor(p.x),y=Math.floor(p.y);
        if(x>=0&&y>=0&&x<w&&y<h) seeds[y*w+x]=1;
    }
    // Use the smallest ground cell in the useful face+fold region so the
    // physical buffer never shrinks at corners. Add a cell-diagonal guard
    // for the coarse coastline and bilinear mask interpolation.
    const kmPerCell=rect.step*planet.body.radiusKm/1.5;
    const inner=bufferKm/kmPerCell+Math.SQRT2;
    const outer=inner+fadeKm/kmPerCell;
    const distance=new Float32Array(w*h).fill(outer);
    const offsets=[];
    for(let dy=-Math.ceil(outer);dy<=Math.ceil(outer);dy++)
        for(let dx=-Math.ceil(outer);dx<=Math.ceil(outer);dx++) {
            const d=Math.hypot(dx,dy); if(d<outer) offsets.push({dx,dy,d});
        }
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) if(seeds[y*w+x])
        for(const {dx,dy,d} of offsets) {
            const xx=x+dx,yy=y+dy;
            if(xx>=0&&yy>=0&&xx<w&&yy<h) distance[yy*w+xx]=Math.min(distance[yy*w+xx],d);
        }
    const weight=Float32Array.from(distance,d=>1-smooth((d-inner)/(outer-inner)));
    return {face,rect,base,weight,windowCells,bufferKm,fadeKm,shelfM};
}

function bilinear(a,w,h,x,y) {
    x=Math.max(0,Math.min(w-1,x-.5)); y=Math.max(0,Math.min(h-1,y-.5));
    const ix=Math.floor(x),iy=Math.floor(y),tx=x-ix,ty=y-iy;
    const jx=Math.min(w-1,ix+1),jy=Math.min(h-1,iy+1);
    return (a[iy*w+ix]*(1-tx)+a[iy*w+jx]*tx)*(1-ty)
        +(a[jy*w+ix]*(1-tx)+a[jy*w+jx]*tx)*ty;
}
function sample(field,d,which='weight') {
    const p=Cube.bakePixel({face:field.face},field.rect,d);
    return bilinear(field[which],field.rect.width,field.rect.height,p.x,p.y);
}

/* Model addresses are i=-Y, j=X. Align blocks globally, not relative to each
 * tile's bounding rectangle, so every overlapping request makes one decision.
 * A cell of guard covers bilinear weights and native bicubic DEM sampling. */
function windows(field,rect) {
    const {width:w,height:h,originI,originJ}=field.rect;
    const si=-(rect.originJ+rect.height),sj=rect.originI;
    const ei=si+rect.height,ej=sj+rect.width,b=field.windowCells;
    const selected=(i,j)=> {
        const y0=i+originJ+h,x0=j-originI;
        for(let y=Math.max(0,y0-1);y<Math.min(h,y0+b+1);y++)
            for(let x=Math.max(0,x0-1);x<Math.min(w,x0+b+1);x++)
                if(field.weight[y*w+x]>0) return true;
        return false;
    };
    const result=[];
    function visit(i,j,size) {
        if(i>=ei||j>=ej||i+size<=si||j+size<=sj) return;
        let active=0;
        for(let y=i;y<i+size;y+=b)for(let x=j;x<j+size;x+=b)if(selected(y,x))active++;
        if(!active) return;
        if(size===b||active===(size/b)**2) {result.push({i,j,h:size,w:size});return;}
        const half=size/2;
        visit(i,j,half);visit(i,j+half,half);visit(i+half,j,half);visit(i+half,j+half,half);
    }
    // Canonical square requests are crucial: upstream laplacian_denoise
    // resizes a rectangular field using its width as a scalar short-edge
    // target. Different rectangle shapes therefore change the same ground.
    // Partition the global mask, then intersect jobs with that partition.
    // Never clip the *query*; clip only the copied output.
    for(let i=Math.floor(si/8)*8;i<ei;i+=8) for(let j=Math.floor(sj/8)*8;j<ej;j+=8)visit(i,j,8);
    return result;
}

module.exports={createFace,sample,bilinear,windows};
