import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('market acceptance rejects skipped, todo, failed and empty selections',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-market-gate-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const runner=fileURLToPath(new URL('../../../../scripts/test-market.mjs',import.meta.url));
  const env={...process.env,RSI_DSH_MARKET_COHORT:directory};delete env.NODE_TEST_CONTEXT;
  for(const [name,body,ok] of [
    ['pass',"test('runs',()=>{});",true],
    ['skip',"test('skips',{skip:true},()=>{});",false],
    ['todo',"test('pending',{todo:true},()=>{});",false],
    ['fail',"test('fails',()=>{throw Error('fixture failure')});",false],
    ['empty','',false],
  ]) {
    const file=join(directory,name+'.test.mjs');await writeFile(file,"import {test} from 'node:test';\n"+body);
    const work=promisify(execFile)(process.execPath,[runner,file],{env,windowsHide:true,timeout:15000});
    if(ok)await work;
    else await assert.rejects(work,error=>error.code===1&&/Market acceptance requires/.test(error.stderr),name);
  }
});
