import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {workbenchHistory} from '../../src/workbench/history.mjs';
import {followAssistant} from '../../src/workbench/assistant.mjs';
import {workbenchSource} from '../../src/workbench/source.mjs';
import {historyPage} from '../fixtures/history-page.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;

test('one control page reconstructs a full native inbox without per-message reads',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();t.after(()=>ctx.fiber.dispose());
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  const baseline={model:{deployment:'native',model:'configured'}};
  const controls=Array.from({length:64},(_,i)=>({kind:'accepted',seq:i+1,time:i+1,after_fact_seq:0,
    target:'next_step',message_id:'input-'+i,
    message:{message_id:'input-'+i,source:{type:'human'},content:[{type:'text',text:'context '+i}]}}));
  const calls=[],call=async op=>{
    calls.push(op);assert.equal(op.type,'controls');
    return historyPage(controls,64,op.offset);
  };
  const source=await workbenchSource({ctx,api,header:{version:4,id:'full-inbox',createdAt:1,isSeeded:false},
    meta:{model_baseline:baseline,selection_cursor:{kind:'durable',fact_seq:0,control_seq:64}},call});
  const stage=await source.stage(call,async()=>{},undefined,0,64);
  assert.equal(calls.length,1);
  assert.equal(source.current.session.seq,0);
  assert.deepEqual(stage.value.inbox.snapshot()['next-step'].map(message=>message.content[0].text),
    controls.map(event=>event.message.content[0].text));
  stage.commit();assert.equal(source.current.controlThrough,64);
});

test('native controls split observation without splitting the captured Fact page',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();t.after(()=>ctx.fiber.dispose());
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  const baseline={model:{deployment:'native',model:'configured'},reasoning_effort:'high'};
  const facts=[
    {type:'message_turn_accepted',turn_id:'one'},
    {type:'step_started',turn_id:'one',step_id:'step'},
    {type:'input_message_claimed',turn_id:'one',step_id:'step',source:{type:'human',message_id:'input'},content:[{type:'text',text:'original'}]},
    {type:'step_inputs_prepared',turn_id:'one',step_id:'step',decision:{kind:'enter',messages:[{kind:'claimed',claim:{fact_seq:3,ordinal:0}}]}},
    {type:'step_ended',turn_id:'one',step_id:'step'},
    {type:'turn_terminal',turn_id:'one',outcome:{status:'completed'}},
  ].map((fact,i)=>({...fact,seq:i+1,timestamp_ms:100+i}));
  const controls=[1,3,5].map((after_fact_seq,i)=>({kind:'model',seq:i+1,after_fact_seq,time:i+1,
    selection:{...baseline,reasoning_effort:i===1?'low':'high'}}));
  const requests=[],entered=new Set(),gate=Promise.withResolvers();
  const call=async op=>{
    entered.add(op.type);await gate.promise;
    if(op.type==='controls')return historyPage([controls[op.after_seq]],op.after_seq+1,op.offset);
    assert.equal(op.type,'fact');requests.push([op.after_seq,op.through_seq]);
    const json=JSON.stringify(facts.slice(op.after_seq,op.through_seq)),bytes=Buffer.byteLength(json);
    return {through_seq:op.through_seq,offset:0,next_offset:bytes,total_bytes:bytes,json};
  };
  const source=await workbenchSource({ctx,api,llm:await load('dsh-llm'),header:{version:4,id:'one',createdAt:1,isSeeded:false},
    meta:{model_baseline:baseline,selection_cursor:{kind:'durable',fact_seq:6,control_seq:3}},call});
  const staging=source.stage(call,async()=>{},undefined,6,3);
  try {
    await setImmediate();
    assert.deepEqual([...entered].sort(),['controls','fact'],'independent captured pages must start together');
    assert.equal(source.current.session.seq,0);
  } finally {gate.resolve();await staging;}
  const staged=await staging;
  assert.equal(source.current.session.seq,0,'staging must not expose even a fully decoded page');
  assert.deepEqual(staged.value.session.snapshotEvents().map(event=>event.type),[
    'turn/start','model/selection','model/selection','step/start','system/message','user/message','step/end','model/selection','turn/end',
  ]);
  assert.deepEqual(requests,[[0,6]],'all anchors share the same bounded captured page');
  staged.commit();assert.equal(source.current.mapping.factCursor,6);assert.equal(source.current.controlThrough,3);
  for(const mode of ['complete','partial','advanced'])await t.test(mode+' first capture',async()=>{
    const calls=[],read=async op=>{
      calls.push([op.type,op.after_seq,op.through_seq]);
      return historyPage((op.type==='fact'?facts:controls).slice(op.after_seq,op.through_seq),op.through_seq,op.offset);
    };
    const fresh=await workbenchSource({ctx,api,llm:await load('dsh-llm'),header:source.current.session.header,
      meta:{model_baseline:baseline,selection_cursor:{kind:'durable',fact_seq:6,control_seq:3}},call:read});
    const first={after:{fact_seq:0,control_seq:0},cut:{fact_seq:6,control_seq:3},
      facts:{through:mode==='partial'?2:6,value:mode==='partial'?facts.slice(0,2):facts},
      controls:{through:mode==='partial'?1:3,events:mode==='partial'?controls.slice(0,1):controls}};
    if(mode==='advanced'){
      const prefix=await fresh.stage(read,async()=>{},undefined,2,1,new Set(),0,{
        ...first,cut:{fact_seq:2,control_seq:1},facts:{through:2,value:facts.slice(0,2)},
        controls:{through:1,events:controls.slice(0,1)},
      });
      prefix.commit();assert.equal(calls.length,0);
    }
    const result=await fresh.stage(read,async()=>{},undefined,6,3,new Set(),0,first);
    assert.deepEqual(result.value.session.snapshotEvents(),source.current.session.snapshotEvents());
    if(mode==='complete')assert.deepEqual(calls,[],'captured bodies need no additional reads');
    else assert.deepEqual(calls.sort(),[['controls',1,3],['fact',2,6]],
      'partial or obsolete first pages resume at the current positions');
    result.commit();assert.equal(fresh.current.mapping.factCursor,6);assert.equal(fresh.current.controlThrough,3);
  });
});

