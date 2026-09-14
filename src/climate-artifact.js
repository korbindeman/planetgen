/* Independent Finish artifact. Layout/Shape schemas and fields stay intact. */
'use strict';
const Codec=require('./field-codec');
const Grid=require('./climate-grid');
const Climate=require('./seasonal-climate');
const SCHEMA=1;
const MONTHLY=['temperature','precipitation','evaporation','runoff','snowCover','seaIce','winds'];
function encode(result,sourceFingerprint) {
    const monthly={};for(const name of MONTHLY)monthly[name]=Codec.encodeF32(result.monthly[name]);
    return {schema:SCHEMA,version:result.version,sourceFingerprint,options:result.options,body:result.body,
        cells:result.grid.n,land:Codec.encodeF32(Float32Array.from(result.grid.land)),height:Codec.encodeF32(Float32Array.from(result.grid.height)),
        monthly,diagnostics:result.diagnostics};
}
function decode(payload,expectedFingerprint) {
    if(payload?.schema!==SCHEMA||payload.version!==Climate.VERSION)throw new Error('Unsupported Finish climate artifact');
    if(expectedFingerprint&&payload.sourceFingerprint!==expectedFingerprint)throw new Error('Finish climate belongs to different saved inputs');
    const cells=payload.cells;
    if(!Number.isInteger(cells)||cells<129||cells>40001||cells!==payload.options?.climateCells+1)throw new Error('Invalid Finish climate grid');
    if(!(payload.body?.radiusKm>0))throw new Error('Invalid Finish climate body');
    function field(encoded,n,name,min=-Infinity,max=Infinity) {
        if(typeof encoded!=='string'||Buffer.from(encoded,'base64').byteLength!==n*4)throw new Error(`Truncated Finish climate ${name}`);
        const out=Codec.decodeF32(encoded,n);for(const x of out)if(!Number.isFinite(x)||x<min||x>max)throw new Error(`Invalid Finish climate ${name}`);
        return out;
    }
    const grid=Grid.makeGrid(cells-1,payload.body.radiusKm),monthly={};
    grid.land=field(payload.land,cells,'land',0,1);grid.height=field(payload.height,cells,'height',0);
    for(const name of MONTHLY)monthly[name]=field(payload.monthly?.[name],cells*12*(name==='winds'?3:1),name,
        ['temperature','winds'].includes(name)?-Infinity:0,['snowCover','seaIce'].includes(name)?1.000001:Infinity);
    if(!payload.diagnostics?.converged)throw new Error('Finish climate did not reach a stable annual cycle');
    return {...payload,grid,monthly,annual:Climate.summarize(monthly.temperature,monthly.precipitation,cells)};
}
module.exports={SCHEMA,MONTHLY,encode,decode};
