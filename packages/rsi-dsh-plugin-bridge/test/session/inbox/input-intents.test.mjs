import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {nativeInboxFixture,message,contextIntent} from '../../fixtures/native-inbox-fixture.mjs';
import {workbenchHistory} from '../../../src/workbench/history.mjs';
import {readJournalDocument} from '../../../src/session/journal-document.mjs';
import {randomUUID} from 'node:crypto';

const enabled={skip:!process.env.RSI_DSH_MARKET_COHORT||!process.env.RSI_DSH_INBOX_SOURCE,timeout:15000};
const commands=f=>f.calls.filter(row=>row.method==='application.command'&&row.op.type==='execute');
const removals=f=>f.calls.filter(row=>row.method==='application.inbox'&&['mutate','discard_draft'].includes(row.op.type));
const submitted=f=>f.calls.filter(row=>row.method==='application.submit');
const until=async predicate=>{for(let n=0;!predicate();n++){assert.ok(n<2000);await setImmediate();}};
const statuses=f=>f.calls.filter(row=>row.method==='application.inbox'&&row.op.type==='message_status');

// Recovery fixtures represent already prepared commands, never new Agent input.
async function legacyInject(f,message) {
  const journal=f.owner.journal,id=randomUUID(),revision=f.state.kind==='draft'?{kind:'draft',revision:f.state.revision}:{kind:'durable',control_seq:f.state.control};
  const event=journal.accept(id,'agent/inbox/spliced',{target:'next-step',start:f.agent.inbox.nextStep.length,inserted:[message]});
  journal.prepare(id,contextIntent('native-context',revision,id,event));
  await f.owner.input.ready();
}

for(const method of ['inject','followup'])test(`${method} transfers a large durable input body to native acceptance across cold receipt recovery`,enabled,async t=>{
  const f=await nativeInboxFixture(t),text='unique-input-body-'+ '字'.repeat(100_000),original=message('large-input',text);
  f.state.holdSubmissions=true;f.state.failSubmit='after';
  f.state.submitGate=Promise.withResolvers();
  const loss=assert.rejects(f.scope.runOwned(()=>f.agent[method](original)),/reply lost/);
  await until(()=>submitted(f).length===1);
  const saved=f.documents.get('one');
  assert.equal(saved.split(text).length-1,1,'the accepted event is the only durable input body');
  assert.equal(JSON.stringify(f.owner.journal.operations()).includes(text),false,'recovery metadata retains no body');
  t.diagnostic(JSON.stringify({method,inputTextBytes:Buffer.byteLength(text),journalBytes:Buffer.byteLength(saved),
    operationBytes:Buffer.byteLength(JSON.stringify(f.owner.journal.operations()))}));
  f.state.submitGate.resolve();await loss;
  const previous=submitted(f)[0].args;
  f.state.failExecute=undefined;f.state.failSubmit=undefined;
  const reopened=workbenchHistory(f.options);t.after(()=>reopened.close());
  const session=await reopened.capture('one',await reopened.metadata('one')),owner=reopened.owner(session);
  await f.scope.runOwned(()=>owner.input.ready());
  assert.equal(submitted(f).length,1,'recover the receipt without resending');
  assert.equal(f.calls.filter(row=>row.method==='application.command').length,0,'input requires no command lookup or execution');
  assert.equal(previous.delivery,method==='inject'?'next_step':'next_turn');
  assert.deepEqual(owner.input.snapshot()[method==='inject'?'next-step':'next-turn'],[original]);
  assert.deepEqual(submitted(f)[0].args,previous);
  const correlated=f.documents.get('one');
  assert.equal(correlated.includes(text),false,'verified native acceptance owns the durable body');
  assert.ok(Buffer.byteLength(correlated)<4096);
  assert.deepEqual(session.eventAt(0),f.agent.session.eventAt(0),'retain original acceptance time and coordinates');
  const again=workbenchHistory(f.options);t.after(()=>again.close());
  const reloaded=await again.capture('one',await again.metadata('one'));
  assert.deepEqual(reloaded.snapshotEvents(),session.snapshotEvents());
  t.diagnostic(JSON.stringify({method,correlatedBytes:Buffer.byteLength(correlated)}));
});

