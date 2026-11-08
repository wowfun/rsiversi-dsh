import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {loadCohort} from '../../../rsi-dsh-cordis/src/runtime/cohort.mjs';
import {SessionFacade,digest,remap} from '../../src/session/session.mjs';
import {SessionProjectionJournal} from '../../src/session/session-projection-journal.mjs';
import {readJournalDocument} from '../../src/session/journal-document.mjs';

const root=process.env.RSI_DSH_COHORT;
test('coordinate remaps retain exact UTF-8 size across integer widths without encoding shared bodies', {skip:!root},async t=>{
  const cohort=await loadCohort(root),ctx=new (await cohort.import('@deepseek-ai/cordis')).Context();
  t.after(()=>ctx.fiber.dispose());
  const api={...await cohort.import('@deepseek-ai/dsh-session'),
    ...await cohort.subpath('@deepseek-ai/dsh-session','surface'),...await cohort.import('@deepseek-ai/dsh-util-values')};
  const header={version:4,id:'coordinate-transfer',createdAt:1,isSeeded:false};
  const source=new SessionFacade(ctx,api,{header},false),target=new SessionFacade(ctx,api,{header},false);
  const message=(id,role)=>({id,role,source:{kind:role==='system'?'system-prompt':'user'},content:[{type:'text',text:'中文🙂\n"\\'}]});
  source.begin();target.begin();
  for(let i=0;i<90;i++){
    target.appendObserved('approval/policy',{policy:'ask'},1);
    if(i<9)source.appendObserved('approval/policy',{policy:'ask'},1);
  }
  source.appendObserved('system/message',{turn:0,step:0,message:message('old','system')},1,{surfaceOp:'append'});
  source.appendObserved('request/header',{reason:'initial',header:{config:{provider:'native',model:'chosen'},
    tools:[{name:'read',description:'Read',parameters:{type:'object',properties:{}}}]}},1);
  source.appendObserved('user/message',message('input','user'),1,{surfaceOp:'append'});
  source.appendObserved('developer/message',{turn:0,step:0,headerSeq:10,message:{...message('tools','developer'),
    content:[{type:'tool-addition',toolName:'read'}]}},1,{surfaceOp:'append'});
  source.appendObserved('command/run',{commandId:'cmd',name:'context',source:{kind:'user'}},1);
  source.appendObserved('command/done',{commandId:'cmd',kind:'success',sourceEventSeq:11},1);
  source.appendObserved('system/message',{turn:0,step:0,message:message('new','system')},1,
    {surfaceOp:{op:'replace',startSeq:9,endSeq:9},sourceEventSeqs:[9]});
  source.end();
  const events=source.snapshotEvents(),mapped=events.map(event=>remap(event,event.seq+90,seq=>({seq:seq+90})));
  for(const event of mapped){assert.ok(Object.isFrozen(event));assert.ok(Object.isFrozen(event.data));}
  assert.throws(()=>{mapped[12].data.headerSeq=0;},TypeError);
  const stringify=JSON.stringify;let encodings=0;
  JSON.stringify=function(value,...args){if(mapped.includes(value))encodings++;return stringify(value,...args);};
  try {
    for(const event of mapped)target.adoptObserved(event);
    assert.equal(encodings,0,'changing only coordinates must not re-encode the body for admission');
    for(const event of mapped){
      const expected=createHash('sha256').update(stringify(event)).digest('hex');
      assert.equal(digest(event),expected);assert.equal(digest(event),expected);
    }
    assert.equal(encodings,mapped.length,'each requested remapped digest is computed once');
  }finally{JSON.stringify=stringify;target.end();}
  assert.equal(target.encodedBytes,target.snapshotEvents().reduce((sum,event)=>sum+Buffer.byteLength(stringify(event)),0));
  for(const event of mapped){
    const restored=remap(event,event.seq-90,seq=>({seq:seq-90}));
    assert.deepEqual(restored,events[event.seq-90]);
  }
  const restored=new SessionFacade(ctx,api,{header,events:mapped.map(event=>remap(event,event.seq-90,seq=>({seq:seq-90}))),eventState:'shared-frozen'},false);
  assert.equal(restored.encodedBytes,source.encodedBytes,'shrinking coordinates preserves exact byte accounting');
  const empty=new SessionFacade(ctx,api,{header},false);empty.begin();
  assert.throws(()=>empty.adoptObserved(remap(events.at(-1),0,()=>({seq:0}))),/surface|replace|reference/i);
  empty.end();assert.equal(empty.seq,0,'derived size evidence cannot bypass receiving surface validation');
});
test('unchanged admitted events retain identity through native merge and cold reconstruction', {skip:!root}, async t=>{
  const cohort=await loadCohort(root),ctx=new (await cohort.import('@deepseek-ai/cordis')).Context();
  t.after(()=>ctx.fiber.dispose());
  const api={...await cohort.import('@deepseek-ai/dsh-session'),
    ...await cohort.subpath('@deepseek-ai/dsh-session','surface'),...await cohort.import('@deepseek-ai/dsh-util-values')};
  const header={version:4,id:'event-transfer',createdAt:1,isSeeded:false};
  const source=new SessionFacade(ctx,api,{header},false);
  let admissions=0;const adopt=api.adoptSessionEvent;
  api.adoptSessionEvent=event=>{admissions++;return adopt(event);};
  source.begin();
  const message=text=>({id:text,role:'system',source:{kind:'system-prompt'},content:[{type:'text',text}]});
  source.appendObserved('system/message',{turn:0,step:0,message:message('initial')},1,{surfaceOp:'append'});
  source.appendObserved('system/message',{turn:0,step:0,message:message('replacement')},2,
    {surfaceOp:{op:'replace',startSeq:0,endSeq:0},sourceEventSeqs:[0]});
  source.end();
  const events=source.snapshotEvents(),journal=new SessionProjectionJournal(ctx,api,{header},{nativeEventState:'shared-frozen'});
  journal.merge(events);
  for(const event of events)assert.equal(journal.session.eventAt(event.seq),event,'unchanged envelopes and references must remain shared');
  assert.equal(journal.session.encodedBytes,source.encodedBytes);
  assert.equal(admissions,events.length,'receiving the same immutable events must not repeat event-local validation');
  const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(journal.encode()),native:events,nativeEventState:'shared-frozen'});
  cold.merge(events);
  assert.equal(cold.encode(),journal.encode());
  assert.equal(cold.session.encodedBytes,events.reduce((bytes,event)=>bytes+Buffer.byteLength(JSON.stringify(event)),0));
  for(const event of events)assert.equal(cold.session.eventAt(event.seq),event);
  assert.equal(admissions,events.length);

  // The same immutable event remains invalid against a different receiving prefix.
  const target=new SessionFacade(ctx,api,{header},false);
  target.begin();
  assert.throws(()=>target.adoptObserved(events[1]),/envelope/);
  target.appendObserved('approval/policy',{policy:'ask'},1);
  assert.throws(()=>target.adoptObserved(events[1]),/surface|replace/i);
  target.end();assert.equal(target.seq,1);

  // Admission evidence belongs to the validator that actually checked the event.
  const other=new SessionFacade(ctx,{...api,adoptSessionEvent(){throw Error('different validator');}},{header},false);
  other.begin();assert.throws(()=>other.adoptObserved(events[0]),/different validator/);other.end();
  assert.equal(other.seq,0);
  const external=new SessionFacade(ctx,api,{header},false);
  const invalid=Object.freeze({...events[0],data:{...events[0].data,message:{...events[0].data.message,role:'assistant'}}});
  external.begin();assert.throws(()=>external.adoptObserved(invalid),/role|system/i);external.end();
  assert.equal(external.seq,0,'a frozen external envelope cannot bypass event validation');
  assert.equal(events[1].surfaceOp.startSeq,0);
  assert.throws(()=>{events[0].data.message.content[0].text='mutation';},TypeError);
});
