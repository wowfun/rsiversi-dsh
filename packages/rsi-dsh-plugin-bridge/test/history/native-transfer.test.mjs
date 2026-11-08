import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadCohort} from '../../../rsi-dsh-cordis/src/runtime/cohort.mjs';
import {SessionFacade} from '../../src/session/session.mjs';
import {factObserver,restoreMapping,prepareStep} from '../../src/history/history.mjs';
import {inputMessage,observeInput,observeTool} from '../../src/history/conversation-history.mjs';
import {preparedMessages} from '../../src/history/input-history.mjs';
import {workbenchInbox} from '../../src/workbench/inbox.mjs';
import {workbenchModel} from '../../src/workbench/model.mjs';

const root=process.env.RSI_DSH_COHORT;
test('native projection transfers converted events without freezing borrowed observations',{skip:!root},async t=>{
  const cohort=await loadCohort(root),ctx=new (await cohort.import('@deepseek-ai/cordis')).Context();
  t.after(()=>ctx.fiber.dispose());
  const api={...await cohort.import('@deepseek-ai/dsh-session'),...await cohort.subpath('@deepseek-ai/dsh-session','surface'),
    ...await cohort.import('@deepseek-ai/dsh-util-values')};
  let snapshots=0;const snapshot=api.snapshotJsonValue;
  api.snapshotJsonValue=value=>{if(value?.type)snapshots++;return snapshot(value);};
  const session=new SessionFacade(ctx,api,{header:{version:4,id:'native-transfer',createdAt:1,isSeeded:false}},false);
  const mapping=restoreMapping(),observe=factObserver(session,mapping,async()=>assert.fail('unexpected native read'));
  const source={type:'human',message_id:'image'},dimensions={width:10,height:20};
  const image={type:'image',media:{id:'a'.repeat(64),mime:'image/png',bytes:10,width:1,height:2},
    presentation:{name:'image.png',original_dimensions:dimensions}};
  const fact={seq:3,type:'input_message_claimed',source,content:[{type:'text',text:'owned'},image]};
  const converted=inputMessage(session.id,fact);
  const attributed={kind:'fixture',nested:{name:'original'}};
  const toolsFact={type:'tool_contexts_claimed',messages:[{message:{id:'context',source:attributed,text:['tool context']}}]};
  const authored={role:'user',attribution:{id:'authored',source:attributed},content:[{type:'text',text:'authored context'}]};
  const prepared=await preparedMessages(session,mapping,{decision:{kind:'enter',messages:[{kind:'added',message:authored}]}},async()=>{});
  const native={message_id:'queued',source:{type:'command',source:{attribution:{id:'queued',source:attributed}}},
    content:[{type:'text',text:'queued context'},image]};
  const inbox=workbenchInbox(),choice={model:{deployment:'fixture',model:'native'},reasoning_effort:'high'};
  const metadata={error:{name:'FixtureError',message:'failed',details:{code:1}},meta:{extra:{value:1}}};
  session.begin();
  try{
    await observe({type:'message_turn_accepted',turn_id:'turn',seq:1,timestamp_ms:1});
    await observe({type:'step_started',turn_id:'turn',step_id:'step',seq:2,timestamp_ms:2});
    prepareStep(session,mapping,'turn','step',2);
    observeInput(session,mapping,converted,3);
    assert.equal(session.lastEvent('user/message').data,converted,'converted content is owned by admission');
    observeInput(session,mapping,inputMessage(session.id,toolsFact),4);
    observeInput(session,mapping,prepared[0],5);
    inbox.observe({kind:'accepted',message_id:'queued',message:native,target:'next_step',seq:1,time:6},session,1);
    const pending=inbox.snapshot()['next-step'][0];
    assert.equal(pending,session.lastEvent('agent/inbox/spliced').data.inserted[0]);
    inbox.observe({kind:'promoted',message_id:'queued',seq:2,time:7},session,1);
    assert.equal(inbox.snapshot()['next-turn'][0],pending,'queue transitions share an admitted immutable message');
    workbenchModel(choice).observe({selection:choice,time:8},session);
    const assistant=session.adoptObserved({type:'assistant/message',seq:session.seq,time:9,surfaceOp:'append',
      data:{turn:1,step:1,stream:[],message:{id:'assistant',role:'assistant',source:{kind:'model',provider:'fixture',model:'test'},
        content:[{type:'tool-call',id:'call',name:'fixture',arguments:{value:1}}]}}});
    mapping.calls.push({id:'call',model:'model',effect:null,event:assistant.seq,callEvent:null,started:false,turn:1,step:1});
    observeTool(session,mapping,{type:'tool_intent',origin:{kind:'model',effect_id:'model'},identity:{call_id:'call'},
      name:'fixture',effect_id:'effect',timestamp_ms:10});
    assert.equal(session.lastEvent('tool/call').data.arguments,assistant.data.message.content[0].arguments);
    observeTool(session,mapping,{type:'tool_result',effect_id:'effect',identity:{call_id:'call'},timestamp_ms:11,
      result:{content:[{type:'text',text:'result'},image],is_error:true,metadata:{dsh:metadata}}});
    await observe({type:'turn_terminal',turn_id:'turn',seq:4,timestamp_ms:12,outcome:{status:'completed'}});
  }finally{session.end();}
  assert.equal(snapshots,0,'native producers must not copy an entire newly owned event');
  const encoded=JSON.stringify(session.snapshotEvents());
  for(const value of [source,dimensions,attributed,attributed.nested,authored,native,metadata,metadata.error.details,choice.model])
    assert.equal(Object.isFrozen(value),false,'borrowed native records remain independently owned');
  source.type='changed';dimensions.width=999;attributed.nested.name='changed';
  metadata.error.details.code=999;metadata.meta.extra.value=999;choice.model.model='changed';
  assert.equal(JSON.stringify(session.snapshotEvents()),encoded,'later native-record mutation cannot change admitted events');
  const frozen=value=>{if(value&&typeof value==='object'){assert.ok(Object.isFrozen(value));for(const child of Object.values(value))frozen(child);}};
  for(const event of session.snapshotEvents())frozen(event);
  assert.equal(session.encodedBytes,session.snapshotEvents().reduce((n,event)=>n+Buffer.byteLength(JSON.stringify(event)),0));
  const external={policy:{enabled:true}};session.begin();session.appendObserved('approval/policy',external,13);session.end();
  external.policy.enabled=false;
  assert.equal(session.lastEvent('approval/policy').data.policy.enabled,true,'external append keeps snapshot isolation');
});
