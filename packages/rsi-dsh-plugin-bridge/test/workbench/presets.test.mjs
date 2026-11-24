import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {workbenchPresetRegistry} from '../../src/workbench/presets.mjs';

const cohort=process.env.RSI_DSH_MARKET_COHORT;
test('a colliding Cordis preset uses native configuration, execution and session locking',{skip:!cohort},async t=>{
  const require=createRequire(join(cohort,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const {Context}=await load('cordis'),scopes=await load('dsh-scope');
  const ctx=new Context();
  ctx.baseUrl=import.meta.url;
  t.after(()=>ctx.fiber.dispose());
  await ctx.plugin((await load('cordis-plugin-loader')).default);
  ctx.loader.builtins.group=(await load('cordis-plugin-group')).default;
  await ctx.plugin((await load('dsh-session')).default);
  await ctx.plugin((await load('dsh-session-projection')).default);
  await ctx.plugin((await load('dsh-agent')).AgentRegistry);
  const content='# 实际的组合\n[plugins]\nexample = "原生"\n';
  const standard={id:'standard',name:'Native mode',description:null,broken:null,is_default:true};
  let rows=[standard],locked=false,fullRoster=true,refreshes=0,nativeId='standard';
  const selected=[];
  const sessions={
    withCaller:fn=>fn(),
    async readPresets(op){
      if(op.type==='list'){
        assert.ok(fullRoster,'targeted lookup enumerated all native presets');
        return {presets:rows};
      }
      const row=rows.find(row=>row.id===op.id);
      if(!row)return {code:'not_found'};
      if(row.broken)return {code:'broken',reason:row.broken};
      return {...row,format:'toml',content};
    },
    async resolvePreset(id){return rows.find(row=>id===undefined?row.is_default:row.id===id)??null;},
    async selectPreset(session,id){
      if(locked)return {code:'locked'};
      const changed=id!==nativeId;
      nativeId=id;
      selected.push([session,id]);return {selected:id,changed};
    },
  };
  const agent={id:'one',session:ctx.sessions.create('one',{meta:{agentPreset:'standard'}})};
  const world=scopes.createScope(ctx,agent);agent.ctx=world.ctx;
  const Registry=workbenchPresetRegistry((await load('dsh-agent-preset-registry')).default,
    (await load('dsh-typert-protocol')).RemoteError,sessions,async()=>{
      refreshes++;
      const id=selected.at(-1)[1];
      if(ctx.agentPresets.presetForSession(agent.session)!==id)
        agent.session.append('agent-preset/selected',{agentPreset:id});
    },scopes);
  await ctx.plugin(Registry,{default:'standard'});
  const service=ctx.agentPresets;
  const directory=await mkdtemp(join(tmpdir(),'rsi-preset-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const plugin=join(directory,'shadow-tool.mjs'),lifecycle=[];
  await writeFile(plugin,"export function apply(ctx){ctx.emit('shadow/active',true);ctx.effect(()=>()=>ctx.emit('shadow/active',false));}");
  ctx.on('shadow/active',active=>lifecycle.push(active));
  const shadow={id:'standard',name:'DSH mode',plugins:[{name:pathToFileURL(plugin).href}]};
  const declaration=(await load('dsh-agent-preset')).default;
  const shadowFiber=ctx.plugin(declaration,shadow),otherFiber=ctx.plugin(declaration,{id:'dsh-mode',plugins:[]});
  await Promise.all([shadowFiber.await(),otherFiber.await()]);
  assert.deepEqual(await service.resolve(),{id:'standard'});
  assert.deepEqual(await service.list(),[{id:'standard',name:'Native mode'},{id:'dsh-mode'}]);
  assert.deepEqual((await service.remoteExportList()).presets.map(row=>[row.id,row.isDefault]),[['standard',true],['dsh-mode',false]]);
  fullRoster=false;
  assert.deepEqual(await service.resolve(),{id:'standard'});
  assert.deepEqual(await service.readDocument('standard'),{agentPreset:'standard',name:'Native mode',content});
  assert.equal((await service.compositionInventory()).find(row=>row.id==='standard').rows.length,0);
  assert.deepEqual(await service.mount(agent.ctx,'standard'),{id:'standard'});
  assert.equal(service.composedPreset(agent.ctx),'standard');
  const lease=await service.acquireScope('standard');
  assert.equal(lease.key,scopes.scopeParentOf(agent));
  await lease[Symbol.asyncDispose]();
  await service.select(agent,'dsh-mode');
  assert.equal(service.presetForSession(agent.session),'dsh-mode');
  const resumed={id:'reopened',session:ctx.sessions.create('reopened',{meta:{agentPreset:'dsh-mode'}})};
  const resumedScope=scopes.createScope(ctx,resumed);resumed.ctx=resumedScope.ctx;
  await service.bindSession(resumed,'standard');
  assert.equal(service.composedPreset(resumed.ctx),'dsh-mode');
  resumed.session.append('agent-preset/selected',{agentPreset:'standard'});
  await service.bindSession(resumed,'standard');
  assert.equal(service.composedPreset(resumed.ctx),'dsh-mode');
  await resumedScope.dispose();
  let toolChanges=0;
  ctx.on('tools/change',()=>{toolChanges++;});
  const beforeSwitch=agent.session.seq;
  await service.select(agent,'standard');
  assert.equal(toolChanges,1,'switching to the native preset announces its tools');
  assert.equal(service.presetForSession(agent.session),'standard');
  assert.deepEqual(selected,[['one','standard']]);
  const seq=agent.session.seq;
  assert.equal(seq,beforeSwitch+1,'the Host already recorded the switch');
  const beforeRepeat=refreshes;
  await service.select(agent,'standard');
  assert.equal(refreshes,beforeRepeat,'unchanged selection recaptured the native session');
  assert.equal(toolChanges,1);
  assert.equal(agent.session.seq,seq);
  nativeId='other-native-selection';
  await service.select(agent,'standard');
  assert.equal(refreshes,beforeRepeat+1,'a concurrent native switch must refresh the mirror');
  assert.deepEqual(lifecycle,[]);
  rows=[];
  await service.resolve('standard');
  rows=[standard];
  const stop=ctx.on('tools/change',()=>{throw Error('observer refused');});
  assert.equal(await service.select(agent,'standard'),'standard');
  stop();
  assert.equal(toolChanges,2,'a replacement revision publishes its tools');
  assert.equal(agent.session.seq,seq+1,'the replacement is recorded once');
  assert.deepEqual(lifecycle,[true,false]);
  locked=true;
  await assert.rejects(service.select(agent,'standard'),{code:'agent-preset/locked'});
  rows=[{...standard,broken:'invalid native source'}];
  await assert.rejects(service.readDocument('standard'),{code:'agent-preset/invalid'});
  await assert.rejects(service.select(agent,'standard'),{code:'agent-preset/invalid'});
  rows=[];
  assert.match((await service.readDocument('standard')).content,/shadow-tool/);
  assert.deepEqual(lifecycle,[true,false,true]);
  fullRoster=true;
  assert.equal((await service.list()).find(row=>row.id==='standard').name,'DSH mode');
  assert.equal(service.composedPreset(agent.ctx),'standard');
  await world.dispose();
  await shadowFiber.dispose();await otherFiber.dispose();
  assert.deepEqual(lifecycle,[true,false,true,false]);
  assert.deepEqual(await service.list(),[]);
});
