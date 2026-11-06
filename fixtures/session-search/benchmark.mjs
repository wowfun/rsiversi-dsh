import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {searchCorpus,messageEvent} from './corpus.mjs';
import {searchRuntime} from './runtime.mjs';

const cohort=process.env.RSI_DSH_MARKET_COHORT;
assert.ok(cohort,'Set RSI_DSH_MARKET_COHORT to an installed DSH distribution');
const output=resolve(process.argv[2]??'.local/session-search-adapter.json');
const corpus=searchCorpus({sessions:128,events:64});
const rows=[],directory=await mkdtemp(join(tmpdir(),'rsi-search-bench-'));
const result={scope:'adapter: synthetic native metadata/history, real application HTTP and receipts; original JSONL and tool pipeline',
  platform:process.platform,node:process.version,corpus:{sessions:128,eventsPerSession:64,
    sha256:createHash('sha256').update(JSON.stringify(corpus)).digest('hex')},rows};
async function measure(pair,scenario,round,iteration,name,args){
  const outcomes={};
  for(const kind of (round+iteration)%2?['bridge','original']:['original','bridge']) {
    const start=performance.now();outcomes[kind]=await pair[kind].execute(name,args);
    rows.push({scenario,round,iteration,kind,ms:performance.now()-start});
    assert.equal(outcomes[kind].isError,false,JSON.stringify(outcomes[kind]));
  }
  assert.deepEqual(outcomes.bridge,outcomes.original,scenario+' result equivalence');
}
try {
  for(let round=0;round<5;round++) {
    const pair={};
    try {
      pair.original=await searchRuntime({cohort,corpus,profile:join(directory,String(round),'original'),kind:'original'});
      pair.bridge=await searchRuntime({cohort,corpus,profile:join(directory,String(round),'bridge'),kind:'bridge',
        callerLog:{header:pair.original.caller.header,events:pair.original.caller.snapshotEvents()}});
      result.version=pair.original.version;
      await measure(pair,'cold-index',round,0,'session_search',{query:'archive needle',max_results:100});
      for(let iteration=0;iteration<8;iteration++) {
        await measure(pair,'unchanged',round,iteration,'session_search',{query:'archive needle',max_results:100});
        await measure(pair,'no-match',round,iteration,'session_search',{query:'nonexistenttoken'});
        await measure(pair,'exact-read',round,iteration,'session_event_read',{session_id:'search-0',seq:3});
      }
      const event=messageEvent(64,'incrementalunique marker');
      await pair.original.append('search-0',event);await pair.bridge.append('search-0',event);
      await measure(pair,'incremental',round,0,'session_search',{query:'incrementalunique'});
      console.log('Completed paired round',round+1);
    }finally{await pair.bridge?.close();await pair.original?.close();}
  }
  const summary=kind=>scenario=>{
    const values=rows.filter(row=>row.kind===kind&&row.scenario===scenario).map(row=>row.ms).sort((a,b)=>a-b);
    const middle=values.length/2;
    return {n:values.length,median:values.length%2?values[Math.floor(middle)]:(values[middle-1]+values[middle])/2,
      p95:values[Math.ceil(values.length*.95)-1]};
  };
  result.summary=[...new Set(rows.map(row=>row.scenario))].map(scenario=>{
    const original=summary('original')(scenario),bridge=summary('bridge')(scenario);
    return {scenario,original,bridge,passes:bridge.median<=original.median&&bridge.p95<=original.p95};
  });
  result.passes=result.summary.every(row=>row.passes);
  result.fullHostAcceptance=false;
  console.log(JSON.stringify(result.summary,null,2));
  if(!result.passes)process.exitCode=1;
}catch(error){result.error=error.stack;process.exitCode=1;console.error(error);}
finally {
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');
  await rm(directory,{recursive:true,force:true});
}
