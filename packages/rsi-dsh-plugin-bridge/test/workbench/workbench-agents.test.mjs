import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {workbenchAgents} from '../../src/workbench/agents.mjs';
import {captureAgentView} from '../../src/workbench/agent-view.mjs';
import {SessionProjectionJournal} from '../../src/session/session-projection-journal.mjs';
import {inputIntents} from '../../src/session/inbox/input-intents.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
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
    const state=states.get(id);return structuredClone({kind:'draft',session_id:id,revision:state.revision,
      active_turn_id:state.active_turn_id,pending:state.pending});
  };
  const owners=new Map();
  const history={metadata:async id=>({selection_cursor:{kind:'draft',revision:states.get(id).revision}}),
    owner:session=>owners.get(session.id),
    async captureAgent(id) {
      let owner=owners.get(id);
      if(!owner) {
        const journal=new SessionProjectionJournal(ctx,api,{header:{version:4,id,createdAt:1,cwd:process.cwd(),isSeeded:false}}, {save:async()=>{}});
        const input=inputIntents(journal,{command:(op,signal)=>scope.command(id,op,signal),
          submit:(value,signal)=>scope.submit(id,value,signal),transitions:()=>new Map(),inbox:{
          capture:signal=>scope.inbox.capture(id,signal),discardDraft:(ids,signal)=>scope.inbox.discardDraft(id,ids,signal),
          mutate:(mutation,signal)=>scope.inbox.mutate(id,mutation,signal)}});
        owner={journal,input,flush:()=>journal.flush(),driver:{ready:async()=>{}},model:()=>({next:selection})};
        owners.set(id,owner);
      }
      owner.journal.merge(states.get(id).events);return {options:selection,session:owner.journal.session};
    }};
  agents=await workbenchAgents(ctx,scope,history,await load('dsh-scope'),await load('dsh-agent'),api.snapshotJsonValue);
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
  await setupEntered.promise;const retiring=owner2.dispose();setupRelease.resolve();
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
});

test('Agent captures retry draft changes and use the inbox cut instead of newer model metadata',async()=>{
  let calls=0;
  const scope={inbox:{capture:async()=>++calls===1?{kind:'draft',revision:1,pending:[]}:
    {kind:'durable',cursor:{fact_seq:5,control_seq:7},pending:[]}}};
  const history={metadata:async()=>({selection_cursor:{kind:'durable',fact_seq:8,control_seq:9},through:8}),
    captureAgent:async(_id,meta)=>{
      assert.equal(meta.through,5);assert.deepEqual(meta.selection_cursor,{kind:'durable',fact_seq:5,control_seq:7});
      return {session:{id:'same'},options:{provider:'native',model:'at-cut'}};
    }};
  assert.deepEqual((await captureAgentView(scope,history,'same')).options,{provider:'native',model:'at-cut'});
  assert.equal(calls,2);
});