for(const method of ['inject','followup'])test(`${method} validates and rewrites the previous input document without changing its request or event`,enabled,async t=>{
  const f=await nativeInboxFixture(t),original=message('previous-input');
  f.state.holdSubmissions=true;f.state[method==='inject'?'failExecute':'failSubmit']='after';
  await assert.rejects(f.scope.runOwned(()=>method==='inject'?legacyInject(f,original):f.agent.followup(original)),/reply lost/);
  const legacy=JSON.parse(f.documents.get('one')),operation=legacy.operations[0];legacy.version=2;
  legacy.events=legacy.events.map(event=>structuredClone(f.agent.session.eventAt(event.seq)));
  if(method==='inject')operation.invocation=commands(f)[0].op.invocation;
  else {
    const {message_id,delivery,content,attribution}=submitted(f)[0].args;
    operation.invocation={kind:'submission',message_id,delivery,content,attribution};
    const wrongDelivery=structuredClone(legacy);wrongDelivery.operations[0].invocation.delivery='steer';
    assert.throws(()=>readJournalDocument(JSON.stringify(wrongDelivery)),/disagrees with its accepted message/);
  }
  const corrupt=structuredClone(legacy),invocation=corrupt.operations[0].invocation;
  (method==='inject'?invocation.arguments.content:invocation.content)[0].text='changed';
  f.documents.set('one',JSON.stringify(corrupt));
  const bad=workbenchHistory(f.options);t.after(()=>bad.close());
  await assert.rejects(bad.capture('one',await bad.metadata('one')),/disagrees with its accepted message/);
  assert.deepEqual(JSON.parse(f.documents.get('one')),corrupt,'failed upgrade never rewrites a document');
  f.documents.set('one',JSON.stringify(legacy));f.state.failExecute=undefined;f.state.failSubmit=undefined;
  const good=workbenchHistory(f.options);t.after(()=>good.close());
  const session=await good.capture('one',await good.metadata('one')),owner=good.owner(session);
  assert.deepEqual(session.eventAt(operation.seq),legacy.events.find(event=>event.seq===operation.seq));
  await f.scope.runOwned(()=>owner.input.ready());
  const stored=JSON.parse(f.documents.get('one'));
  assert.equal(stored.version,5);assert.equal(JSON.stringify(stored.operations).includes('previous-input'),false);
  assert.equal((method==='inject'?commands(f):submitted(f)).length,1);
  const changed=structuredClone(stored);
  if(method==='inject')changed.operations[0].invocation.sha256='b'.repeat(64);
  else changed.operations[0].invocation.content=original.content;
  f.documents.set('one',JSON.stringify(changed));
  const invalid=workbenchHistory(f.options);t.after(()=>invalid.close());
  await assert.rejects(invalid.capture('one',await invalid.metadata('one')),/Retained input invocation|retained submission descriptor/);
});

async function cold(t,f) {
  const history=workbenchHistory(f.options);t.after(()=>history.close());
  const session=await history.capture('one',await history.metadata('one'));
  assert.deepEqual(session.snapshotEvents(),f.agent.session.snapshotEvents());
  assert.deepEqual(history.owner(session).input.snapshot(),f.projection());
}

test('waking file input survives a lost reply and cold recovery without resubmission or file bytes',enabled,async t=>{
  const f=await nativeInboxFixture(t),file={type:'file',attachment:{attachmentId:'sha256:'+'b'.repeat(64),name:'input.txt',bytes:8_000_000_000}};
  const original={...message('file-original'),content:[file]},expected=structuredClone(original);
  f.state.holdSubmissions=true;f.state.failSubmit='after';
  await assert.rejects(f.scope.runOwned(()=>f.agent.followup(original)),/submission reply lost/);
  original.content[0].attachment.name='mutated.txt';
  assert.deepEqual(submitted(f)[0].args.content,[{kind:'file',file:{id:'b'.repeat(64),name:'input.txt',bytes:8_000_000_000}}]);
  f.state.failSubmit=undefined;
  const reopened=workbenchHistory(f.options);t.after(()=>reopened.close());
  const session=await reopened.capture('one',await reopened.metadata('one')),owner=reopened.owner(session);
  await f.scope.runOwned(()=>owner.input.ready());
  assert.equal(submitted(f).length,1);assert.deepEqual(owner.input.snapshot()['next-turn'],[expected]);
  assert.ok(Buffer.byteLength(JSON.stringify(submitted(f)[0].args))<1024);
});

