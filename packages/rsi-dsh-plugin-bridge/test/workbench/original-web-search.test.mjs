import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {originalWebProfile} from '../../../../fixtures/session-search/original-web/index.mjs';
import {searchCorpus} from '../../../../fixtures/session-search/corpus.mjs';

const cohort=process.env.RSI_DSH_MARKET_COHORT;
test('stock Web profile searches through its real Messages provider and compressed checkpoints',
  {skip:!cohort,timeout:180000},async t=>{
    const profile=await mkdtemp(join(tmpdir(),'rsi-original-web-'));
    let runtime;const logs=[];
    t.after(async()=>{try{await runtime?.close();}finally{
      assert.equal(dirname(profile),tmpdir());
      await rm(profile,{recursive:true,force:true});
    }});
    try{
      runtime=await originalWebProfile({cohort,profile,corpus:searchCorpus({cwd:join(profile,'workspace')}),verifyDurability:true,onLog:text=>logs.push(text)});
      assert.deepEqual(runtime.opening.bundles,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@deepseek-ai/dsh-experimental-session-search']);
      const calls=[['session_search',{query:'archive needle'}],['session_event_search',{session_id:'search-0',query:'event3'}],
        ['session_trace',{session_id:'search-0'}],['session_event_trace',{session_id:'search-0',seq:3}],['session_event_read',{session_id:'search-0',seq:3}]];
      const ids=[];
      for(const [name,args] of calls){
        const result=await runtime.execute(name,args);ids.push(result.callId);assert.equal(result.result.isError,false);
        if(name==='session_search'){
          assert.match(JSON.stringify(result.result.content),/search-0\b/);
          assert.doesNotMatch(JSON.stringify(result.result.content),/search-11\b/);
        }
      }
      const before=await runtime.snapshot();assert.deepEqual(before.checks,ids);
      const requests=runtime.provider.requests.filter(row=>!row.auxiliary);
      assert.equal(requests.length,10);
      const shell=process.platform==='win32'?'pwsh':'bash';
      assert.ok(requests.every(row=>row.path==='/v1/messages'&&row.tools.includes(shell)&&row.tools.includes('skill')));
      assert.ok((await readdir(join(profile,'sessions'),{recursive:true})).some(name=>name.endsWith('.jsonl.zstd')),'Default compressed logs must be exercised');
      const results=before.events.filter(row=>row.type==='tool/result');
      assert.equal(results.length,5);
      await runtime.close();runtime=undefined;
      runtime=await originalWebProfile({cohort,profile,resume:true,onLog:text=>logs.push(text),onRequest:()=>assert.fail('Cold resume must not dispatch a model')});
      assert.deepEqual((await runtime.snapshot()).events.filter(row=>row.type==='tool/result'),results);
      assert.deepEqual((await runtime.read()).filter(row=>row.type==='tool/result'),results);
    }catch(error){t.diagnostic(logs.join('').slice(-16000));throw error;}
  });