test('a failed captured page drains its sibling before rejecting the unpublished stage',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();t.after(()=>ctx.fiber.dispose());
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  for(const failed of ['controls','fact']) {
    const pending=Promise.withResolvers(),entered=[],closed=[];
    const error=Error('failed '+failed);
    const call=async op=>{
      entered.push(op.type);
      if(op.type===failed)throw error;
      await pending.promise;return historyPage([],1,op.offset);
    };
    const source=await workbenchSource({ctx,api,header:{version:4,id:'failed-'+failed,createdAt:1,isSeeded:false},
      meta:{model_selection:{model:{deployment:'native',model:'configured'}}},call});
    let settled=false;
    const staging=source.stage(call,async op=>closed.push(op),undefined,1,1)
      .finally(()=>{settled=true;});
    const rejected=assert.rejects(staging,value=>value===error);
    try {
      await setImmediate();
      assert.deepEqual(entered.sort(),['controls','fact']);
      assert.equal(settled,false,'failure must not leave a sibling read running');
      assert.equal(source.current.session.seq,0);
    } finally {pending.resolve();await rejected;}
    assert.equal(source.current.mapping.factCursor,0);assert.equal(source.current.controlThrough,0);
    assert.equal(closed.length,1);assert.equal(closed[0].type,'page_close');
  }
});

