import {nativeSubmission} from '../fixtures/native-submission.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {workbenchAgents} from '../../src/workbench/agents.mjs';
import {workbenchPresetRegistry} from '../../src/workbench/presets.mjs';
import {captureAgentView} from '../../src/workbench/agent-view.mjs';
import {SessionProjectionJournal} from '../../src/session/session-projection-journal.mjs';
import {inputIntents} from '../../src/session/inbox/input-intents.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('a waking input already staged by the plugin wins admission before maintenance',{skip:!root||!process.env.RSI_DSH_INBOX_SOURCE},async t=>{
  const {nativeInboxFixture,message}=await import('../fixtures/native-inbox-fixture.mjs');
  const f=await nativeInboxFixture(t,{commitControl(){throw Error('native maintenance preceded the staged input');}});
  f.state.submitGate=Promise.withResolvers();
  await f.scope.runOwned(()=>{
    f.agent.followup(message('first'));
    try {assert.throws(()=>f.agent.runMaintenance(()=>{}),/already has active work/);}
    finally {f.state.submitGate.resolve();}
  });
});
test('plugin maintenance owns the idle agent until its callback settles',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context(),agentApi=await load('dsh-agent');
  await ctx.plugin((await load('dsh-session-projection')).default);await ctx.plugin(agentApi.AgentRegistry);
  const api={...await load('dsh-session'),...await load('dsh-session/surface'),...await load('dsh-util-values')};
  const id='maintenance';let saved;
  const journal=new SessionProjectionJournal(ctx,api,{header:api.Session.create(id).header},{save:value=>{saved=value;}});
  let held, stop, cleared=0;
  const deliveries=[];
  const scope=applicationSessions(async(method,args,signal)=>{
    if(method==='application.cancel'){
      assert.equal(args.keep_inbox,false);cleared++;return {session_id:id};
    }
    if(method==='application.command'){
      assert.equal(args.operation.key,held);
      if(args.operation.type==='wait_maintenance_cancel'){
        await Promise.race([stop.promise,new Promise(done=>signal.addEventListener('abort',done,{once:true}))]);
        return null;
      }
      assert.equal(args.operation.type,'finish_maintenance');held=undefined;return null;
    }
    throw Error('Unexpected native request '+method);
  },{owner:'owner',commitControl(caller,session,op){
    assert.equal(caller,'owner');assert.equal(session,id);assert.equal(op.type,'begin_maintenance');
    assert.equal(held,undefined);held=op.key;stop=Promise.withResolvers();return true;
  }});
  t.after(async()=>{await ctx.fiber.dispose();await scope.close();});
  scope.inbox.capture=async()=>({kind:'draft',shared:true,revision:0,pending:[]});
  scope.inbox.waitIdle=async()=>{assert.equal(held,undefined);};
  await workbenchAgents(ctx,scope,{
    owner:()=>({journal,flush:options=>journal.flush(options),input:{reconcileClears(){},observeDraft(){},clear:()=>[],confirmClear(){},abandonClear(){},
      accept(_message,delivery){deliveries.push(delivery);}}}),
    metadata:async()=>({selection_cursor:{kind:'draft',revision:0}}),
    captureAgent:async()=>({session:journal.session,options:{}}),
  },await load('dsh-scope'),agentApi,api.snapshotJsonValue);
  const handle=await ctx.agents.resume({resumeSessionId:id}),{agent}=handle;
  const afterStop=Promise.withResolvers();
  let signal, idle=false;
  const work=agent.runMaintenance(s=>{signal=s;return afterStop.promise;});
  assert.equal(signal.aborted,false,'callback starts synchronously on native admission');
  assert.equal(agent.status,'idle');
  agent.steer({id:'before-stop'});
  assert.throws(()=>agent.runMaintenance(()=>{}),/active work/);
  const converged=agent.whenIdle().then(()=>{idle=true;});
  const aborted=new Promise(done=>signal.addEventListener('abort',done,{once:true}));
  stop.resolve();
  await aborted;
  assert.equal(idle,false);
  assert.equal(signal.reason.kind,'user');
  agent.steer({id:'after-stop'});
  afterStop.resolve(17);
  assert.equal(await work,17);
  await converged;
  assert.deepEqual(deliveries,['steer','next_turn']);
  await assert.rejects(agent.runMaintenance(()=>{throw Error('plugin failed');}),/plugin failed/);
  assert.equal(held,undefined);
  const closingWork=agent.runMaintenance(async s=>{
    await new Promise(done=>s.addEventListener('abort',done,{once:true}));
    agent.session.append('session/title',{title:'Maintenance finished',source:{kind:'user'},messageSeqs:[]});
    return s.reason.kind;
  });
  await handle.dispose();
  assert.equal(await closingWork,'disposed');assert.equal(held,undefined);assert.equal(cleared,1);
  assert.equal(journal.session.lastEvent('session/title').data.title,'Maintenance finished');
  assert.match(JSON.stringify(saved),/Maintenance finished/);
});

