import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createApplication} from '../../src/application/application.mjs';
import {invocationDigest} from '../../src/session/command-receipts.mjs';
import {workbenchGoalMutations} from '../../src/workbench/goal-mutations.mjs';
import {workbenchProfile} from '../../src/workbench/profile.mjs';
import {workbenchHistory} from '../../src/workbench/history.mjs';
import {nativeInboxFixture} from '../fixtures/native-inbox-fixture.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('the standard Goal service publishes native commands and revokes scheduling through the guest lifecycle',
  {skip:!root||!process.env.RSI_DSH_INBOX_SOURCE,timeout:60000},async t=>{
    const runtime='@deepseek-ai/dsh-goal',guest='example-review',require=createRequire(join(root,'package.json'));
    const profile=await mkdtemp(join(tmpdir(),'rsi-goal-mutation-'));
    t.after(()=>rm(profile,{recursive:true,force:true}));
    const modules={entry:name=>name===guest?fileURLToPath(import.meta.url):require.resolve(name),
      directory:name=>join(root,'node_modules',name)};
    const boot=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-app-boot')));
    const {rows}=await workbenchProfile(modules,boot,profile);
    const goalRow=rows.find(row=>row.name===runtime);
    assert.ok(goalRow,'the original profile supplies the standard Goal service');
    assert.ok(!rows.some(row=>row.name==='@deepseek-ai/dsh-goal-round-driver'));
    const hostModules=new Map(),accepted=[];
    let f,plugin,current,reject=false,lastControl,arm=false,disarms=0,cleanup;
    function commitGoal(request,session,control) {
      assert.equal(request,'owner');assert.equal(session,'one');
      if(reject)throw Error('native revision conflict');
      if(control.type==='disarm_goal'){disarms++;return null;}
      assert.deepEqual(control.expected_revision,{kind:'durable',control_seq:f.state.control});
      const a=control.action;
      lastControl=control;
      if(a.action==='create')current={id:a.id,objective:a.objective,phase:'active',max_rounds:a.max_rounds};
      else if(a.action==='clear')current=null;
      else if(a.action==='edit')current={...current,objective:a.objective??current.objective,max_rounds:a.max_rounds??current.max_rounds};
      else if(a.action==='resume')current={...current,phase:'active',reason:null,block_code:null};
      else if(a.action==='block')current={...current,phase:'blocked',reason:a.message,block_code:a.code};
      else {assert.equal(a.action,'complete');current={...current,phase:'completed'};}
      accepted.push(a);
      f.control({kind:'goal',goal:{current,command:{request_id:control.request_id,action:a.action,published_at_ms:control.published_at_ms}}});
      const args={...a,published_at_ms:control.published_at_ms};
      const invocation={command:'rsi.goal.command',request_id:control.request_id,expected_revision:control.expected_revision,
        arguments:args};
      return {control,receipt:{command:invocation.command,request_id:control.request_id,
        invocation_sha256:invocationDigest(invocation),state_sha256:'b'.repeat(64),outcome:{kind:'committed',control_seq:f.state.control}}};
    }
    const app=await createApplication({modules,profile,hostModules,baseRows:[goalRow],async provide(ctx,load){
      const goals=workbenchGoalMutations((await load(runtime)).default,(await load('@deepseek-ai/cordis')).symbols.caller,
        id=>f.scope.commitGoal(id,{type:'disarm_goal'}));
      f=await nativeInboxFixture(t,{kind:'durable',context:ctx,goals,commitGoal,activateGoal(control){
        assert.deepEqual(control,lastControl);
        return {live:{armed:arm}};
      }});
      hostModules.set(runtime,goals.Runtime);
      hostModules.set(guest,{inject:['goals'],apply(caller){
        plugin=caller;
        caller.effect(()=>()=>{cleanup=caller.goals.disarm(f.agent);});
      }});
    }});
    try {
      await app.reconcile([[{insert:[{id:'review',name:guest}]}]]);
      const {remoteMethods}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-typert-protocol')));
      const exports=remoteMethods(plugin.goals).map(marker=>marker.exportName??marker.method);
      for(const name of ['create','edit','clear','pause','resume','complete','get'])assert.ok(exports.includes(name),name);
      assert.throws(()=>plugin.goals.disarm({id:f.agent.id}),/not live/);
      assert.equal(disarms,0);
      assert.equal(plugin.goals.disarm(f.agent),undefined);
      assert.equal(disarms,1);
      let done;
      await f.scope.runOwned(()=>{
        const first=plugin.goals.create(f.agent,{objective:'Review the draft',maxGoalRounds:2});
        const before=f.agent.session.seq;
        reject=true;
        assert.throws(()=>plugin.goals.complete(f.agent,first),/native revision conflict/);
        assert.equal(f.agent.session.seq,before);
        assert.equal(plugin.goals.get(f.agent).revision,1);
        reject=false;
        done=plugin.goals.complete(f.agent,first);
        assert.equal(done.phase,'complete');assert.equal(done.roundsStarted,0);
      });
      await f.refresh();
      assert.deepEqual(plugin.goals.get(f.agent),done);
      assert.deepEqual(accepted.map(a=>a.action),['create','complete']);
      assert.deepEqual(accepted[1].source,{kind:'plugin',name:guest});
      assert.deepEqual(f.agent.session.snapshotEvents().filter(e=>e.type==='goal/change').map(e=>e.data.operation),['create','complete']);
      assert.ok(!f.calls.some(call=>call.method==='application.submit'||call.op?.type==='goal'));
      assert.throws(()=>f.agent.session.append('goal/change',{}),/owning Goal service/);
      await f.owner.flush();
      const saved=JSON.parse(f.documents.get('one'));
      assert.deepEqual(saved.events.filter(e=>e.type==='goal/change').map(e=>e.data),[null,null]);
      const reopened=workbenchHistory(f.options);
      try {
        const session=await reopened.capture('one');
        assert.deepEqual(session.snapshotEvents(),f.agent.session.snapshotEvents());
      } finally {await reopened.close();}
      let reads=0;
      const capture=f.scope.inbox.capture;
      f.scope.inbox.capture=(...args)=>{reads++;return capture(...args);};
      reject=true;
      await f.scope.runOwned(()=>{
        assert.throws(()=>plugin.goals.create(f.agent,{objective:'Rejected review'}),/native revision conflict/);
      });
      assert.equal(reads,0,'a rejected write published no change to refresh');
      reject=false;
      const next=await f.scope.runOwned(()=>plugin.goals.remoteExportCreate(f.agent,{objective:'Start another review'}));
      assert.deepEqual(next.ref,{id:plugin.goals.get(f.agent).id,revision:1});
      assert.equal(f.calls.filter(call=>call.op?.type==='goal').length,1);
      assert.equal(plugin.goals.get(f.agent).activation,'disarmed');
      arm=true;
      await f.scope.runOwned(()=>plugin.goals.resume(f.agent,next.ref));
      assert.equal(plugin.goals.get(f.agent).activation,'armed');
      const prior=plugin.goals.get(f.agent),seq=f.agent.session.seq;
      reject=true;
      assert.throws(()=>plugin.goals.disarm(f.agent),/native revision conflict/);
      assert.equal(plugin.goals.get(f.agent).activation,'armed');
      reject=false;
      const stopped=plugin.goals.disarm(f.agent);
      assert.deepEqual(stopped,{...prior,activation:'disarmed'});
      assert.equal(f.agent.session.seq,seq);
      const starts=f.calls.filter(call=>call.op?.type==='goal').length;
      await f.scope.runOwned(()=>{
        const resumed=plugin.goals.resume(f.agent,stopped);
        assert.deepEqual(plugin.goals.disarm(f.agent),{...resumed,activation:'disarmed'});
      });
      assert.equal(disarms,3);
      assert.equal(f.calls.filter(call=>call.op?.type==='goal').length,starts);
      assert.equal(plugin.goals.get(f.agent).activation,'disarmed');
      const retained=plugin.goals;
      const priorToBlock=plugin.goals.get(f.agent);
      const reason={code:'needs-input',message:'A choice is required.'};
      reject=true;
      assert.throws(()=>plugin.goals.block(f.agent,priorToBlock,reason),/native revision conflict/);
      assert.deepEqual(plugin.goals.get(f.agent),priorToBlock);
      reject=false;
      const blocked=await f.scope.runOwned(()=>plugin.goals.block(f.agent,priorToBlock,{...reason,message:'  A choice is required.  '}));
      assert.equal(blocked.phase,'blocked');
      assert.equal(blocked.activation,'disarmed');
      assert.deepEqual(blocked.blockedReason,reason);
      assert.deepEqual(accepted.at(-1),{action:'block',id:priorToBlock.id,...reason});
      await f.owner.flush();
      const cold=workbenchHistory(f.options);
      try {
        const last=(await cold.capture('one')).lastEvent('goal/change').data;
        assert.equal(last.operation,'block');
        assert.deepEqual(last.goal.blockedReason,reason);
        assert.equal(last.goal.revision,blocked.revision);
      } finally {await cold.close();}
      let cleared,replacement,edited;
      await f.scope.runOwned(()=>{
        assert.throws(()=>plugin.goals.create(f.agent,{objective:'Must retain blocked review'}));
        cleared=plugin.goals.clear(f.agent,blocked);
        assert.deepEqual(cleared,{id:blocked.id,revision:blocked.revision+1});
        assert.equal(plugin.goals.get(f.agent),undefined);
        replacement=plugin.goals.create(f.agent,{objective:'Second review',maxGoalRounds:2});
        edited=plugin.goals.edit(f.agent,replacement,{objective:'  Revised review  ',maxGoalRounds:20});
      });
      assert.deepEqual(accepted.slice(-3),[{action:'clear',id:blocked.id},
        {action:'create',id:replacement.id,objective:'Second review',constraints:'',max_rounds:2},
        {action:'edit',id:replacement.id,objective:'Revised review',max_rounds:20}]);
      assert.equal(edited.activation,'armed');
      assert.equal(edited.roundsStarted,0);
      assert.equal(edited.revision,replacement.revision+1);
      assert.equal(f.calls.filter(call=>call.op?.type==='goal').length,starts+1);
      await f.refresh();
      assert.deepEqual(plugin.goals.get(f.agent),edited);
      await f.owner.flush();
      const restored=workbenchHistory(f.options);
      try {
        const events=(await restored.capture('one')).snapshotEvents().filter(e=>e.type==='goal/change').slice(-3);
        assert.deepEqual(events.map(e=>e.data.operation),['clear','create','edit']);
        assert.deepEqual(events[0].data.cleared,cleared);
        assert.ok(Number.isSafeInteger(events[0].data.clearedAt));
        assert.equal(events[2].data.goal.maxGoalRounds,20);
        assert.equal(events[2].data.goal.objective,'Revised review');
      } finally {await restored.close();}
      await app.reconcile([]);
      assert.equal(cleanup?.activation,'disarmed','the disposer can revoke scheduling');
      assert.equal(disarms,4);
      assert.throws(()=>retained.disarm(f.agent));
      assert.equal(disarms,4,'a retired guest cannot revoke another activation');
    } finally {await app.close();}
  });