test('passive projection readiness performs no native read even before the Session exists',async()=>{
  const history=workbenchHistory({read(){throw Error('Native history read');}});
  const stream=history.observeProjections({sessionId:'future'},new AbortController().signal);
  assert.deepEqual((await stream.next()).value,{type:'ready'});
  await stream.return();await history.close();
});
test('control-only choices reach host-wide projections and replay at identical event cursors despite clock rollback',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();t.after(()=>ctx.fiber.dispose());
  await ctx.plugin((await load('dsh-session-projection')).default);
  const {z}=require('zod');
  await ctx.sessionProjections.register({key:'selectedEffort',stateVersion:1,stateSchema:z.string(),init:()=>'',
    apply:(prior,event)=>event.type==='model/selection'?event.data.reasoningEffort:prior,
    wire:{viewSchema:z.string(),view:value=>value}});
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  const baseline={model:{deployment:'native',model:'configured'},reasoning_effort:'high'};
  const chosen={...baseline,reasoning_effort:'low'};
  const facts=[{type:'message_turn_accepted',turn_id:'one'},
    {type:'step_started',turn_id:'one',step_id:'step-one'},
    {type:'input_message_claimed',turn_id:'one',step_id:'step-one',source:{type:'human',message_id:'key'},content:[{type:'text',text:'before choice'}]},
    {type:'step_inputs_prepared',turn_id:'one',step_id:'step-one',decision:{kind:'enter',messages:[{kind:'claimed',claim:{fact_seq:3,ordinal:0}}]}}]
    .map((fact,i)=>({...fact,seq:i+1,timestamp_ms:1000+i}));
  let control=1,waiter=Promise.withResolvers(),factReads=0;
  const events=[{kind:'model',seq:1,after_fact_seq:0,time:999,selection:baseline},
    {kind:'model',seq:2,after_fact_seq:4,time:1,selection:chosen},
    {kind:'model',seq:3,after_fact_seq:4,time:2,selection:baseline}];
  const controller=workbenchHistory({ctx,api,llm:await load('dsh-llm'),authorize:async()=>{},async read(id,op){
    if(op.type==='open')return {id,created_at:900,through:4,inherited:false,model_baseline:baseline,
      model_selection:baseline,selection_cursor:{kind:'durable',fact_seq:4,control_seq:control}};
    if(op.type==='wait')return waiter.promise;
    if(op.type==='controls'){
      const through=Math.min(op.after_seq+1,op.through_seq);
      return historyPage(events.filter(event=>event.seq===through),through,op.offset);
    }
    assert.equal(op.type,'fact');
    assert.equal(op.through_seq,4);factReads++;
    const json=JSON.stringify(facts.slice(op.after_seq,op.through_seq)),bytes=Buffer.byteLength(json);
    return {through_seq:op.through_seq,offset:0,next_offset:bytes,total_bytes:bytes,json};
  }});
  const life=new AbortController(),request={address:{kind:'session',sessionId:'shared'},maxMessages:50};
  const reads=t.mock.method(ctx.sessionProjections,'snapshot');
  const flow=controller.follow(request,life.signal),snapshot=(await flow.next()).value;
  assert.equal(factReads,1,'one captured page projects all four native Facts');
  assert.equal(reads.mock.callCount(),1,'one projection read for the first history and control baseline');
  const global=controller.control(life.signal);
  assert.equal((await global.next()).value.value.projections.shared.asOfSeq,snapshot.cursor);
  const local=controller.observeProjections({sessionId:'shared'},life.signal);
  assert.deepEqual((await local.next()).value,{type:'ready'});
  assert.equal(reads.mock.callCount(),1,'a passive subscriber reuses the producer without reading a projection baseline');
  const localNext=local.next(),next=flow.next();control=3;waiter.resolve({fact_seq:4,control_seq:control});waiter=Promise.withResolvers();
  const change=(await next).value.event;
  assert.equal(change.type,'model/selection');assert.equal(change.time,1);
  assert.equal(change.seq,snapshot.cursor+1);assert.equal(change.data.reasoningEffort,'low');
  const final=(await flow.next()).value.event;
  for(const [event,delivery] of [[change,localNext],[final,undefined]]){
    const expected={type:'projection',seq:event.seq,changes:[{key:'selectedEffort',val:event.data.reasoningEffort},
      {key:'modelSelection',val:{lastUsed:null,next:event.data}}]};
    assert.deepEqual((await (delivery??local.next())).value,expected);
    assert.deepEqual((await global.next()).value,{...expected,sessionId:'shared'});
  }
  const reload=controller.follow(request,life.signal),reopened=(await reload.next()).value;
  assert.equal(reopened.cursor,final.seq);assert.equal(reopened.projections.asOfSeq,final.seq);
  assert.deepEqual(reopened.records.map(row=>row.event),[...snapshot.records.map(row=>row.event),change,final]);
  life.abort();await local.return();await global.return();await flow.return();await reload.return();
});