test('released telemetry captures a new fork marker and skips the saved log when that Agent reopens',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context(),agentApi=await load('dsh-agent');
  await ctx.plugin((await load('dsh-session-projection')).default);await ctx.plugin(agentApi.AgentRegistry);
  const api={...await load('dsh-session'),...await load('dsh-session/surface'),...await load('dsh-util-values')};
  const parent=api.Session.create('parent');
  parent.append('turn/start',{turn:1});
  parent.append('turn/end',{turn:1,reason:{kind:'completed'},rsi:{session:'parent',turn:'turn',fact:3}});
  const seed=parent.snapshotEvents(),header={version:4,id:'child',createdAt:1,parentSession:'parent',isSeeded:true};
  const original=api.Session.create('child',seed,header,seed.length);
  const journal=new SessionProjectionJournal(ctx,api,{header});
  journal.merge(original.snapshotEvents(),new Map(),seed.length);
  const scope=applicationSessions(async method=>{
    assert.equal(method,'application.create');return {id:'child',summary:{createdAt:1}};
  },{owner:'owner'});
  t.after(async()=>{await ctx.fiber.dispose();await scope.close();});
  scope.inbox.capture=async()=>({kind:'draft',shared:true,revision:0,pending:[]});
  await workbenchAgents(ctx,scope,{
    metadata:async()=>({selection_cursor:{kind:'draft',revision:0}}),
    captureAgent:async()=>({session:journal.session,options:{}}),
  },await load('dsh-scope'),agentApi,api.snapshotJsonValue);
  const records=[];
  const coordinator=new (await load('dsh-session-telemetry')).SessionTelemetryCoordinator(ctx,
    {emit:record=>records.push(record.sourceEvent.envelope.seq),shutdown:async()=>{}},{capture:'on-demand'});
  const capture=session=>{coordinator.captureSession(session);return records.splice(0);};
  const created=await ctx.agents.create({sessionId:'child',meta:{parentSession:'parent'},seed,inheritedEventCount:seed.length});
  const fresh=capture(original);
  assert.deepEqual(fresh,[seed.length]);
  assert.deepEqual(capture(created.agent.session),fresh);
  assert.equal(created.agent.session.firstLifecycleSeq,original.firstLifecycleSeq);
  assert.equal(created.agent.session.eventAt(original.firstLifecycleSeq).type,'session/end-seed');
  await created.dispose();
  const restored=api.Session.fromRestore('child',original.snapshotEvents(),header,seed.length,'shared-frozen');
  const resumed=await ctx.agents.resume({resumeSessionId:'child'});
  assert.deepEqual(capture(restored),[]);
  assert.deepEqual(capture(resumed.agent.session),[]);
  assert.equal(resumed.agent.session.firstLifecycleSeq,original.seq);
  await resumed.dispose();
});

