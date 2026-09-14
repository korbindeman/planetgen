/* Source rasters and exact interior mips for the package. Every mip gets its
 * border from neighbours at that same mip, including folds and corners. */
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {readFineMask} from './campaign-fields.mjs';
import {assertHeightEncoding} from './terrain-encoding.mjs';
const require=createRequire(import.meta.url),Cube=require('../src/cubesphere');
const Planet=require('../src/planet'),TdTile=require('../src/td-tile'),Tectonics=require('../src/tectonics');

export function metres(value) {
    if(!Number.isFinite(value))throw new Error('Non-finite package terrain');
    return Math.max(-32767,Math.min(32767,Math.round(value)));
}

export function reduceInterior(input,width) {
    if(width%2||input.length!==width*width)throw new Error('Invalid package mip dimensions');
    const half=width/2,out=new Int16Array(half*half);
    for(let y=0;y<half;y++)for(let x=0;x<half;x++) {
        const k=2*y*width+2*x;
        out[y*half+x]=Math.round((input[k]+input[k+1]+input[k+width]+input[k+width+1])/4);
    }
    return out;
}

// Pixel coordinates here count sample centres, unlike Cube.tilePixel, which
// measures from the raster edge. Preserve integer same-face copies exactly.
export function skirtSamples(tile,width) {
    const n=1<<tile.level,span=width+2,points=[];
    function add(x,y) {
        const gx=tile.i*width+x,gy=(n-1-tile.j)*width+y;
        let neighbor,sx,sy;
        if(gx>=0&&gx<n*width&&gy>=0&&gy<n*width) {
            neighbor={face:tile.face,level:tile.level,i:Math.floor(gx/width),j:n-1-Math.floor(gy/width)};
            sx=gx%width;sy=gy%width;
        } else {
            const d=Cube.tileDirection(tile,(x+.5)/width,(y+.5)/width),ll=Cube.xyzToLonLat(d);
            neighbor=Cube.tileAt(ll.lon,ll.lat,tile.level);
            const pixel=Cube.tilePixel(neighbor,ll.lon,ll.lat,width,width);
            sx=pixel.x-.5;sy=pixel.y-.5;
        }
        points.push({offset:(y+1)*span+x+1,tile:neighbor,x:sx,y:sy});
    }
    for(let x=-1;x<=width;x++){add(x,-1);add(x,width);}
    for(let y=0;y<width;y++){add(-1,y);add(width,y);}
    return points;
}

export function sampleRaster(data,width,x,y,stride=width,pad=0) {
    // A folded coordinate can lie in the half-pixel between a source's
    // outermost centre and its edge. Extend that slope, rather than clamp it.
    const x0=Math.max(0,Math.min(width-2,Math.floor(x))),y0=Math.max(0,Math.min(width-2,Math.floor(y)));
    const x1=x0+1,y1=y0+1;
    const tx=x-x0,ty=y-y0;
    return (data[(y0+pad)*stride+x0+pad]*(1-tx)+data[(y0+pad)*stride+x1+pad]*tx)*(1-ty)
        +(data[(y1+pad)*stride+x0+pad]*(1-tx)+data[(y1+pad)*stride+x1+pad]*tx)*ty;
}

export function padRaster(data,width,points,read) {
    const span=width+2,out=new Int16Array(span*span);
    for(let y=0;y<width;y++)out.set(data.subarray(y*width,(y+1)*width),(y+1)*span+1);
    for(const p of points)out[p.offset]=metres(read(p));
    return out;
}

// Parents below the bake-tile level fit in memory. Finish a whole level's
// interiors before sampling its borders; a neighbour's old skirt is irrelevant.
export function fillLevelSkirts(nodes,lod,resolution) {
    const n=1<<lod,stride=resolution+2;
    for(let face=0;face<6;face++)for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
        const tile={face,level:lod,i:x,j:n-1-y},out=nodes.get(`${face}/${lod}/${x}/${y}`);
        if(!out)throw new Error('Missing package mip node');
        for(const p of skirtSamples(tile,resolution)) {
            const t=p.tile,source=nodes.get(`${t.face}/${lod}/${t.i}/${n-1-t.j}`);
            if(!source)throw new Error('Missing package mip neighbour');
            out[p.offset]=metres(sampleRaster(source,resolution,p.x,p.y,stride,1));
        }
    }
}

export function reduceNodes(children,resolution) {
    const stride=resolution+2,out=new Int16Array(stride*stride);
    if(children.some(c=>!c||c.length!==stride*stride))throw new Error('Missing package child');
    // Borders are deliberately left unset until the entire level exists.
    for(let y=0;y<resolution;y++)for(let x=0;x<resolution;x++) {
        let sum=0;
        for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++) {
            const px=2*x+dx,py=2*y+dy,qx=px>=resolution?1:0,qy=py>=resolution?1:0;
            sum+=children[qy*2+qx][(py%resolution+1)*stride+px%resolution+1];
        }
        out[(y+1)*stride+x+1]=Math.round(sum/4);
    }
    return out;
}

