import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {SessionProjectionJournal} from '../../src/session/session-projection-journal.mjs';
import {modelIntents} from '../../src/session/model-intents.mjs';
import {nativePublication} from '../../src/application/native-publication.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
const selection={provider:'native',model:'configured',reasoningEffort:'low'};
const header={version:4,id:'intent-test',createdAt:1,isSeeded:false};
async function fixture(t,options={}) {
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();t.after(()=>ctx.fiber.dispose());
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  return {ctx,api,load,journal:new SessionProjectionJournal(ctx,api,{header},options)};
}
function native(kind='durable') {
  let revision=7,applied=0;const receipts=new Map(),invocations=[];
  return {get applied(){return applied;},invocations,receipts,async command(operation) {
    if(operation.type==='list')return {commands:[{id:'model-command',name:'model-selection'}],
      revision:kind==='draft'?{kind,revision}:{kind,control_seq:revision}};
    const {invocation}=operation;assert.equal(operation.type,'execute');
    invocations.push(structuredClone(invocation));
    const saved=receipts.get(invocation.request_id);
    if(saved){assert.deepEqual(invocation,saved.invocation);return saved.receipt;}
    assert.equal(invocation.expected_revision[kind==='draft'?'revision':'control_seq'],revision);
    applied++;revision++;
    const receipt={command:invocation.command,request_id:invocation.request_id,
      outcome:kind==='draft'?{kind:'draft_changed',revision}:{kind:'committed',control_seq:revision},
      invocation_sha256:createHash('sha256').update('rsi-session-command-v1\0').update(JSON.stringify(invocation)).digest('hex'),state_sha256:'b'.repeat(64)};
    receipts.set(invocation.request_id,{invocation,receipt});return receipt;
  }};
}

test('lost native reply recovers the same invocation from original atomic persistence and applies once',
  {skip:!root},async t=>{
    const {ctx,api,load}=await fixture(t),{writeFileAtomic}=await load('dsh-atomic-write');
    const directory=await mkdtemp(join(tmpdir(),'rsi-model-intent-'));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const file=join(directory,'session.json'),save=value=>writeFileAtomic(file,value,{mode:0o600});
    const journal=new SessionProjectionJournal(ctx,api,{header},{save}),host=native();
    const driver=modelIntents(journal,async operation=>{
      if(operation.type==='execute') {
        const disk=JSON.parse(await readFile(file,'utf8'));
        assert.deepEqual(disk.operations[0].invocation,operation.invocation,'prepared invocation exists before native execution');
        await host.command(operation);throw Error('native reply lost');
      }
      return host.command(operation);
    });
    const event=driver.accept(selection,{},1),id=driver.latest().id;
    assert.equal(event,journal.session.eventAt(0));assert.ok(Object.isFrozen(event));
    await assert.rejects(driver.ready(),/reply lost/);
    assert.equal(host.applied,1);assert.equal(journal.operation(id).receipt,undefined);
    const document=await readFile(file,'utf8');
    const reopened=new SessionProjectionJournal(ctx,api,{header},{save,document});
    const recovered=modelIntents(reopened,host.command);
    await recovered.ready();
    assert.equal(host.applied,1);assert.equal(host.invocations.length,2);
    assert.deepEqual(host.invocations[0],host.invocations[1]);
    assert.equal(reopened.operation(id).receipt.outcome.control_seq,8);
    assert.deepEqual(reopened.session.snapshotEvents(),[event]);
    assert.match(reopened.operation(id).failure,/reply lost/,'attempt diagnostics do not overwrite a later successful receipt');
  });

test('failed preparation never dispatches and receipt persistence failure retries without another execution',
  {skip:!root},async t=>{
    let writes=0,fail=true;
    const {journal}=await fixture(t,{save:async()=>{writes++;if(fail)throw Error('disk unavailable');}}),host=native();
    const driver=modelIntents(journal,host.command);driver.accept(selection);
    await assert.rejects(driver.ready(),/disk unavailable/);assert.equal(host.applied,0);
    const prepared=journal.operation(driver.latest().id).invocation;
    fail=false;await driver.ready();assert.equal(host.applied,1);
    assert.deepEqual(host.invocations[0],prepared);assert.ok(writes>=3);

    let writes2=0;
    const second=(await fixture(t,{save:async()=>{if(++writes2>1)throw Error('receipt disk failed');}})).journal;
    const host2=native(),driver2=modelIntents(second,host2.command);driver2.accept(selection);
    await assert.rejects(driver2.ready(),/receipt disk failed/);assert.equal(host2.applied,1);
    await assert.rejects(driver2.ready(),/receipt disk failed/);
    assert.equal(host2.invocations.length,1,'the in-memory receipt prevents a duplicate dispatch');
    assert.ok(second.operation(driver2.latest().id).receipt);
  });