test('plugins claim an ordinary root on their native caller and publish it only after setup',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context(),agentApi=await load('dsh-agent');
  await ctx.plugin((await load('dsh-session-projection')).default);await ctx.plugin(agentApi.AgentRegistry);
  const api={...await load('dsh-session'),...await load('dsh-session/surface'),...await load('dsh-util-values')};
  const saved=new Map(),calls=[],announced=[],announcedPresets=[];
  const claimEntered=Promise.withResolvers(),claimRelease=Promise.withResolvers(),remoteEntered=Promise.withResolvers();
  const scope=applicationSessions(async(method,args)=>{
    calls.push([method,args.request]);
    if(method==='application.presets'&&args.operation.type==='resolve'){
      assert.equal(args.operation.id,'writer');
      return {id:'writer',is_default:true};
    }
    if(method==='application.create'){
      assert.equal(args.requested,undefined);assert.equal(args.cwd,process.cwd());
      assert.equal(args.preset,'writer');assert.equal(args.fork,undefined);
      if(saved.has(args.fresh))throw Error('Session already exists');
      const journal=new SessionProjectionJournal(ctx,api,{header:{version:4,id:args.fresh,createdAt:1,cwd:args.cwd,isSeeded:false,agentPreset:args.preset}},{save:async()=>{}});
      saved.set(args.fresh,journal.session);
      if(args.fresh==='root'){claimEntered.resolve();await claimRelease.promise;}
      return {id:args.fresh,reused:false,summary:{createdAt:1}};
    }
    if(method==='application.actor')return {id:args.session_id,cwd:process.cwd()};
    if(method==='application.inbox'&&args.operation.type==='open')
      return {kind:'draft',shared:true,revision:0,session_id:args.session_id,pending:[]};
    assert.fail(method+' '+args.operation?.type);
  },{owner:'app-caller',agent:id=>agents?.get(id),registered:id=>ctx.agents.get(id)});
  const loop=ctx.plugin({inject:['agents','sessionProjections'],apply(){}});await loop;
  const scopes=await load('dsh-scope');
  await ctx.plugin((await load('cordis-plugin-loader')).default);
  ctx.loader.builtins.group=(await load('cordis-plugin-group')).default;
  const Registry=workbenchPresetRegistry((await load('dsh-agent-preset-registry')).default,
    (await load('dsh-typert-protocol')).RemoteError,scope,()=>assert.fail('unexpected native refresh'),scopes);
  await ctx.plugin(Registry,{default:'writer'});
  let agents=await workbenchAgents(loop.ctx,scope,{
    metadata:async()=>({preset:'writer',selection_cursor:{kind:'draft',revision:0}}),
    captureAgent:async id=>({session:saved.get(id),options:{}}),
  },await load('dsh-scope'),agentApi,api.snapshotJsonValue);
  t.after(async()=>{await ctx.fiber.dispose();await scope.close();});
  ctx.on('agent/created',({agent,source})=>{
    announced.push([agent.id,source]);announcedPresets.push(ctx.agentPresets.composedPreset(agent.ctx));
  });
  const owner=ctx.plugin({inject:['agents'],apply(){}});await owner;
  const meta={cwd:process.cwd(),agentPreset:'writer'};
  const setup=Promise.withResolvers(),release=Promise.withResolvers();
  const created=owner.ctx.agents.create({sessionId:'root',meta,async setup(_ctx,agent){
    assert.equal(ctx.agents.get('root'),undefined);assert.equal(scope.sessions.get('root'),agent.session);
    setup.resolve();await release.promise;
    return {commit(){assert.equal(ctx.agentPresets.composedPreset(agent.ctx),'writer');}};
  }});
  await claimEntered.promise;
  const observed=agents.ensure('root');claimRelease.resolve();
  await setup.promise;assert.deepEqual(announced,[]);
  const browser=await scope.prepare({headers:{'x-rsi-upstream-request':'web-caller'},url:'/api/test'});
  const lookup=browser(()=>scope.lookupAgent('root',(id,signal)=>{remoteEntered.resolve();return agents.ensure(id,signal);}));
  await Promise.race([remoteEntered.promise,lookup.then(()=>assert.fail('lookup returned during setup'))]);
  await assert.rejects(owner.ctx.agents.create({sessionId:'root',meta}),/already|in progress/);
  release.resolve();const handle=await created;
  assert.equal(await lookup,handle.agent);assert.equal(await observed,handle.agent);assert.deepEqual(announced,[['root','startup']]);
  assert.equal(handle.agent.session.header.agentPreset,'writer');
  await handle.dispose();
  await assert.rejects(owner.ctx.agents.create({sessionId:'root',meta}),/already exists/);
  assert.equal(ctx.agents.get('root'),undefined);
  const resumed=await owner.ctx.agents.resume({resumeSessionId:'root'});
  assert.deepEqual(resumed.agent.session.header,handle.agent.session.header);
  await resumed.dispose();assert.deepEqual(announced,[['root','startup'],['root','resume']]);
  assert.deepEqual(announcedPresets,['writer','writer']);
  const fromBrowser=await browser(()=>owner.ctx.agents.create({sessionId:'web',meta}));
  assert.equal(fromBrowser.agent.id,'web');
  await loop.dispose();
  assert.equal(ctx.agents.get('web'),undefined,'retiring the factory releases an Agent held by another plugin');
  await fromBrowser.dispose();
  assert.deepEqual(calls.filter(([method])=>method==='application.create').map(([,caller])=>caller),['app-caller','app-caller','web-caller']);
});

