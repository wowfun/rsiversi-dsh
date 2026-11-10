import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {searchRuntime,toolNames} from '../../../../fixtures/session-search/runtime.mjs';
import {searchCorpus,messageEvent} from '../../../../fixtures/session-search/corpus.mjs';

const cohort=process.env.RSI_DSH_MARKET_COHORT;
const text=result=>result.content.filter(block=>block.type==='text').map(block=>block.text).join('\n');

test('published session-search bundle preserves all five tools through the native tool transport',
  {skip:!cohort,timeout:120000},async t=>{
    const directory=await mkdtemp(join(tmpdir(),'rsi-search-'));
    const corpus=searchCorpus();
    const runtimes=[];
    t.after(async()=>{for(const runtime of runtimes.reverse())await runtime.close();await rm(directory,{recursive:true,force:true});});
    const original=await searchRuntime({cohort,corpus,profile:join(directory,'original'),kind:'original'});
    runtimes.push(original);
    const bridge=await searchRuntime({cohort,corpus,profile:join(directory,'bridge'),kind:'bridge',
      callerLog:{header:original.caller.header,events:original.caller.snapshotEvents()}});
    runtimes.push(bridge);
    assert.equal(bridge.version,original.version);
    async function compare(name,args){
      const expected=await original.execute(name,args),actual=await bridge.execute(name,args);
      assert.equal(expected.isError,false,JSON.stringify(expected));
      assert.deepEqual(actual,expected);return text(actual);
    }
    await t.test('cold full-text indexing, workspace filter and strongest event per Session',async()=>{
      const output=await compare(toolNames[0],{query:'archive needle',max_results:100});
      assert.match(output,/search-0\b/);assert.doesNotMatch(output,/search-11\b/);
      const reads=bridge.counters.capture;
      await compare(toolNames[0],{query:'archive needle',max_results:100});
      assert.equal(bridge.counters.capture,reads,'unchanged index must not reopen event logs');
      await compare(toolNames[0],{query:'nonexistenttoken'});
    });
    await t.test('exact reads, event search and both lineage tools',async()=>{
      await compare(toolNames[1],{session_id:'search-0',query:'event3'});
      const trace=await compare(toolNames[2],{session_id:'search-0'});assert.match(trace,/search-1\b/);
      await compare(toolNames[3],{session_id:'search-0',seq:3});
      const read=await compare(toolNames[4],{session_id:'search-0',seq:3,before:1,after:1});assert.match(read,/event3/);
    });
    await t.test('current Session search excludes the performing step',async()=>{
      assert.match(await compare(toolNames[1],{query:'priorvisible'}),/priorvisible/);
      assert.doesNotMatch(await compare(toolNames[1],{query:'performinghidden'}),/seq \d/);
    });
    await t.test('incremental durable append invalidates the index',async()=>{
      const event=messageEvent(corpus[0].events.length,'incrementalunique marker');
      await original.append('search-0',event);await bridge.append('search-0',event);
      assert.match(await compare(toolNames[0],{query:'incrementalunique'}),/search-0\b/);
      await compare(toolNames[4],{session_id:'search-0',seq:event.seq});
    });
    await t.test('cross-workspace exact access is rejected by the original tool policy',async()=>{
      const args={session_id:'search-11',seq:0};
      const expected=await original.execute(toolNames[4],args),actual=await bridge.execute(toolNames[4],args);
      assert.equal(expected.isError,true);assert.deepEqual(actual,expected);
    });
    await t.test('reloading the bundle rebuilds its isolated index from current persistence',async()=>{
      await original.reopen();await bridge.reopen();
      assert.match(await compare(toolNames[0],{query:'incrementalunique'}),/search-0\b/);
    });
  });