for(const kind of ['draft','durable'])test(`${kind} file and image injection retains message blocks across reply loss and cold recovery without waking`,enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind});
  const original={...message('file-injection'),content:[
    {type:'text',text:'before'},
    {type:'file',attachment:{attachmentId:'sha256:'+'c'.repeat(64),name:'context.txt',bytes:9_000_000_000}},
    {type:'image',attachment:{attachmentId:'sha256:'+'d'.repeat(64),mediaType:'image/webp',bytes:90,width:64,height:48,name:'preview.webp',originalDimensions:{width:1024,height:768}}},
    {type:'text',text:'after'},
  ]},expected=structuredClone(original);
  f.state.failSubmit='after';
  await assert.rejects(f.scope.runOwned(()=>f.agent.inject(original)),/submission reply lost/);
  original.content[1].attachment.name='mutated.txt';
  assert.deepEqual(submitted(f)[0].args.content,[
    {kind:'text',text:'before'},
    {kind:'file',file:{id:'c'.repeat(64),name:'context.txt',bytes:9_000_000_000}},
    {kind:'image',media:{id:'d'.repeat(64),mime:'image/webp',bytes:90,width:64,height:48},presentation:{name:'preview.webp',original_dimensions:{width:1024,height:768}}},
    {kind:'text',text:'after'},
  ]);
  f.state.failSubmit=undefined;
  const reopened=workbenchHistory(f.options);t.after(()=>reopened.close());
  const session=await reopened.capture('one',await reopened.metadata('one')),owner=reopened.owner(session);
  await f.scope.runOwned(()=>owner.input.ready());
  assert.equal(commands(f).length,0);assert.equal(submitted(f).length,1);
  assert.deepEqual(owner.input.snapshot()['next-step'],[expected]);
  assert.ok(Buffer.byteLength(JSON.stringify(submitted(f)[0].args))<1024);
  await cold(t,f);
});

test('waking inputs capture their original envelope and reuse its presentation ID with distinct native identities',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'draft'}),original=message('原始 id'),expected=structuredClone(original);
  await f.scope.runOwned(()=>{
    f.agent.followup(original);
    original.id='changed';original.source.tag.n=9;original.content[0].text='changed';
  });
  await f.scope.runOwned(()=>f.agent.steer(expected));
  const requests=submitted(f).map(row=>row.args);
  assert.equal(requests.length,2);assert.notEqual(requests[0].message_id,requests[1].message_id);
  assert.deepEqual(requests.map(row=>row.delivery),['next_turn','steer']);
  for(const request of requests) {
    assert.notEqual(request.message_id,expected.id);
    assert.deepEqual(request.attribution,{id:expected.id,source:expected.source});
    assert.deepEqual(request.content,expected.content.map(({text})=>({kind:'text',text})));
  }
});

for(const method of ['followup','steer'])for(const kind of ['draft','durable'])
test(`${kind} ${method} accepts synchronously, deduplicates pending IDs and correlates native claim across queue horizons`,enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind}),original=message('same'),expected=structuredClone(original),notices=[];
  const target=method==='steer'?'next-step':'next-turn';
  f.ctx.on('agent/inbox/inserted',value=>notices.push(value.message));
  f.state.submitGate=Promise.withResolvers();f.state.holdSubmissions=true;
  const publication=f.scope.runOwned(()=>{
    f.agent[method](original);
    assert.deepEqual(f.projection()[target],[expected]);assert.deepEqual(f.owner.input.snapshot()[target],[expected]);
    assert.equal(submitted(f).length,0);
    const through=f.agent.session.seq;
    assert.throws(()=>f.agent.followup(original),/already pending/);
    assert.throws(()=>f.agent.inject(original),/already pending/);
    assert.equal(f.agent.session.seq,through);
    original.content[0].text='changed';original.source.tag.n=2;
    assert.deepEqual(f.owner.input.snapshot()[target],[expected]);
  });
  await until(()=>submitted(f).length===1);f.state.submitGate.resolve();await publication;
  assert.deepEqual(f.projection()[target],[expected]);assert.equal(notices.length,1);
  assert.equal(f.state.pending[0].target,'next_turn','native idle steering resolves to next-turn');
  await cold(t,f);
  f.control({kind:'claimed',message_id:f.state.pending[0].message_id});f.state.pending=[];await f.refresh();
  assert.equal(f.agent.inbox.hasPending,false);assert.deepEqual(f.projection(),{'next-step':[],'next-turn':[]});
  await cold(t,f);
});