for(const open of [false,true])test(`original registry owns ${open?'open':'completed'} native fork setup, input receipts and ordered stop before scoped teardown`,{skip:!root,timeout:10000},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();
  await ctx.plugin((await load('dsh-session-projection')).default);
  await ctx.plugin((await load('dsh-agent')).AgentRegistry);
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  const selection={provider:'native',model:'chosen'},seen=[],states=new Map();
  const completed={seq:0,time:1,type:'turn/end',data:{turn:1,reason:'completed',rsi:{session:'parent',turn:'turn',fact:9}}};
  const started={seq:0,time:1,type:'turn/start',data:{turn:1,rsi:{session:'parent',turn:'turn',fact:1}}};
  const questionEvent={seq:1,time:2,type:'user/message',surfaceOp:'append',data:{id:'input',role:'user',source:{kind:'user'},content:[{type:'text',text:'Open parent context'}]}};
  const parentEvents=open?[started,questionEvent]:[completed];
  const initial=id=>({id,revision:1,active_turn_id:null,pending:[],events:id==='parent'?parentEvents:[]});
  states.set('parent',initial('parent'));let agents,gate,retaining,drain,matchingOrigin,otherOrigin;const changes=new Set(),draftOwners=new Map();
  const scope=applicationSessions(async(method,args,signal)=>{
    seen.push([method,args]);assert.equal(args.request,'owner');
    const state=states.get(args.session_id);
    if(method==='application.inbox'&&args.operation.type==='wait_idle'){
      await drain?.promise;assert.equal(state.active_turn_id,null);return null;
    }
    if(method==='application.inbox'&&args.operation.type==='retain_draft'){
      draftOwners.set(args.session_id,args.operation.key);
      if(retaining){
        retaining.resolve();
        await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
      }
      return true;
    }
    if(method==='application.inbox'&&args.operation.type==='release_draft'){
      assert.equal(draftOwners.get(args.session_id),args.operation.key);draftOwners.delete(args.session_id);return null;
    }
    if(method==='application.inbox'&&args.operation.type==='wait_draft') {
      if(state.revision!==args.operation.revision)return null;
      return new Promise((resolve,reject)=>{
        const done=()=>{if(state.revision===args.operation.revision)return;
          changes.delete(done);signal.removeEventListener('abort',aborted);resolve(null);};
        const aborted=()=>{changes.delete(done);reject(signal.reason);};
        changes.add(done);signal.addEventListener('abort',aborted,{once:true});
      });
    }
    if(method==='application.create'){
      matchingOrigin=agents.creationMeta('child',1);otherOrigin=agents.creationMeta('child',2);
      assert.equal(args.fresh,'child');assert.equal(args.requested,undefined);
      assert.deepEqual(args.fork,{source_session_id:'parent',point:{kind:open?'before_turn':'through_turn',turn_id:'turn'},turns:'all'});
      states.set('child',initial('child'));return {id:'child',summary:{createdAt:1}};
    }
    if(method==='application.model.select')return {selected:args.selection};
    if(method==='application.command'){
      if(args.operation.type==='list')return {commands:[{id:'native-context',name:'context-input'},
        {id:'native-seed',name:'context-seed'}],revision:{kind:'draft',revision:state.revision}};
      if(args.operation.invocation.command==='native-seed'){
        assert.match(args.operation.invocation.arguments.text,/Open parent context/);
        state.seed=args.operation.invocation.arguments.text;state.revision++;return {committed:true};
      }
      assert.fail('injection must not execute a native command');
    }
    if(method==='application.submit'){
      args=await nativeSubmission(args,scope);
      if(args.delivery==='next_step') {
        assert.notEqual(args.message_id,'boundary');
        assert.deepEqual(args.attribution,{id:'boundary',source:{kind:'plugin:sidechat',tag:{n:1}}});
        state.pending.push({message_id:args.message_id,source_kind:'human',target:'next_step',
          message:{message_id:args.message_id,source:{type:'human',attribution:args.attribution},
            content:args.content.map(({kind,...part})=>({type:kind,...part}))}});
        state.revision++;return {session_id:args.session_id,message_id:args.message_id,accepted_control_seq:1};
      }
      assert.equal(state.pending.length,1,'context was committed before human submit');
      assert.deepEqual(state.pending[0].message.content,[{type:'text',text:'context'},{type:'text',text:'第二块'}]);
      assert.deepEqual(args.content,[{kind:'text',text:'question'}]);
      assert.notEqual(args.message_id,'question');
      assert.deepEqual(args.attribution,{id:'question',source:{kind:'user',label:{value:'original'}}});
      state.pending=[];state.active_turn_id='child-turn';state.revision++;
      return {session_id:args.session_id,message_id:args.message_id,accepted_control_seq:2};
    }
    if(method==='application.cancel'){
      assert.equal(args.session_id,'child');await gate?.promise;state.active_turn_id=null;
      return {session_id:'child'};
    }
    throw Error(method);
  },{owner:'owner',agent:id=>agents?.get(id)});
  scope.inbox.capture=async id=>{
    const state=states.get(id);return structuredClone({kind:'draft',session_id:id,shared:state.shared,revision:state.revision,
      active_turn_id:state.active_turn_id,pending:state.pending});
  };
  const owners=new Map();
  const history={metadata:async id=>({selection_cursor:{kind:'draft',revision:states.get(id).revision}}),
    owner:session=>owners.get(session.id),
    async captureAgent(id,meta) {
      let owner=owners.get(id);
      if(!owner) {
        const journal=new SessionProjectionJournal(ctx,api,{header:{version:4,id,createdAt:1,cwd:process.cwd(),isSeeded:false}}, {save:async()=>{}});
        const input=inputIntents(journal,{command:(op,signal)=>scope.command(id,op,signal),
          submit:(value,signal)=>scope.submit(id,value,signal),inbox:{
          capture:signal=>scope.inbox.capture(id,signal),discardDraft:(ids,signal)=>scope.inbox.discardDraft(id,ids,signal),
          mutate:(mutation,signal)=>scope.inbox.mutate(id,mutation,signal)}});
        owner={journal,input,flush:()=>journal.flush(),driver:{ready:async()=>{}},model:()=>({next:selection})};
        owners.set(id,owner);
      }
      owner.meta=meta;
      owner.journal.merge(states.get(id).events);return {options:selection,session:owner.journal.session};
    }};
  await ctx.plugin((await load('dsh-system-prompt')).default);
  await ctx.plugin((await load('dsh-tools')).default);
  const loop=ctx.plugin({inject:['agents','sessionProjections','tools'],apply(){}});await loop;
  agents=await workbenchAgents(loop.ctx,scope,history,await load('dsh-scope'),await load('dsh-agent'),api.snapshotJsonValue);
  t.after(async()=>{gate?.resolve();drain?.resolve();await ctx.fiber.dispose();await scope.close();});
  const parent=await scope.runOwned(()=>agents.ensure('parent'));
  assert.equal(ctx.agents.get('parent'),parent);
  assert.equal(scope.sessions.get('parent'),parent.session);
  assert.equal(scope.workingDirectory.get(parent.session),process.cwd());
  assert.deepEqual(seen.map(([method,args])=>[method,args.operation.type]),
    [['application.inbox','retain_draft'],['application.inbox','wait_draft']],
    'attachment retains the draft and observes it without executing work');
  const owner=ctx.plugin({inject:['agents'],apply(){}});await owner;
  const lifecycle=[];let scoped;
  const parentLog=owners.get('parent').journal.session,originalSnapshot=parentLog.snapshotEvents.bind(parentLog);
  let fullParentReads=0;
  parentLog.snapshotEvents=(...args)=>{if(!args.length)fullParentReads++;return originalSnapshot(...args);};
  ctx.on('agent/created',({agent})=>{if(agent.id==='child')lifecycle.push('announced');});
  const seed=open?[...parentEvents,{type:'turn/end',data:{turn:1,reason:{kind:'interrupted'}}}]:[...parentEvents];
  const annotation={seq:seed.length,time:5,type:'subagent/descriptor',data:{version:3,mode:'continuable',provider:'test',label:'child'}};
  seed.push(annotation);
  const handle=await scope.runOwned(()=>owner.ctx.agents.create({sessionId:'child',meta:{parentSession:'parent'},
    seed,inheritedEventCount:seed.length,
    agentOptions:selection,setup(agentCtx,agent){
      scoped=agentCtx;assert.equal(ctx.agents.get('child'),undefined);
      assert.equal(scope.sessions.get('child'),agent.session);
      assert.equal(typeof agentCtx.tools.guard,'function','Agent scope inherits the factory tool registry');
      agentCtx.effect(()=>()=>lifecycle.push('scope-disposed'));
      return {commit(){lifecycle.push('committed');}};
    }}));
  assert.equal(handle.agent.ctx,scoped);assert.deepEqual(lifecycle,['committed','announced']);
  assert.equal(fullParentReads,0,'the supplied native boundary already identifies the fork cut');
  assert.deepEqual(await matchingOrigin,{meta:{parentSession:'parent'},createdAt:1,annotations:[annotation]});
  assert.notEqual((await matchingOrigin).annotations[0].data,annotation.data);
  assert.equal(await otherOrigin,undefined);
  assert.equal(await agents.creationMeta('child',1),undefined,'creation scope released after publication');
  assert.deepEqual([...draftOwners.keys()],['parent','child']);
  handle.agent.inbox.clear();
  if(open)assert.match(states.get('child').seed,/Open parent context/,'clearing the fresh inbox preserves seed context');
  const boundary={id:'boundary',role:'user',source:{kind:'plugin:sidechat',tag:{n:1}},content:[{type:'text',text:'context'},{type:'text',text:'第二块'}]};
  handle.agent.inject(boundary);boundary.source.tag.n=2;boundary.content[1].text='changed';
  const question={id:'question',role:'user',source:{kind:'user',label:{value:'original'}},content:[{type:'text',text:'question'}]};
  handle.agent.followup(question);question.id='changed';question.content[0].text='changed';question.source.label.value='changed';
  for(let i=0;handle.agent.status!=='running';i++){assert.ok(i<2000,'input publication did not start the question');await setImmediate();}
  assert.equal(handle.agent.status,'running');
  const notified=Promise.withResolvers();
  ctx.on('session/event',(session,event)=>{if(session===handle.agent.session)notified.resolve(event);});
  const change={seq:0,time:2,type:'model/selection',data:selection};states.get('child').events.push(change);
  states.get('child').revision++;for(const notify of changes)notify();
  const observed=await notified.promise;
  assert.deepEqual(observed,{...change,seq:observed.seq},'the owned observer emits committed native changes at the application cursor');
  assert.equal(handle.agent.session.eventAt(observed.seq),observed);
  gate=Promise.withResolvers();let closed=false;
  const closing=owner.dispose().then(()=>{closed=true;});
  while(!seen.some(([method])=>method==='application.cancel'))await setImmediate();
  assert.equal(closed,false);assert.equal(ctx.agents.get('child'),handle.agent);
  assert.ok(!lifecycle.includes('scope-disposed'));
  assert.throws(()=>handle.agent.followup({}),/retired|text user/);
  drain=Promise.withResolvers();gate.resolve();
  while(!seen.some(([method,args])=>method==='application.inbox'&&args.operation.type==='wait_idle'))await setImmediate();
  assert.equal(closed,false);assert.ok(!lifecycle.includes('scope-disposed'),'cancellation admission is not driver cleanup');
  drain.resolve();await closing;await handle.dispose();
  assert.equal(ctx.agents.get('child'),undefined);assert.equal(ctx.agents.get('parent'),parent);
  assert.deepEqual([...draftOwners.keys()],['parent']);
  assert.equal(lifecycle.at(-1),'scope-disposed');
  assert.equal(seen.filter(([method])=>method==='application.cancel').length,1);
  assert.equal(seen.filter(([method,args])=>method==='application.inbox'&&args.operation.type==='wait_idle').length,1);
  let rolledBack=false;
  await assert.rejects(scope.runOwned(()=>ctx.agents.resume({resumeSessionId:'child',setup(agentCtx){
    agentCtx.effect(()=>()=>{rolledBack=true;});throw Error('setup rejected');
  }})),/setup rejected/);
  assert.equal(rolledBack,true);assert.equal(ctx.agents.get('child'),undefined);
  const owner2=ctx.plugin({inject:['agents'],apply(){}});await owner2;
  const setupEntered=Promise.withResolvers(),setupRelease=Promise.withResolvers();
  const pending=scope.runOwned(()=>owner2.ctx.agents.resume({resumeSessionId:'child',async setup(){
    setupEntered.resolve();await setupRelease.promise;
  }}));
  const rejected=assert.rejects(pending,/disposed|retired|active/);
  await setupEntered.promise;
  await agents.sharedBlankChanged(null);
  const retiring=owner2.dispose();setupRelease.resolve();
  await rejected;await retiring;
  assert.equal(ctx.agents.get('child'),undefined);assert.equal(agents.get('child'),undefined);
  assert.deepEqual([...draftOwners.keys()],['parent'],'failed and interrupted setup release native draft owners');
  const owner3=ctx.plugin({inject:['agents'],apply(){}});await owner3;
  retaining=Promise.withResolvers();
  const acquisition=scope.runOwned(()=>owner3.ctx.agents.resume({resumeSessionId:'child',
    setup(){assert.fail('a retired owner must not enter setup');}}));
  const acquisitionRejected=assert.rejects(acquisition,/disposed|retired|active/);
  await retaining.promise;
  await assert.rejects(scope.runOwned(()=>ctx.agents.resume({resumeSessionId:'child'})),/already attached/);
  const joined=assert.rejects(scope.runOwned(()=>agents.ensure('child')),/disposed|retired|active/);
  assert.deepEqual([...draftOwners.keys()],['parent','child']);
  await owner3.dispose();await acquisitionRejected;await joined;
  assert.equal(ctx.agents.get('child'),undefined);assert.equal(agents.get('child'),undefined);
  assert.deepEqual([...draftOwners.keys()],['parent'],'disposal cancels acquisition and releases its accepted native owner');
  retaining=undefined;
  const shared={...initial('shared'),shared:true,revision:0};states.set('shared',shared);
  const published=[];
  ctx.on('agent/created',({agent,source})=>{published.push([agent.id,source,ctx.agents.get(agent.id)===agent]);});
  const blank=await scope.runOwned(signal=>agents.ensure('shared',signal,'startup'));
  assert.equal(await scope.runOwned(signal=>agents.ensure('shared',signal,'resume')),blank);
  assert.deepEqual(published,[['shared','startup',true]]);
  await agents.sharedBlankChanged(null);
  const operations=()=>seen.filter(([,args])=>args.session_id==='shared').map(([,args])=>args.operation.type);
  assert.deepEqual(operations(),[],'an idle shared mirror holds no native wait or owner');
  shared.revision++;
  await agents.sharedBlankChanged('shared');
  await agents.sharedBlankChanged('shared');
  assert.deepEqual(operations(),['retain_draft','wait_draft']);
});

