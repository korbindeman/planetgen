/** Exercise precision identity in the real campaign control flow, using the
 * existing model-free worker fixture; no source variant or GPU is touched. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {HEIGHT_ENCODING,assertHeightEncoding,requireCurrentEncoding} from './terrain-encoding.mjs';

requireCurrentEncoding(null);
requireCurrentEncoding({heightEncoding:HEIGHT_ENCODING});
for(const previous of [{},{heightEncoding:'unknown'}])
    assert.throws(()=>requireCurrentEncoding(previous),/new variant/);
assert.throws(()=>requireCurrentEncoding(null,true),/new variant/);
assertHeightEncoding({},null,'Legacy');
assertHeightEncoding({heightEncoding:HEIGHT_ENCODING},HEIGHT_ENCODING,'Current');
for(const [record,expected] of [[{},HEIGHT_ENCODING],[{heightEncoding:HEIGHT_ENCODING},null],
    [{heightEncoding:'unknown'},'unknown']])
    assert.throws(()=>assertHeightEncoding(record,expected,'Fixture'),/encoding differs/);

const dir=await mkdtemp(join(tmpdir(),'planetgen-terrain-precision-'));
const calls=async()=>JSON.parse(await readFile(join(dir,'worker-calls.json'),'utf8'));
async function run(...flags) {
    const proc=Bun.spawn([process.execPath,join(import.meta.dir,'check-climate-campaign.mjs'),'--child',dir,...flags],{stdout:'pipe',stderr:'pipe'});
    const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
    return {out,err,code};
}
try {
    let result=await run();assert.equal(result.code,0,result.err);
    const settingsPath=join(dir,'campaign-settings.json'),text=await readFile(settingsPath,'utf8');
    const settings=JSON.parse(text);assert.equal(settings.heightEncoding,HEIGHT_ENCODING);
    const before=await calls();
    delete settings.heightEncoding;
    await writeFile(settingsPath,JSON.stringify(settings));
    result=await run('--force');assert.notEqual(result.code,0);assert.match(result.err,/precision changed.*new variant/);
    assert.deepEqual(await calls(),before,'A legacy campaign reached the new worker');
    assert.equal((await readFile(settingsPath,'utf8')),JSON.stringify(settings));
    await writeFile(settingsPath,text);
    for(const file of ['tile.json','campaign-complete.json','raw.elev.json']) {
        const path=join(dir,'crop-f0l3x1y1',file),record=JSON.parse(await readFile(path,'utf8'));
        assert.equal(record.heightEncoding,HEIGHT_ENCODING);
        delete record.heightEncoding;await writeFile(path,JSON.stringify(record));
        const n=(await calls()).length;
        result=await run();assert.equal(result.code,0,result.err);assert.match(result.out,/0 already baked/);
        assert.equal((await calls()).length,n+2,'An unstamped tile was reused');
        assert.equal(JSON.parse(await readFile(path,'utf8')).heightEncoding,HEIGHT_ENCODING);
    }
    const n=(await calls()).length;
    result=await run();assert.equal(result.code,0,result.err);assert.match(result.out,/1 already baked/);
    assert.equal((await calls()).length,n,'An intact corrected tile was regenerated');
    console.log('Terrain campaign: precision stamps survive bake/resume; legacy --force fails before writes or worker; incomplete stamps are regenerated');
} finally {
    const target=resolve(dir);
    assert(target.startsWith(resolve(tmpdir())+sep)&&target.split(sep).at(-1).startsWith('planetgen-terrain-precision-'));
    await rm(target,{recursive:true,force:true});
}