for(const method of ['followup','steer'])test(`${method} removed immediately or after failed flush never reaches native submission`,enabled,async t=>{
  const f=await nativeInboxFixture(t);
  await f.scope.runOwned(()=>{f.agent[method](message('immediate'));f.agent.inbox.clear();});
  assert.equal(submitted(f).length,0);assert.equal(statuses(f).length,0);
  f.state.failSave=true;
  await assert.rejects(f.scope.runOwned(()=>f.agent[method](message('failed-flush'))),/disk unavailable/);
  f.state.failSave=false;await f.scope.runOwned(()=>f.agent.inbox.remove('failed-flush'));
  assert.equal(submitted(f).length,0);assert.equal(statuses(f).length,0);assert.equal(removals(f).length,0);
  await cold(t,f);
});

for(const method of ['followup','steer'])test(`${method} withdrawal during dispatch retains its local removal and withdraws the exact accepted native input`,enabled,async t=>{
  const f=await nativeInboxFixture(t);f.state.submitGate=Promise.withResolvers();f.state.holdSubmissions=true;
  const sent=f.scope.runOwned(()=>f.agent[method](message('flight')));
  await until(()=>submitted(f).length===1);
  const removed=f.scope.runOwned(()=>f.agent.inbox.remove('flight'));
  assert.equal(f.agent.inbox.hasPending,false);f.state.submitGate.resolve();await Promise.all([sent,removed]);
  assert.equal(submitted(f).length,1);assert.equal(f.state.pending.length,0);assert.equal(removals(f).length,1);
  assert.equal(removals(f)[0].op.mutation.expected_message_id,submitted(f)[0].args.message_id);await cold(t,f);
});

for(const failure of ['before','after'])test(`cold recovery of a wanted submission with ${failure}-commit reply loss retains its exact identity`,enabled,async t=>{
  const f=await nativeInboxFixture(t);f.state.failSubmit=failure;f.state.holdSubmissions=true;
  await assert.rejects(f.scope.runOwned(()=>f.agent.followup(message('recover'))),/submission/);
  const first=submitted(f)[0].args;f.state.failSubmit=undefined;
  const reopened=workbenchHistory(f.options);t.after(()=>reopened.close());
  const session=await reopened.capture('one',await reopened.metadata('one')),owner=reopened.owner(session);
  await f.scope.runOwned(()=>owner.input.ready());
  assert.equal(submitted(f).length,failure==='before'?2:1);
  for(const row of submitted(f))assert.deepEqual(row.args,first);
  assert.equal(statuses(f).length,1);assert.equal(f.state.pending.length,1);
  assert.equal(owner.journal.operations()[0].receipt.kind,'submitted');
  assert.deepEqual(owner.input.snapshot()['next-turn'],[message('recover')]);
});

test('lost submission receipt is queried for withdrawal without replay, and absence remains unknown',enabled,async t=>{
  const f=await nativeInboxFixture(t);f.state.failSubmit='before';
  await assert.rejects(f.scope.runOwned(()=>f.agent.steer(message('uncertain'))),/submission outcome unknown/);
  await assert.rejects(f.scope.runOwned(()=>f.agent.inbox.remove('uncertain')),/withdrawal is unconfirmed/);
  assert.equal(f.agent.inbox.hasPending,false);assert.equal(submitted(f).length,1);assert.equal(removals(f).length,0);
  const reopened=workbenchHistory(f.options);t.after(()=>reopened.close());
  const session=await reopened.capture('one',await reopened.metadata('one'));
  await assert.rejects(f.scope.runOwned(()=>reopened.owner(session).input.ready()),/withdrawal is unconfirmed/);
  assert.equal(submitted(f).length,1);
});

test('a known accepted submission with a lost reply can be withdrawn by status and original acceptance',enabled,async t=>{
  const f=await nativeInboxFixture(t);f.state.failSubmit='after';f.state.holdSubmissions=true;
  await assert.rejects(f.scope.runOwned(()=>f.agent.steer(message('accepted'))),/submission reply lost/);
  await f.scope.runOwned(()=>f.agent.inbox.remove('accepted'));
  assert.equal(submitted(f).length,1);assert.equal(statuses(f).length,1);assert.equal(removals(f).length,1);
  assert.equal(f.state.pending.length,0);await cold(t,f);
});