test('returning an idle history follower cancels its wait while the parent request stays usable',async()=>{
  let waitSignal;
  const parent=new AbortController();
  const view={session:{seq:0},mapping:{},through:0,wait(_cursor,_after,signal){
    waitSignal=signal;
    return new Promise((_,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }};
  const flow=followAssistant(view,{},parent.signal,()=>({type:'snapshot'}));
  assert.deepEqual((await flow.next()).value,{type:'snapshot'});
  await flow.return();
  assert.equal(waitSignal?.aborted,true);assert.equal(parent.signal.aborted,false);
});
test('reconnect opens inside a real prefix, emits dense subsequent chunks and closes at the committed event',{skip:!root},async()=>{
  const require=createRequire(join(root,'package.json')),llm=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
  let subscriptions=0;
  class IdleRead extends Promise {
    then(...args){subscriptions++;return super.then(...args);}
  }
  const durable=IdleRead.withResolvers(),remaining=Promise.withResolvers();
  const compact=new llm.AssistantStreamAccumulator();
  for(const [time,chunk] of [[1001,{type:'block-start',index:0,blockType:'text'}],
    [1002,{type:'text-delta',index:0,text:'prefix'}],[1003,{type:'text-delta',index:0,text:' tail'}],
    [1004,{type:'text-delta',index:0,text:' final'}]])compact.push({time,chunk});
  const event={seq:4,type:'assistant/message',data:{stream:compact.snapshot()}},
    stepEnd={seq:5,type:'step/end',data:{turn:1,step:1}},
    session={seq:4,snapshotEvents:()=>[event,stepEnd],eventAt:()=>event};
  const mapping={turn:1,step:1,model:{effectId:'effect-1',startedAt:1000,startedAfterSeq:3}};
  let reads=0,closed;
  const page=events=>{const json=JSON.stringify(events);return {json,offset:0,next_offset:Buffer.byteLength(json),
    total_bytes:Buffer.byteLength(json),revision:reads,complete:true,status:{state:'streaming'}};};
  const view={session,mapping,through:10,async advance(){mapping.model=null;
    return {kind:'committed',eventType:event.type,seq:event.seq};},
  call(op){
    if(op.type==='wait')return durable.promise;
    if(op.type==='model_open'){assert.equal(op.effect,'effect-1');return Promise.resolve();}
    assert.equal(op.type,'model_next');
    if(++reads===1)return Promise.resolve(page([[1,{type:'content_started',index:0,content:{type:'text'}}],
      [2,{type:'content_delta',index:0,delta:{type:'text',value:'prefix'}}]]));
    if(reads===2)return remaining.promise;
    return new Promise(()=>{});
  },releaseModel(key){closed=key;}};
  const life=new AbortController(),flow=followAssistant(view,llm,life.signal,assistantStream=>({type:'snapshot',assistantStream}));
  const opening=(await flow.next()).value.assistantStream;
  assert.equal(opening.revision,3);assert.equal(opening.activeAttempt.nextIndex,2);
  assert.ok(JSON.stringify(opening.activeAttempt.stream).includes('prefix'));
  remaining.resolve(page([[3,{type:'content_delta',index:0,delta:{type:'text',value:' tail'}}]]));
  const chunk=(await flow.next()).value.frame;
  assert.equal(chunk.index,2);assert.equal(chunk.revision,4);assert.equal(chunk.chunk.text,' tail');
  assert.equal(subscriptions,1,'model chunks share a single durable subscription');
  durable.resolve({control_seq:1,fact_seq:11});
  const final=(await flow.next()).value.frame;assert.equal(final.index,3);assert.equal(final.chunk.text,' final');
  assert.deepEqual((await flow.next()).value,{type:'event',event});
  assert.deepEqual((await flow.next()).value.frame.outcome,{kind:'committed',eventType:'assistant/message',seq:4});
  assert.deepEqual((await flow.next()).value,{type:'event',event:stepEnd});
  await flow.return();assert.ok(closed);
});
test('released Session surface projects paged snapshots and follows only events after the captured cut',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();
  t.after(()=>ctx.fiber.dispose());
  await ctx.plugin((await load('dsh-session-projection')).default);
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  const facts=[
    {type:'message_turn_accepted',turn_id:'one'},
    {type:'step_started',turn_id:'one',step_id:'step-one'},
    {type:'input_message_claimed',turn_id:'one',step_id:'step-one',source:{type:'human',message_id:'client-key'},content:[{type:'text',text:'stored words'}]},
    {type:'step_inputs_prepared',turn_id:'one',step_id:'step-one',decision:{kind:'enter',messages:[{kind:'claimed',claim:{fact_seq:3,ordinal:0}}]}},
    {type:'step_ended',turn_id:'one',step_id:'step-one'},
    {type:'turn_terminal',turn_id:'one',outcome:{status:'completed'}},
  ].map((fact,index)=>({...fact,seq:index+1,timestamp_ms:1000+index}));
  let through=4;
  const controller=workbenchHistory({ctx,api,llm:await load('dsh-llm'),async read(id,op){
    assert.equal(id,'native-session');
    if(op.type==='open')return {id,created_at:900,through,inherited:false,
      model_selection:{model:{deployment:'native',model:'configured'}}};
    if(op.type==='wait'){assert.equal(op.cursor.fact_seq,4);return {fact_seq:6,control_seq:2};}
    if(op.type==='controls')return historyPage([],op.through_seq,op.offset);
    assert.equal(op.type,'fact');
    const fact=facts[op.after_seq],data=JSON.stringify([fact]);
    return {through_seq:fact.seq,offset:0,next_offset:Buffer.byteLength(data),total_bytes:Buffer.byteLength(data),json:data};
  }});
  const signal=new AbortController(),request={address:{kind:'session',sessionId:'native-session'},maxMessages:1};
  const stream=controller.follow({...request,assistantStream:true},signal.signal);
  const {value:snapshot}=await stream.next();
  assert.equal(snapshot.type,'snapshot');
  assert.deepEqual(snapshot.assistantStream,{revision:0});
  assert.equal(snapshot.records.length,1);
  assert.equal(snapshot.records[0].event.data.content[0].text,'stored words');
  assert.equal(snapshot.records[0].event.data.source.rpcId,'client-key');
  assert.equal(snapshot.hasMore,true);
  assert.equal(snapshot.projections.asOfSeq,snapshot.cursor);
  const projections=await controller.projections({sessionId:'native-session'},signal.signal);
  assert.equal(projections.kind,'sequenced');assert.equal(projections.asOfSeq,snapshot.cursor);
  assert.deepEqual(projections.values.subagentCatalog,[]);
  assert.deepEqual(projections.values.modelSelection,{lastUsed:null,next:{provider:'native',model:'configured'}});
  const changes=controller.observeProjections({sessionId:'native-session'},signal.signal);
  assert.deepEqual((await changes.next()).value,{type:'ready'});await changes.return();
  const page=await controller.page({...request,throughSeq:snapshot.cursor,beforeSeq:snapshot.cursor},signal.signal);
  assert.equal(page.cursor,snapshot.cursor);
  const latest=await controller.page(request,signal.signal);
  assert.equal(latest.cursor,snapshot.cursor);
  assert.deepEqual(latest.records,snapshot.records);
  assert.deepEqual(await controller.page({...request,throughSeq:-1},signal.signal),{cursor:-1,records:[],hasMore:false});
  assert.ok(page.records.some(row=>row.event.type==='turn/start'));
  assert.equal((await stream.next()).value.event.seq,snapshot.cursor+1);
  assert.equal((await stream.next()).value.event.type,'turn/end');
  signal.abort();await stream.return();
  await assert.rejects(controller.page({...request,address:{kind:'subagent'}},signal.signal),/parent authority/);
  const forkSignal=new AbortController().signal;
  through=6;
  const source={sessionId:'native-session'};
  assert.equal(await controller.forkTurn(source,forkSignal),'one');
  const {asOfSeq}=await controller.projections(source,forkSignal);
  assert.equal(await controller.forkTurn({...source,atSeq:asOfSeq},forkSignal),'one');
  await assert.rejects(controller.forkTurn({...source,atSeq:asOfSeq-1},forkSignal),/interrupted-history/);
});
