import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {workbenchHistory} from '../../src/workbench/history.mjs';
import {workbenchPersistence} from '../../src/workbench/persistence.mjs';
import {sessionJournalStore} from '../../src/session/session-journal-store.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {workbenchAgents} from '../../src/workbench/agents.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
const base={provider:'native',model:'configured',reasoningEffort:'low'};
const native=value=>({model:{deployment:value.provider,model:value.model},reasoning_effort:value.reasoningEffort});
async function fixture(t) {
  const require=createRequire(join(root,'package.json')),load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();t.after(()=>ctx.fiber.dispose());
  await ctx.plugin((await load('dsh-session-projection')).default);
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  const directory=await mkdtemp(join(tmpdir(),'rsi-workbench-owner-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const storage=sessionJournalStore(directory,await load('dsh-atomic-write'));
  const controls=[{kind:'model',seq:1,after_fact_seq:0,time:1,selection:native(base)}],waiting=new Set();
  let reads=0;const hooks={};
  const cursor=()=>({fact_seq:0,control_seq:controls.at(-1).seq});
  const meta=()=>({id:'one',created_at:1,inherited:false,through:0,model_baseline:native(base),
    model_selection:controls.at(-1).selection,selection_cursor:{kind:'durable',...cursor()}});
  const change=value=>{
    controls.push({kind:'model',seq:controls.at(-1).seq+1,after_fact_seq:0,time:controls.length+1,...value});
    for(const notify of waiting)notify();
  };
  const read=async(id,operation,signal)=>{
    assert.equal(id,'one');signal?.throwIfAborted();
    if(operation.type==='open')return meta();
    if(operation.type==='controls'){reads++;return {through:operation.through_seq,
      events:controls.filter(event=>event.seq>operation.after_seq&&event.seq<=operation.through_seq)};}
    assert.equal(operation.type,'wait');
    if(operation.cursor.control_seq<cursor().control_seq)return cursor();
    return new Promise((resolve,reject)=>{
      const done=()=>{waiting.delete(done);signal?.removeEventListener('abort',aborted);resolve(cursor());};
      const aborted=()=>{waiting.delete(done);reject(signal.reason);};
      waiting.add(done);signal?.addEventListener('abort',aborted,{once:true});
    });
  };
  const command=async(id,operation)=>{
    assert.equal(id,'one');
    await hooks.before?.(operation);
    if(operation.type==='list')return {commands:[{id:'model',name:'model-selection'}],revision:{kind:'durable',control_seq:cursor().control_seq}};
    const {invocation}=operation;
    const prior=controls.find(row=>row.invocation?.request_id===invocation.request_id);if(prior)return prior.receipt;
    assert.equal(invocation.expected_revision.control_seq,cursor().control_seq);
    const receipt={command:invocation.command,request_id:invocation.request_id,outcome:{kind:'committed',control_seq:cursor().control_seq+1},
      invocation_sha256:createHash('sha256').update('rsi-session-command-v1\0').update(JSON.stringify(invocation)).digest('hex'),state_sha256:'a'.repeat(64)};
    change({invocation,receipt,selection:invocation.arguments});return receipt;
  };
  const options={ctx,api,llm:await load('dsh-llm'),read,command,submit:(...args)=>hooks.submit(...args),storage,listChildren:async()=>[],authorize:async()=>{}};
  const history=workbenchHistory(options);t.after(()=>history.close());
  const persistence=workbenchPersistence(history,await load('dsh-session-persistence'));
  const capture=async()=>history.capture('one',await history.metadata('one'));
  return {ctx,history,options,load,controls,change,capture,persistence,meta,hooks,get reads(){return reads;}};
}

test('model commands publish passive changes without a transcript or attached Agent', {skip:!root},async t=>{
  const f=await fixture(t),life=new AbortController();
  t.after(()=>life.abort());
  const stream=f.history.observeProjections({sessionId:'one'},AbortSignal.any([life.signal,AbortSignal.timeout(10000)]));
  assert.deepEqual((await stream.next()).value,{type:'ready'});
  for(const reasoningEffort of ['high','low']){
    await f.history.selectModel({sessionId:'one',...base,reasoningEffort});
    const frame=(await stream.next()).value;
    assert.equal(frame?.type,'projection');
    const session=await f.capture(),event=session.eventAt(frame.seq);
    assert.equal(event.type,'model/selection');assert.equal(event.data.reasoningEffort,reasoningEffort);
    assert.deepEqual(frame.changes,[{key:'modelSelection',val:{lastUsed:null,next:event.data}}]);
  }
  await stream.return();
});

test('a log-only approval with no native mutation receipt persists across owners', {skip:!root},async t=>{
  const f=await fixture(t),session=await f.capture(),owner=f.history.owner(session);
  assert.equal(await f.options.storage.read('one'),undefined);
  owner.journal.append('approval/asked',{id:'proof',toolName:'bash'});
  owner.journal.append('approval/decided',{id:'proof',outcome:'rejected'});
  await owner.flush();
  const stored=JSON.parse(await f.options.storage.read('one'));
  assert.equal(stored.version,4);
  assert.deepEqual(stored.events.map(row=>row.type),['approval/asked','approval/decided']);
  const before=f.reads;
  const cold=workbenchHistory(f.options);t.after(()=>cold.close());
  const reopened=await cold.capture('one',await cold.metadata('one'));
  assert.equal(f.reads-before,1,'cold reconstruction and reconciliation share one native capture');
  assert.deepEqual(reopened.lastEvent('approval/decided')?.data,{id:'proof',outcome:'rejected'});
  assert.deepEqual(cold.owner(reopened).journal.operations(),[]);
});

test('an existing full journal is rewritten after canonical reconciliation without changing event coordinates', {skip:!root},async t=>{
  const f=await fixture(t),session=await f.capture();
  // A native-only existing file also needs rewriting, even without local operations.
  const state=JSON.parse(f.history.owner(session).journal.encode());
  state.version=1;state.events=session.snapshotEvents();
  await f.options.storage.save('one',JSON.stringify(state).replace(',"version"',',\n"version"'));
  const cold=workbenchHistory(f.options);t.after(()=>cold.close());
  const before=f.reads,reopened=await cold.capture('one',await cold.metadata('one'));
  assert.equal(f.reads-before,1);
  assert.deepEqual(reopened.snapshotEvents(),session.snapshotEvents());
  const stored=JSON.parse(await f.options.storage.read('one'));
  assert.equal(stored.version,4);assert.deepEqual(stored.events,[]);assert.equal(stored.eventCount,1);
  const again=workbenchHistory(f.options);t.after(()=>again.close());
  assert.deepEqual((await again.capture('one',await again.metadata('one'))).snapshotEvents(),session.snapshotEvents());
});

test('failed canonical reconciliation cannot rewrite a full journal during owner disposal', {skip:!root},async t=>{
  const f=await fixture(t),session=await f.capture(),owner=f.history.owner(session);
  owner.driver.accept({...base,reasoningEffort:'high'});await owner.driver.ready();await f.capture();
  const state=JSON.parse(owner.journal.encode());state.version=1;state.events=session.snapshotEvents();
  delete state.operations[0].receipt;
  state.sources[0].hash='0'.repeat(64);
  const document=JSON.stringify(state).replace(',"version"',',\n"version"');
  await f.options.storage.save('one',document);
  const cold=workbenchHistory(f.options);
  await assert.rejects(cold.capture('one',await cold.metadata('one')),/prefix changed/);
  await cold.close();assert.equal(await f.options.storage.read('one'),document);
});

test('one journal serves follow, Agent capture and cold persistence; local choices wake before native acknowledgement',
  {skip:!root},async t=>{
    const f=await fixture(t),session=await f.capture(),owner=f.history.owner(session);
    const old=await f.persistence.capture('one');assert.equal(old.seq,1);
    const life=new AbortController(),flow=f.history.follow({address:{kind:'session',sessionId:'one'}},life.signal);
    t.after(async()=>{life.abort();await flow.return();});
    assert.equal((await flow.next()).value.cursor,0);
    const waiting=flow.next(),accepted=owner.driver.accept({...base,reasoningEffort:'high'},{},5);
    assert.equal((await waiting).value.event,accepted,'a local append wakes the actual history follower');
    assert.equal(accepted.seq,1);assert.equal(old.snapshotEvents().length,1,'an older captured view does not grow');
    assert.throws(()=>old.eventAt(1),/captured Session interval/);
    const fresh=await f.persistence.capture('one');assert.equal(fresh.seq,2);
    assert.equal(fresh.eventAt(1),accepted,'native cursor stability does not hide a local write from the persistence cache');
    await owner.driver.ready();
    assert.equal(await f.capture(),session);assert.equal(session.seq,2,'native acknowledgement aliases the accepted event');
    const agent=await f.history.captureAgent('one',await f.history.metadata('one'));
    assert.equal(agent.session,session);assert.equal(agent.options.reasoningEffort,'high');
    assert.equal(session.eventAt(1),accepted);
    const count=f.reads;await f.capture();await f.capture();assert.equal(f.reads,count,'unchanged native cuts do not reread controls');
    const cold=workbenchHistory(f.options);t.after(()=>cold.close());
    const reopened=await cold.capture('one',await cold.metadata('one'));
    assert.deepEqual(reopened.snapshotEvents(),session.snapshotEvents());
    assert.deepEqual(cold.owner(reopened).journal.operations(),owner.journal.operations());
  });

test('intervening external model selection requires a new effective event without changing the returned local event',
  {skip:!root},async t=>{
    const f=await fixture(t),session=await f.capture(),owner=f.history.owner(session);
    const accepted=owner.driver.accept({...base,reasoningEffort:'high'},{},2);
    f.change({selection:native({...base,model:'external'})});await f.capture();
    assert.equal(session.lastEvent('model/selection').data.model,'external');
    await owner.driver.ready();await f.capture();
    assert.equal(session.eventAt(accepted.seq),accepted);assert.equal(session.seq,4);
    assert.equal(session.eventAt(3).data.reasoningEffort,'high');assert.equal(session.eventAt(3).data.model,'configured');
    assert.equal(owner.journal.sourceAt(2).seq,3);assert.equal(owner.journal.operations()[0].seq,1);
    const cold=workbenchHistory(f.options);t.after(()=>cold.close());
    assert.deepEqual((await cold.capture('one',await cold.metadata('one'))).snapshotEvents(),session.snapshotEvents());
    const directory=await mkdtemp(join(tmpdir(),'rsi-original-sidechat-'));t.after(()=>rm(directory,{recursive:true,force:true}));
    const outfile=join(directory,'core.mjs');
    const {build}=await import('esbuild');
    await build({entryPoints:[join(root,'node_modules/dsh-better-sidebar/src/sidechat-core.ts')],
      outfile,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
    const {effectiveModelSelection}=await import(pathToFileURL(outfile));
    assert.deepEqual(effectiveModelSelection(session.snapshotEvents()),{...base,reasoningEffort:'high'});
  });

test('failed native batches and stale readers cannot partially publish or rewind the shared owner',
  {skip:!root},async t=>{
    const f=await fixture(t),session=await f.capture(),owner=f.history.owner(session),old=f.meta();
    f.change({selection:native({...base,reasoningEffort:'high'})});f.change({kind:'invalid'});
    const before=owner.journal.encode();await assert.rejects(f.capture(),/Unknown native inbox transition/);
    assert.equal(owner.journal.encode(),before);assert.equal(owner.source.current.controlThrough,1);
    f.controls.pop();await f.capture();assert.equal(session.seq,2);assert.equal(owner.source.current.controlThrough,2);
    assert.equal(await f.history.capture('one',old),session);assert.equal(session.seq,2);
    const captured=await f.history.captureAgent('one',old);assert.equal(captured.sourceCursor.control_seq,2);
  });

test('original attached Agent returns its synchronous event and publishes dependent input only after native choice settlement',
  {skip:!root},async t=>{
    const f=await fixture(t);await f.ctx.plugin((await f.load('dsh-agent')).AgentRegistry);
    const submitted=[];
    const scope=applicationSessions(async(method,args)=>{
      assert.equal(method,'application.submit');assert.equal(args.request,'owner');submitted.push(args);
      return {session_id:'one',message_id:args.message_id,accepted_control_seq:3};
    },{owner:'owner'});
    f.hooks.submit=scope.submit;
    t.after(()=>scope.close());
    scope.inbox.capture=async()=>({kind:'durable',session_id:'one',cursor:{fact_seq:0,control_seq:f.meta().selection_cursor.control_seq},
      active_turn_id:null,pending:[]});scope.history=f.options.read;
    const agents=await workbenchAgents(f.ctx,scope,f.history,await f.load('dsh-scope'),await f.load('dsh-agent'),f.options.api.snapshotJsonValue);
    const agent=await scope.runOwned(()=>agents.ensure('one')),notices=[];
    assert.ok(agent.model instanceof (await f.load('dsh-agent')).AgentModel);
    assert.deepEqual(agent.model.current(),base);
    assert.deepEqual(agent.session.deriveMessages(),[]);
    assert.equal(agent.session.deriveEventMessage(agent.session.eventAt(0)),null);
    const initialSeq=agent.session.seq;
    agent.model.select(base);
    assert.equal(agent.session.seq,initialSeq);
    f.ctx.on('session/event',(session,event)=>{if(session===agent.session)notices.push(event);});
    const entered=Promise.withResolvers(),release=Promise.withResolvers();
    f.hooks.before=async operation=>{if(operation.type==='execute'){entered.resolve();await release.promise;}};
    let event;
    const operation=scope.runOwned(()=>{
      event=agent.session.append('model/selection',{...base,reasoningEffort:'high'});
      assert.deepEqual(agent.model.current(),event.data);
      agent.model.select(event.data);
      assert.equal(agent.session.seq,event.seq+1);
      assert.equal(agent.session.eventAt(event.seq),event);assert.equal(notices[0],event);
      assert.ok(agent.session.ownEvents().includes(event));
      assert.equal(agent.options.reasoningEffort,'high');
      agent.followup({id:'question',role:'user',source:{kind:'user'},content:[{type:'text',text:'question'}]});
    });
    await entered.promise;assert.equal(submitted.length,0);release.resolve();await operation;
    assert.equal(submitted.length,1);assert.equal(notices.filter(row=>row===event).length,1);
    assert.equal(submitted[0].origin,undefined);
    const source=await f.capture();assert.equal(source.eventAt(event.seq),event);
    f.hooks.before=operation=>{if(operation.type==='execute')throw Error('choice unavailable');};
    await assert.rejects(scope.runOwned(()=>{
      agent.session.append('model/selection',{...base,model:'unavailable'});
      agent.followup({id:'blocked',role:'user',source:{kind:'user'},content:[{type:'text',text:'blocked'}]});
    }),/choice unavailable/);
    assert.equal(submitted.length,1);
    await assert.rejects(agents.flush(agent.session),/choice unavailable/);
    f.hooks.before=undefined;
    await scope.runOwned(()=>{
      agent.model.select(base);
      agent.followup({id:'recovered',role:'user',source:{kind:'schedule'},content:[{type:'text',text:'recovered'}]});
    });
    assert.notEqual(submitted.at(-1).message_id,'recovered');
    assert.equal(submitted.at(-1).origin,'application');
    assert.deepEqual(submitted.at(-1).attribution,{id:'recovered',source:{kind:'schedule'}});
    assert.equal(await agents.flush(agent.session),true);
    const enteredFlush=Promise.withResolvers(),releaseFlush=Promise.withResolvers();
    f.ctx.on('session/flush',()=>{throw Error('storage unavailable');});
    f.ctx.on('session/flush',async session=>{
      assert.equal(session,agent.session);enteredFlush.resolve();await releaseFlush.promise;
    });
    let finished=false;
    const flush=assert.rejects(agents.flush(agent.session),/storage unavailable/).then(()=>{finished=true;});
    await enteredFlush.promise;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(finished,false);releaseFlush.resolve();await flush;
  });