test('a confirmed refusal withdraws the insertion before the producer retries',enabled,async t=>{
  const f=await nativeInboxFixture(t);f.state.failSubmit='rejected';
  await assert.rejects(f.scope.runOwned(()=>f.agent.followup(message('first'))),/mailbox refused/);
  assert.equal(f.owner.journal.operations()[0].receipt.kind,'rejected');
  assert.equal(f.agent.inbox.nextTurn.length,0);
  f.state.failSubmit=undefined;await cold(t,f);
  assert.equal(submitted(f).length,1);
  await f.scope.runOwned(()=>f.agent.followup(message('retry')));
  assert.equal(submitted(f).length,2);assert.equal(f.state.submissions.size,1);
});

test('recovering an existing receipt is independent of model readiness for a new submission',enabled,async t=>{
  const f=await nativeInboxFixture(t);f.state.failSubmit='after';f.state.holdSubmissions=true;
  await assert.rejects(f.scope.runOwned(()=>f.agent.followup(message('accepted'))),/submission reply lost/);
  f.owner.driver.ready=async()=>{throw Error('new model unavailable');};
  await f.scope.runOwned(()=>f.owner.input.ready());
  assert.equal(submitted(f).length,1);assert.equal(statuses(f).length,1);
  assert.equal(f.owner.journal.operations()[0].receipt.kind,'submitted');await cold(t,f);
});

test('a negative handler reply after durable acceptance keeps the original receipt',enabled,async t=>{
  const f=await nativeInboxFixture(t);f.state.failSubmit='committed-error';
  await f.scope.runOwned(()=>f.agent.followup(message('accepted')));
  assert.equal(f.owner.journal.operations()[0].receipt.kind,'submitted');
  assert.equal(submitted(f).length,1);assert.equal(statuses(f).length,1);
  await cold(t,f);
});

test('withdrawal during a recovery status lookup never turns an absent receipt into a new submission',enabled,async t=>{
  const f=await nativeInboxFixture(t);f.state.failSubmit='before';
  await assert.rejects(f.scope.runOwned(()=>f.agent.followup(message('race'))),/submission outcome unknown/);
  f.state.failSubmit=undefined;f.state.statusGate=Promise.withResolvers();
  const retry=f.scope.runOwned(()=>f.owner.input.ready());
  await until(()=>statuses(f).length===1);
  const removed=f.scope.runOwned(()=>f.agent.inbox.remove('race'));
  f.state.statusGate.resolve();
  await retry;await assert.rejects(removed,/withdrawal is unconfirmed/);
  assert.equal(submitted(f).length,1);assert.equal(removals(f).length,0);await cold(t,f);
});

test('active steering follows native promotion and cannot resurrect after local withdrawal',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable'});f.state.activeTurn=true;f.state.holdSubmissions=true;
  await f.scope.runOwned(()=>f.agent.steer(message('promote')));
  const id=f.state.pending[0].message_id;f.state.pending[0].target='next_turn';f.control({kind:'promoted',message_id:id});
  await f.refresh();assert.deepEqual(f.agent.inbox.nextStep,[]);assert.deepEqual(f.agent.inbox.nextTurn,[message('promote')]);
  await f.scope.runOwned(()=>f.agent.inbox.remove('promote'));await cold(t,f);
});