test('Agent capture retries draft publication and then reuses the durable inbox history',async()=>{
  let calls=0,metadataReads=0;
  const meta={selection_cursor:{kind:'durable',fact_seq:5,control_seq:7},through:5};
  const scope={inbox:{capture:async()=>++calls===1?{kind:'draft',revision:1,pending:[]}:
    {kind:'durable',cursor:{fact_seq:5,control_seq:7},history:meta,pending:[]}}};
  const history={metadata:async()=>{assert.equal(++metadataReads,1);return {selection_cursor:{kind:'durable',fact_seq:8,control_seq:9},through:8};},
    captureAgent:async(_id,meta)=>{
      assert.equal(meta.through,5);assert.deepEqual(meta.selection_cursor,{kind:'durable',fact_seq:5,control_seq:7});
      return {session:{id:'same'},options:{provider:'native',model:'at-cut'}};
    }};
  assert.deepEqual((await captureAgentView(scope,history,'same')).options,{provider:'native',model:'at-cut'});
  assert.equal(calls,2);
  assert.equal(metadataReads,1,'only the draft requires a separate metadata read');
});

test('durable Agent capture retries when another reader advanced the shared owner',async()=>{
  let captures=0,projected=0;
  const scope={inbox:{capture:async()=>{
    const fact_seq=++captures,control_seq=captures;
    return {kind:'durable',pending:[],cursor:{fact_seq,control_seq},
      history:{through:fact_seq,selection_cursor:{kind:'durable',fact_seq,control_seq}}};
  }}};
  const history={metadata(){assert.fail('durable capture must not open history again');},
    captureAgent:async(_id,meta)=>{
      projected++;
      return {session:{id:'same'},options:{at:meta.through},
        sourceCursor:{kind:'durable',fact_seq:2,control_seq:2}};
    }};
  const view=await captureAgentView(scope,history,'same');
  assert.equal(captures,2);assert.equal(projected,2);
  assert.equal(view.options.at,2);assert.equal(view.inbox.cursor.fact_seq,2);
});
