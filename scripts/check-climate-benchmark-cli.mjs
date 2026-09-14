/** Benchmark failures must not overwrite an existing comparison. No solve. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),G=require('../src/climate-grid'),W=require('../src/world');
const out=await mkdtemp(join(tmpdir(),'planetgen-climate-benchmark-'));
const grid=G.makeGrid(200,6371);
await writeFile(join(out,'input.json'),JSON.stringify({schema:1,cells:200,body:W.EARTH,land:Array(grid.n).fill(0),height:Array(grid.n).fill(0)}));
await mkdir(join(out,'baseline'));await writeFile(join(out,'baseline/run.json'),'saved comparison');
for(const [args,pattern] of [
    [['grid','--cells=NaN'],/climateCells/],
    [['run','--name=baseline'],/already exists/],
    [['run','--options='+JSON.stringify({climateStepDays:4})],/divide/],
    [['run','--options='+JSON.stringify({climateCells:400})],/Rebuild the Earth input/],
]) {
    const result=spawnSync(process.execPath,['scripts/benchmark-earth-climate.mjs',...args,'--out='+out],{encoding:'utf8',windowsHide:true});
    assert.notEqual(result.status,0);assert.match(result.stderr,pattern);
}
assert.equal(await readFile(join(out,'baseline/run.json'),'utf8'),'saved comparison');
console.log('Benchmark rejects invalid settings, grid mismatch and overwriting a saved run');
