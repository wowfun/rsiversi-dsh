import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadCohort} from '../../../rsi-dsh-cordis/src/runtime/cohort.mjs';
import {SessionFacade} from '../../src/session/session.mjs';
import {SessionProjectionJournal} from '../../src/session/session-projection-journal.mjs';
import {readJournalDocument} from '../../src/session/journal-document.mjs';

const root=process.env.RSI_DSH_COHORT;
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
