import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {originalSearchAgent} from '../../../../fixtures/session-search/original-agent.mjs';
import {searchDistribution} from '../../../../fixtures/session-search/distribution.mjs';
import {searchCorpus} from '../../../../fixtures/session-search/corpus.mjs';

const cohort=process.env.RSI_DSH_MARKET_COHORT;

test('original search baseline checkpoints real Agent calls and results and resumes without redispatch',
  {skip:!cohort,timeout:120000},async t=>{
    const profile=await mkdtemp(join(tmpdir(),'rsi-search-agent-'));
    let runtime,reader;
    t.after(async()=>{
      try {await runtime?.close();}finally{await reader?.fiber.dispose();await rm(profile,{recursive:true,force:true});}
    });
    const {load}=await searchDistribution(cohort),{Context}=await load('@deepseek-ai/cordis');
    reader=new Context();
    await reader.plugin(await load('@deepseek-ai/dsh-session-persistence-jsonl'),
      {root:join(profile,'sessions'),compression:'none'});
    async function read() {
      const handle=await reader.sessionPersistence.open('search-caller','read');
      try {return (await handle.read()).events;}finally{await handle.close();}
    }
    const checkpoints=[],dispatches=[];
    runtime=await originalSearchAgent({cohort,profile,corpus:searchCorpus(),onRequest:async({request,callId})=>{
      const rows=await read();
      assert.ok(rows.some(row=>row.type==='request/header'),'Model request must already be logged');
      if(request===1) {
        assert.ok(rows.some(row=>row.type==='tool/result'&&row.data.message.source.callId===callId),
          'Result must be independently readable before the next model request');
        checkpoints.push(callId);
      }
    }});
    const detach=runtime.app.ctx.on('tools/execute',async(exec,next)=>{
      const rows=await read();
      assert.ok(rows.some(row=>row.type==='tool/call'&&row.data.callId===exec.callId),
        'Call must be independently readable before dispatch');
      dispatches.push(exec.callId);return next();
    });
    const calls=[['session_search',{query:'archive needle'}],['session_event_search',{session_id:'search-0',query:'event3'}],
      ['session_trace',{session_id:'search-0'}],['session_event_trace',{session_id:'search-0',seq:3}],
      ['session_event_read',{session_id:'search-0',seq:3}]];
    for(const [name,args] of calls) {
      const value=await runtime.execute(name,args);
      assert.equal(value.result.isError,false,JSON.stringify(value));assert.ok(value.toolCycleMs>0);
      if(name==='session_search') {
        const text=JSON.stringify(value.result.content);assert.match(text,/search-0\b/);assert.doesNotMatch(text,/search-11\b/);
      }
    }
    assert.deepEqual(checkpoints,dispatches);assert.equal(dispatches.length,5);
    const refuse=runtime.app.ctx.on('session/flush',session=>{
      if(session.snapshotEvents().at(-1)?.type==='tool/call')throw Error('fixture checkpoint refusal');
    });
    try {
      const failed=await runtime.execute('session_event_read',{session_id:'search-0',seq:3});
      assert.equal(failed.result.isError,true);
      assert.match(JSON.stringify(failed.result.content),/fixture checkpoint refusal/);
      assert.equal(dispatches.length,5,'Checkpoint rejection must prevent downstream tool execution');
    }finally{refuse();detach();}
    const before=runtime.agent.session.snapshotEvents();
    await runtime.close();runtime=undefined;
    assert.deepEqual(await read(),before,'Normal Agent teardown must persist the final turn');
    runtime=await originalSearchAgent({cohort,profile,resume:true,onRequest:()=>assert.fail('Resume must not request a model')});
    await runtime.agent.whenIdle();
    assert.deepEqual(runtime.agent.session.snapshotEvents().filter(row=>row.type==='tool/result'),
      before.filter(row=>row.type==='tool/result'));
  });