for(const kind of ['draft','durable'])test(`${kind} inject is synchronous, immutable and visible through original inbox and workbench projections`,enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind}),original=message('原始 id'),notices=[];
  f.ctx.on('agent/inbox/inserted',value=>notices.push(value.message));
  f.state.submitGate=Promise.withResolvers();const empty=f.agent.inbox.nextStep;
  const operation=f.scope.runOwned(()=>{
    f.agent.inject(original);
    assert.deepEqual(f.agent.inbox.nextStep,[original]);assert.deepEqual(f.projection()['next-step'],[original]);
    original.source.tag.n=2;original.content[1].text='mutated';
    assert.equal(f.agent.inbox.nextStep[0].content[1].text,'第二块');
    assert.equal(f.agent.inbox.nextStep[0].source.tag.n,1);assert.equal(empty.length,0);
  });
  await until(()=>submitted(f).length===1);assert.equal(f.state.pending.length,0);
  const life=new AbortController(),flow=f.history.follow({address:{kind:'session',sessionId:'one'}},life.signal);
  const first=(await flow.next()).value;
  assert.equal(first.projections.values.inbox['next-step'][0].id,'原始 id');life.abort();await flow.return();
  f.state.submitGate.resolve();await operation;
  assert.notEqual(submitted(f)[0].args.message_id,'原始 id');
  assert.deepEqual(submitted(f)[0].args.attribution,{id:'原始 id',source:{kind:'plugin:test',tag:{n:1}}});
  assert.equal(f.state.kind,'durable');assert.equal(f.snapshot().driver_active,false);
  assert.equal(notices.length,1);assert.ok(Object.isFrozen(notices[0]));
  const before=f.agent.session.seq;
  await assert.rejects(f.scope.runOwned(()=>f.agent.inject(message('原始 id'))),/already pending/);
  assert.equal(f.agent.session.seq,before);assert.equal(submitted(f).length,1);
  await cold(t,f);
});

test('inject followed immediately by remove never sends the withdrawn input',enabled,async t=>{
  const f=await nativeInboxFixture(t),notices=[];
  f.ctx.on('agent/inbox/inserted',()=>notices.push('inserted'));
  f.ctx.on('agent/inbox/discarded',()=>notices.push('discarded'));
  await f.scope.runOwned(()=>{
    f.agent.inject(message('cancel-now'));assert.equal(f.agent.inbox.remove('cancel-now'),true);
    assert.equal(f.agent.inbox.remove('cancel-now'),false);assert.equal(f.agent.inbox.hasPending,false);
    assert.deepEqual(f.projection(),{'next-step':[],'next-turn':[]});
  });
  assert.equal(submitted(f).length,0);assert.equal(removals(f).length,0);
  assert.deepEqual(notices,['inserted','discarded']);await cold(t,f);
});

test('removal during preparation flush prevents dispatch while retaining the accepted events',enabled,async t=>{
  const f=await nativeInboxFixture(t);f.state.saveGate=Promise.withResolvers();
  const injection=f.scope.runOwned(()=>f.agent.inject(message('prepared')));
  await until(()=>f.owner.journal.operations()[0]?.invocation);
  const removal=f.scope.runOwned(()=>f.agent.inbox.remove('prepared'));
  assert.equal(f.agent.inbox.hasPending,false);f.state.saveGate.resolve();
  await Promise.all([injection,removal]);assert.equal(submitted(f).length,0);assert.equal(removals(f).length,0);
  assert.equal(f.owner.journal.operations()[0].receipt.kind,'not-dispatched');await cold(t,f);
});

test('a preparation flush failure followed by removal does not invent an unknown native execution',enabled,async t=>{
  const f=await nativeInboxFixture(t);f.state.failSave=true;
  await assert.rejects(f.scope.runOwned(()=>f.agent.inject(message('disk-failure'))),/disk unavailable/);
  assert.equal(submitted(f).length,0);f.state.failSave=false;
  await f.scope.runOwned(()=>f.agent.inbox.remove('disk-failure'));
  assert.equal(submitted(f).length,0);assert.equal(removals(f).length,0);await cold(t,f);
});

test('removal during native admission waits for the actual message receipt and then withdraws that input',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable'});f.state.submitGate=Promise.withResolvers();
  const injection=f.scope.runOwned(()=>f.agent.inject(message('in-flight')));
  await until(()=>submitted(f).length===1);
  const removal=f.scope.runOwned(()=>f.agent.inbox.remove('in-flight'));
  assert.equal(f.agent.inbox.hasPending,false);f.state.submitGate.resolve();
  await Promise.all([injection,removal]);assert.equal(submitted(f).length,1);assert.equal(removals(f).length,1);
  assert.equal(f.state.pending.length,0);await cold(t,f);
});