async function optionalJson(path) {
    try{return JSON.parse(await readFile(path,'utf8'));}
    catch(err){if(err.code==='ENOENT')return null;throw err;}
}

export async function createPackageTerrain({bakeDir,planet,sketchFingerprint,level,cells,tileSide,nodeRes,leafLod}) {
    const settings=await optionalJson(join(bakeDir,'campaign-settings.json'));
    if(settings&&(settings.level!==level||settings.cells!==cells||settings.pxPerCell!==tileSide/cells
        ||settings.radiusKm!==planet.body.radiusKm||settings.sketchFingerprint!==sketchFingerprint))
        throw new Error('Package inputs differ from the saved bake campaign');
    assertHeightEncoding(settings,settings?.heightEncoding,'Package campaign');
    const fine=await readFineMask(bakeDir,settings||{});
    if(fine&&settings?.seamMode!=='symmetric')throw new Error('Fine mask requires a symmetric campaign');
    const strict=settings?.seamMode==='symmetric';
    async function metaFor(tile) {
        const name=Cube.tileName(tile);
        if(fine&&!fine.tiles.has(name))return null;
        const dir=join(bakeDir,'crop-'+name),meta=await optionalJson(join(dir,'output.elev.json'));
        if(!meta&&!strict)return null;
        if(!meta||meta.width!==tileSide||meta.height!==tileSide)
            throw new Error('Missing or mismatched package source '+name);
        assertHeightEncoding(meta,settings?.heightEncoding,'Package source '+name);
        if(strict) {
            const done=await optionalJson(join(dir,'seam-complete.json'));
            if(!done||done.sketchFingerprint!==sketchFingerprint||done.blendKm!==settings.blendKm
                ||done.maskKey!==(fine?.maskKey??null))throw new Error('Unfinalized package source '+name);
            assertHeightEncoding(done,settings.heightEncoding,'Finalized terrain '+name);
        }
        const size=await stat(join(dir,'output.elev'));
        if(size.size!==tileSide*tileSide*4)throw new Error('Truncated package source '+name);
        return {dir,...meta};
    }
    // Fail before creating an output file if any required source is unfinished.
    const metadata=new Map(),n=1<<level;
    for(let face=0;face<6;face++)for(let j=0;j<n;j++)for(let i=0;i<n;i++) {
        const tile={face,level,i,j};metadata.set(Cube.tileName(tile),await metaFor(tile));
    }
    const cache=new Map();
    async function load(tile) {
        const name=Cube.tileName(tile);
        if(cache.has(name)) {
            const value=cache.get(name);cache.delete(name);cache.set(name,value);return value;
        }
        const meta=metadata.get(name),native=new Int16Array(tileSide*tileSide);
        if(meta) {
            const raw=await readFile(join(meta.dir,'output.elev'));
            if(raw.length!==native.length*4)throw new Error('Truncated package source '+name);
            const source=new Float32Array(raw.buffer,raw.byteOffset,native.length);
            for(let k=0;k<native.length;k++)native[k]=metres(source[k]);
        } else if(fine) {
            for(let y=0;y<tileSide;y++)for(let x=0;x<tileSide;x++)
                native[y*tileSide+x]=metres(fine.base(Cube.tileDirection(tile,(x+.5)/tileSide,(y+.5)/tileSide)));
        } else {
            // Legacy campaigns predate the common mask field. Rasterize in the
            // cube tile's coordinates, with a coarse border for interpolation.
            const pad=1,w=cells+2*pad,raw=Planet.rasterizeCubeTile(planet.mesh,planet.map,tile,cells,cells,0,pad);
            const heights=Float32Array.from(raw.elev,Tectonics.elevationToMeters);
            for(let y=0;y<tileSide;y++)for(let x=0;x<tileSide;x++)
                native[y*tileSide+x]=metres(TdTile.samplePadded(heights,w,w,(x+.5)/tileSide,(y+.5)/tileSide,pad));
        }
        const mips=new Map([[leafLod,native]]);let width=tileSide;
        for(let lod=leafLod-1;lod>=level;lod--) {
            mips.set(lod,reduceInterior(mips.get(lod+1),width));width/=2;
        }
        if(width!==nodeRes)throw new Error('Package tile root dimensions differ');
        const value={mips,covered:!!meta};cache.set(name,value);
        while(cache.size>12)cache.delete(cache.keys().next().value);
        return value;
    }
    return {
        settings,fine,
        async extendedTile(face,i,j,lod) {
            const tile={face,level,i,j},width=nodeRes*(1<<(lod-level)),self=await load(tile);
            const points=skirtSamples(tile,width),sources=new Map([[Cube.tileName(tile),self]]);
            for(const p of points) {
                const name=Cube.tileName(p.tile);
                if(!sources.has(name))sources.set(name,await load(p.tile));
            }
            const ext=padRaster(self.mips.get(lod),width,points,p=>sampleRaster(sources.get(Cube.tileName(p.tile)).mips.get(lod),width,p.x,p.y));
            return {ext,span:width+2,covered:self.covered};
        },
    };
}