test('a newer choice supersedes unsent recovery and waits for an already dispatched choice',
  {skip:!root},async t=>{
    const {journal}=await fixture(t,{save:async()=>{}}),host=native();
    const entered=Promise.withResolvers(),release=Promise.withResolvers();let held=true;
    const driver=modelIntents(journal,async operation=>{
      if(operation.type==='list'&&held){held=false;entered.resolve();await release.promise;}
      return host.command(operation);
    });
    driver.accept(selection);const first=driver.latest().id,pending=driver.settle(first);
    await entered.promise;driver.accept({...selection,reasoningEffort:'high'});const second=driver.latest().id;
    release.resolve();assert.deepEqual(await pending,{kind:'superseded'});await driver.ready();
    assert.equal(host.applied,1);assert.equal(host.invocations[0].request_id,second);
    assert.equal(journal.operation(first).invocation,undefined);
    assert.deepEqual(await driver.settle(first),{kind:'superseded'});

    const entered2=Promise.withResolvers(),release2=Promise.withResolvers();let hold=true;
    const driver2=modelIntents(journal,async operation=>{
      if(operation.type==='execute'&&hold){hold=false;entered2.resolve();await release2.promise;}
      return host.command(operation);
    });
    driver2.accept(selection);const third=driver2.latest().id,pending2=driver2.settle(third);
    await entered2.promise;driver2.accept({...selection,reasoningEffort:'high'});const fourth=driver2.latest().id;
    let ready=false;const final=driver2.ready().then(()=>{ready=true;});
    await Promise.resolve();assert.equal(ready,false);release2.resolve();await pending2;await final;
    assert.deepEqual(host.invocations.map(row=>row.request_id),[second,third,fourth]);
    assert.equal(journal.operation(fourth).receipt.outcome.control_seq,10);
  });

test('unconfirmed choice fails publication and dependent work; a later explicit choice can proceed',
  {skip:!root},async t=>{
    let persisted;const {ctx,api,journal}=await fixture(t,{save:async value=>{persisted=value;}}),host=native();
    const driver=modelIntents(journal,operation=>{
      if(operation.type==='execute'&&operation.invocation.arguments.model.model==='unavailable')throw Error('model unavailable');
      return host.command(operation);
    });
    const publication=nativePublication(new AbortController().signal);let submitted=false;
    driver.accept({...selection,model:'unavailable'});
    publication.stage(()=>driver.ready());publication.stage(async()=>{submitted=true;});
    await assert.rejects(publication.finish(),/model unavailable/);
    assert.equal(submitted,false);assert.equal(host.applied,0);
    assert.match(journal.operation(driver.latest().id).failure,/model unavailable/);
    assert.equal(journal.seq,1,'failed publication does not erase the accepted event');
    const cold=new SessionProjectionJournal(ctx,api,{header},{document:persisted,save:async()=>{}});
    const recovered=modelIntents(cold,host.command);recovered.accept(selection);await recovered.ready();
    assert.equal(host.applied,1);assert.equal(host.invocations[0].arguments.model.model,'configured');
    assert.equal(cold.seq,2,'later explicit intent supersedes the old retry without rewriting history');
  });

for(const kind of ['draft','durable'])test(`${kind} receipts retain their actual boundary and only exact control invocations correlate`,
  {skip:!root},async t=>{
    const {journal}=await fixture(t,{save:async()=>{}}),host=native(kind),driver=modelIntents(journal,host.command);
    driver.accept(selection);const id=driver.latest().id;await driver.ready();
    const row=journal.operation(id),control={kind:'model',selection:row.invocation.arguments,
      invocation:row.invocation,receipt:row.receipt};
    assert.equal(driver.observe({kind:'model',selection:row.invocation.arguments}),undefined,'aggregate baseline has no operation correlation');
    assert.equal(driver.observe({...control,invocation:{...row.invocation,request_id:'someone-else'}}),undefined);
    assert.equal(driver.observe(control),id);
    assert.throws(()=>driver.observe({...control,invocation:{...row.invocation,expected_revision:{kind:'durable',control_seq:999}}}),/prepared invocation/);
    assert.throws(()=>driver.observe({...control,receipt:{...row.receipt,request_id:'wrong'}}),/identity/);
    assert.throws(()=>driver.observe({...control,receipt:{...row.receipt,outcome:{kind:'committed',control_seq:999}}}),/publication boundary/);
    assert.throws(()=>driver.observe({...control,receipt:{...row.receipt,invocation_sha256:'0'.repeat(64)}}),/invocation digest/);
    assert.deepEqual(journal.operation(id),row);
  });

test('cold driver rejects a persisted receipt or invocation that no longer binds its accepted choice',
  {skip:!root},async t=>{
    const {ctx,api,journal}=await fixture(t,{save:async()=>{}}),host=native(),driver=modelIntents(journal,host.command);
    driver.accept(selection);await driver.ready();
    for(const mutate of [
      row=>{row.invocation.arguments.model.model='changed';},
      row=>{row.receipt.invocation_sha256='0'.repeat(64);},
      row=>{row.receipt.outcome.control_seq++;},
    ]) {
      const value=JSON.parse(journal.encode());mutate(value.operations[0]);
      const cold=new SessionProjectionJournal(ctx,api,{header},{document:JSON.stringify(value)});
      assert.throws(()=>modelIntents(cold,host.command),/accepted choice|invocation digest|publication boundary/);
    }
  });
