import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {invocationDigest} from '../../src/session/command-receipts.mjs';
import {workbenchHistory} from '../../src/workbench/history.mjs';
import {nativeInboxFixture} from '../fixtures/native-inbox-fixture.mjs';

const cohort=process.env.RSI_DSH_MARKET_COHORT;
for(const sandbox of [undefined,'workspace-write']){
test(sandbox?'attaching an existing native Session preserves its sandbox under a broader workbench default':
  'published permission presets commit each switch once and replay the original knob events',
  {skip:!cohort||!process.env.RSI_DSH_INBOX_SOURCE},async t=>{
    const accepted=[];
    let reject=false;
    const f=await nativeInboxFixture(t,{kind:'durable',sandbox,commitControl(request,id,control){
      assert.equal(request,'owner');
      assert.equal(id,'one');
      assert.equal(control.command,'rsi.permission.select');
      assert.deepEqual(control.expected_revision,{kind:'durable',control_seq:f.state.control});
      if(reject)throw Error('native revision conflict');
      const {command,request_id,expected_revision,arguments:selection}=control;
      accepted.push(selection);
      f.control({kind:'permission',permission:{...selection,request_id}});
      const invocation={command,request_id,expected_revision,arguments:selection};
      return {control,receipt:{command,request_id,invocation_sha256:invocationDigest(invocation),
        state_sha256:'b'.repeat(64),outcome:{kind:'committed',control_seq:f.state.control}}};
    }});
    const require=createRequire(join(cohort,'package.json'));
    const runtime=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-permission-presets')));
    f.ctx.provide('shell',{sandboxMode:'workspace-write'});
    f.ctx.provide('approval',{config:{policy:'ask'}});
    f.ctx.provide('sessions',{});
    const presets={
      'workspace-write':{sandbox:'workspace-write',approval:'ask'},
      'read-only':{sandbox:'read-only',approval:'ask'},
      'danger-full-access':{sandbox:'danger-full-access',approval:'never'},
    };
    await f.scope.runOwned(()=>f.ctx.plugin(runtime.default,{presets,...sandbox&&{defaultPreset:'danger-full-access'}}));
    const service=f.ctx.permissionPresets,session=f.agent.session;
    assert.equal(service.current(session),'workspace-write');
    const choose=name=>f.scope.runOwned(()=>service.set(session,name));
    await choose('read-only');
    await choose('danger-full-access');
    await choose('danger-full-access');
    const rows=session.snapshotEvents().filter(e=>['permission/preset','sandbox/mode','approval/policy'].includes(e.type));
    assert.deepEqual(rows.map(e=>Object.values(e.data)[0]),[
      ...(sandbox?['workspace-write','ask','workspace-write']:['workspace-write','workspace-write','ask']),
      'read-only','read-only','danger-full-access','danger-full-access','never',
    ]);
    assert.deepEqual(accepted.map(a=>a.preset),['workspace-write','read-only','danger-full-access']);
    reject=true;
    await assert.rejects(async()=>choose('workspace-write'),/native revision conflict/);
    assert.equal(service.current(session),'danger-full-access');
    await f.refresh();
    await f.owner.flush();
    const cold=workbenchHistory(f.options);
    try{
      assert.deepEqual((await cold.capture('one')).snapshotEvents(),session.snapshotEvents());
      assert.equal(session.snapshotEvents().filter(e=>rows.some(row=>row.type===e.type)).length,rows.length);
    }finally{await cold.close();}
  });
}
