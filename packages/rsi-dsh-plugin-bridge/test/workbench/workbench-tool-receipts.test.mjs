import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {toolLedger} from '../../src/tools/application-tool-ledger.mjs';
import {workbenchHistory} from '../../src/workbench/history.mjs';
import {historyPage} from '../fixtures/history-page.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('only a captured native ToolResult releases its recovery copy, independently of later presentation failure',
  {skip:!root},async t=>{
    const require=createRequire(join(root,'package.json'));
    const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
    const ctx=new (await load('cordis')).Context();t.after(()=>ctx.fiber.dispose());
    const api={...await load('dsh-session'),...await load('dsh-session/surface'),...await load('dsh-util-values')};
    const directory=await mkdtemp(join(tmpdir(),'rsi-native-receipt-'));t.after(()=>rm(directory,{recursive:true,force:true}));
    const ledger=await toolLedger(directory,writeFile);t.after(()=>ledger.close());
    const input={session:'one',effect:'effect',registration:'registration',name:'tool',args:{},
      identity:{invocation_id:'effect',call_id:'call',owner_id:'owner',request_sha256:'a'.repeat(64)}};
    const result={content:[],value:'body',is_error:false};
    const settled=await ledger.start(input,()=>result);
    let through=0;
    // Fact causality is validated by Store. This reader exercises only the
    // projection boundary and its exact committed identity, not native admission.
    const facts=[{seq:1,timestamp_ms:1,type:'tool_result',effect_id:input.effect,identity:input.identity,result},
      {seq:2,timestamp_ms:0,type:'step_ended'}];
    const calls=[];
    const history=workbenchHistory({ctx,api,llm:await load('dsh-llm'),storage:{read:async()=>undefined,save:async()=>{}},
      read:async(id,op)=>{
        if(op.type==='open')return {id,created_at:1,inherited:false,through,
          selection_cursor:{kind:'durable',fact_seq:through,control_seq:0},
          model_baseline:{model:{deployment:'native',model:'configured'}}};
        assert.equal(op.type,'fact');
        return historyPage(facts.slice(op.after_seq,op.through_seq),op.through_seq,op.offset);
      },retireToolOutcome(...args){calls.push(args);return ledger.retire(...args);}});
    t.after(()=>history.close());
    const session=await history.capture('one',await history.metadata('one'));
    const journal=history.owner(session).journal;
    journal.append('hook/result',{value:'a local result is not native publication'});
    assert.deepEqual(await ledger.outcome(input),settled);
    assert.deepEqual(calls,[]);
    through=2;
    await assert.rejects(history.capture('one',await history.metadata('one')),/canonical Fact time/);
    assert.deepEqual(await readdir(directory),[]);
    assert.deepEqual(calls,[['one','effect',input.identity]]);
    assert.equal(session.seq,1,'the failed projection must not publish its staged events');
    assert.deepEqual(await ledger.start(input,()=>assert.fail('canonical body repeated')),{state:'unknown'});
  });
