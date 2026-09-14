/* A small spherical halo for filtering finalized campaign tiles. Only halo
 * pixels take the spherical sampling path; native interiors remain exact. */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {readFineMask} from './campaign-fields.mjs';
const require=createRequire(import.meta.url), Cube=require('../src/cubesphere');

// A cube fold can project between the first pixel centre and the face edge.
// Extend that half-pixel from the nearest two samples; clamping flattens the
// slope before the Gaussian even sees it. Interiors use ordinary bilinear.
function sample(source,x,y) {
    const u=x-.5,v=y-.5;
    const ix=Math.max(0,Math.min(source.width-2,Math.floor(u)));
    const iy=Math.max(0,Math.min(source.height-2,Math.floor(v)));
    const tx=u-ix,ty=v-iy,k=iy*source.width+ix,a=source.data;
    return (a[k]*(1-tx)+a[k+1]*tx)*(1-ty)
        +(a[k+source.width]*(1-tx)+a[k+source.width+1]*tx)*ty;
}

export async function campaignHalo(dir) {
    const settings=await readFile(join(dir,'campaign-settings.json'),'utf8').then(JSON.parse).catch(err=>{
        if(err.code==='ENOENT')return null;throw err;
    });
    if(settings?.seamMode!=='symmetric')return null;
    const fine=await readFineMask(dir,settings);
    const cache=new Map();
    async function load(name) {
        if(cache.has(name))return cache.get(name);
        if(fine&&!fine.tiles.has(name))return null;
        const folder=join(dir,'crop-'+name);
        const done=JSON.parse(await readFile(join(folder,'seam-complete.json'),'utf8'));
        if(done.sketchFingerprint!==settings.sketchFingerprint||done.blendKm!==settings.blendKm||done.maskKey!==(fine?.maskKey??null))
            throw new Error('Unfinalized preview source '+name);
        const size=JSON.parse(await readFile(join(folder,'output.elev.json'),'utf8'));
        const buffer=await readFile(join(folder,'output.elev'));
        if(buffer.length!==size.width*size.height*4)throw new Error('Truncated preview source '+name);
        const value={...size,data:new Float32Array(buffer.buffer,buffer.byteOffset,buffer.length/4)};
        cache.set(name,value);return value;
    }
    return async function padded(tile,src,width,height,pad) {
        // All sources for this tile stay live until its halo is finished.
        cache.clear();await load(Cube.tileName(tile));
        const stride=width+2*pad,rows=height+2*pad,out=new Float32Array(stride*rows);
        for(let y=0;y<height;y++)out.set(src.subarray(y*width,(y+1)*width),(y+pad)*stride+pad);
        const rim=[];
        for(let y=-pad;y<height+pad;y++)for(let x=-pad;x<width+pad;x++) {
            if(x>=0&&x<width&&y>=0&&y<height)continue;
            const d=Cube.tileDirection(tile,(x+.5)/width,(y+.5)/height),ll=Cube.xyzToLonLat(d);
            const neighbor=Cube.tileAt(ll.lon,ll.lat,tile.level),name=Cube.tileName(neighbor);
            rim.push({x,y,d,ll,neighbor,name});
        }
        for(const name of new Set(rim.map(p=>p.name)))await load(name);
        for(const p of rim) {
            const source=cache.get(p.name);let z;
            if(!source)z=fine.base(p.d);
            else {
                const pixel=Cube.tilePixel(p.neighbor,p.ll.lon,p.ll.lat,source.width,source.height);
                z=sample(source,pixel.x,pixel.y);
            }
            out[(p.y+pad)*stride+p.x+pad]=z;
        }
        return out;
    };
}