for(const kind of ['draft','durable'])test(`${kind} lost input reply is queried before the next human submission, without a second execution`,enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind});f.state.failSubmit='after';
  await assert.rejects(f.scope.runOwned(()=>f.agent.inject(message('context'))),/reply lost/);
  assert.equal(submitted(f).length,1);assert.equal(f.state.pending.length,1);
  f.state.failSubmit=undefined;
  await f.scope.runOwned(()=>f.agent.followup(message('question')));
  assert.equal(commands(f).length,0);assert.equal(submitted(f).length,2);
  assert.equal(f.agent.inbox.hasPending,false);assert.deepEqual(f.projection(),{'next-step':[],'next-turn':[]});
  assert.equal(f.agent.session.snapshotEvents().filter(event=>event.data.inserted?.some(row=>row.id==='context')).length,1);
  await cold(t,f);
});

test('an unknown input outcome is never replayed to withdraw it or bypassed by a dependent prompt',enabled,async t=>{
  const f=await nativeInboxFixture(t);f.state.failSubmit='before';
  await assert.rejects(f.scope.runOwned(()=>f.agent.inject(message('uncertain'))),/outcome unknown/);
  await assert.rejects(f.scope.runOwned(()=>{
    assert.equal(f.agent.inbox.remove('uncertain'),true);assert.equal(f.agent.inbox.hasPending,false);
  }),/withdrawal is unconfirmed/);
  await assert.rejects(f.scope.runOwned(()=>f.agent.followup(message('blocked'))),/withdrawal is unconfirmed/);
  assert.equal(commands(f).length,0);assert.equal(submitted(f).length,1);assert.equal(removals(f).length,0);
  await cold(t,f);
});

for(const kind of ['draft','durable'])test(`${kind} removal is immediate and waits for native settlement; I/O retry retains the intent`,enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind});await f.scope.runOwned(()=>f.agent.inject(message('context')));
  f.state.failWithdraw='io';
  await assert.rejects(f.scope.runOwned(()=>{f.agent.inbox.remove('context');assert.equal(f.agent.inbox.hasPending,false);}),/storage unavailable/);
  assert.equal(f.state.pending.length,1);assert.equal(f.agent.inbox.hasPending,false,'accepted removal is not retracted on I/O failure');
  const first=removals(f)[0].op;f.state.failWithdraw=undefined;
  await f.scope.runOwned(()=>f.agent.followup(message('after-removal')));
  assert.deepEqual(removals(f)[1].op,first);assert.equal(f.state.pending.length,0);assert.equal(submitted(f).length,2);
  await cold(t,f);
});

test('native claim rejection settles the withdrawal truthfully and does not permanently block later input',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable'});await f.scope.runOwned(()=>f.agent.inject(message('claimed')));
  f.state.failWithdraw='claimed';await assert.rejects(f.scope.runOwned(()=>f.agent.inbox.remove('claimed')),/claimed/);
  assert.equal(f.agent.inbox.hasPending,false);
  await f.scope.runOwned(()=>f.agent.followup(message('later')));
  assert.equal(removals(f).length,1);assert.equal(submitted(f).length,2);await cold(t,f);
});

test('native held draft input enters the same journal and aliases its later durable acceptance',enabled,async t=>{
  const original=message('external-original'),native={message_id:'external-native',source:{type:'command',source:{attribution:{id:original.id,source:original.source}}},content:original.content};
  const f=await nativeInboxFixture(t,{pending:[{message_id:native.message_id,source_kind:'command',target:'next_step',message:native}]});
  assert.deepEqual(f.agent.inbox.nextStep,[original]);assert.deepEqual(f.projection()['next-step'],[original]);
  await f.scope.runOwned(()=>f.agent.followup(message('question')));
  assert.equal(f.agent.inbox.hasPending,false);assert.equal(commands(f).length,0);
  assert.equal(f.agent.session.snapshotEvents().filter(event=>event.data.inserted?.some(row=>row.id===original.id)).length,1);
  await cold(t,f);
});

for(const failure of ['publish','discard-then-publish'])test(`draft withdrawal reconciles ${failure} using the same native input identity`,enabled,async t=>{
  const f=await nativeInboxFixture(t);await f.scope.runOwned(()=>legacyInject(f,message('race')));
  f.state.failWithdraw=failure;await f.scope.runOwned(()=>f.agent.inbox.remove('race'));
  assert.equal(f.state.pending.length,0);assert.equal(f.agent.inbox.hasPending,false);
  const [draft,durable]=removals(f).map(row=>row.op);
  assert.equal(draft.message_ids[0],durable.mutation.expected_message_id);await cold(t,f);
});
