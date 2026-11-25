import {nativeSubmission} from '../fixtures/native-submission.mjs';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {createApplication} from '../../src/application/application.mjs';
import {provideHttp} from '../fixtures/application-http.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {workspaceController} from '../../src/workbench/workspace-controller.mjs';
import {sessionController} from '../../src/workbench/session-controller.mjs';
import {catalogObserver} from '../../src/workbench/catalog.mjs';
import {packagedPresetPlugins,workbenchProfile} from '../../src/workbench/profile.mjs';
import {workbenchPresetRegistry} from '../../src/workbench/presets.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('chat prompts record the Typert caller and canonical time zone before attachment admission',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const {principalOf,RemoteError}=await load('dsh-typert-protocol');
  const {canonicalClientTimeZone}=await load('dsh-util-time');
  class Service {constructor(ctx){this.ctx=ctx;}}
  const calls=[],scope=applicationSessions(async(method,args)=>{
    assert.equal(method,'application.submit');
    calls.push(await nativeSubmission(args,scope));
    return {session_id:args.session_id,message_id:args.message_id,accepted_control_seq:1};
  });
  t.after(()=>scope.close());
  const dispatch=await scope.prepare({url:'/api/session/prompt'},'authorized-test-request');
  const Controller=sessionController({TypertRemoteService:Service,RemoteError,principalOf,canonicalClientTimeZone},scope);
  const request={sessionId:'source',requestId:'request',mode:'queue',content:[{type:'text',text:'hello'}],clientTimeZone:'Asia/Chongqing'};
  const reader={kind:'share-viewer',shareId:'share',actor:{providerId:'fixture',tenantId:'tenant',subjectId:'reader'}};
  const signal=new AbortController().signal;
  for(const principal of [{kind:'owner'},reader]){
    const controller=new Controller({invocation:{peer:{principal}}});
    assert.deepEqual(await dispatch(()=>controller.prompt(request,signal)),{accepted:true});
    assert.deepEqual(calls.at(-1).attribution.source,{kind:'user',rpcId:'request',clientTimeZone:canonicalClientTimeZone(request.clientTimeZone),
      ...(principal===reader?{principal:reader}:{})});
    await assert.rejects(dispatch(()=>controller.prompt({...request,content:[{type:'image'}],clientTimeZone:'invalid'},signal)),
      error=>error.code==='session/invalid-time-zone');
    await assert.rejects(dispatch(()=>controller.prompt({...request,content:[{type:'text',text:'   '}]},signal)),
      error=>error.code==='gateway/bad-request');
  }
  assert.equal(calls.length,2);
});

test('named creates publish the Agent in arrival order and a rejected claim releases its successor',async()=>{
  const gate=Promise.withResolvers(),entered=Promise.withResolvers(),calls=[],published=[],registry=new Map();
  class Base {constructor(ctx){this.ctx=ctx;}}
  const scope={
    runOwned:run=>run(),
    async create({sessionId,preset}){
      calls.push(preset);
      if(preset==='failed'){entered.resolve();await gate.promise;throw Error('unavailable preset');}
      return {id:sessionId,reused:registry.has(sessionId),preset,summary:{id:sessionId}};
    },
  };
  const Service=sessionController({TypertRemoteService:Base},scope,undefined,undefined,(id,_signal,source)=>{
    const agent={session:{preset:source==='startup'?'from-created-hook':'again'}};
    published.push(source);registry.set(id,agent);return agent;
  });
  const controller=new Service({get:key=>key==='agentPresets'?{presetForSession:session=>session.preset}:registry,
    emit:(_event,row)=>assert.ok(row.agentAvailable)});
  const claim=preset=>controller.create({sessionId:'one',preset});
  const failed=assert.rejects(claim('failed'),/unavailable preset/);
  await entered.promise;
  const created=claim('new'),reused=claim('again');
  assert.deepEqual(calls,['failed']);
  gate.resolve();await failed;
  assert.equal((await created).agentPreset,'from-created-hook');assert.equal((await reused).agentPreset,'again');
  assert.deepEqual(calls,['failed','new','again']);assert.deepEqual(published,['startup','resume']);
});

test('the standard workbench serves whole-history statistics and navigable turn coordinates',{skip:!root},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-workbench-stats-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const modules={directory:name=>dirname(require.resolve(name+'/package.json'))};
  const profile=await workbenchProfile(modules,await load('dsh-app-boot'),dir);
  const ctx=new (await load('cordis')).Context();t.after(()=>ctx.fiber.dispose());
  await ctx.plugin((await load('dsh-session')).default);await ctx.plugin((await load('dsh-session-projection')).default);
  for(const id of ['session-stats','session-turn-outline','token-meter']){
    const row=profile.rows.find(entry=>entry.id===id);assert.ok(row,id);
    const plugin=await import(pathToFileURL(require.resolve(row.name)));
    await ctx.plugin(plugin.default??plugin,row.config);
  }
  const session=ctx.sessions.create('long-history');
  session.append('request/context',{provider:'fixture',model:'configured',contextWindow:8192});
  const coordinates=[];
  for(let turn=1;turn<=45;turn++){
    coordinates.push([turn,session.append('turn/start',{turn}).seq]);
    session.append('step/start',{turn,step:1});session.append('step/end',{turn,step:1});
    session.append('turn/end',{turn,reason:{kind:'completed'}});
  }
  const {sessionStats:{turns,steps},turnOutline,contextPressure}=ctx.sessionProjections.snapshot(session).values;
  assert.deepEqual(ctx.tokenMeter.contextPressure(session),{contextWindow:8192});
  assert.equal(contextPressure.contextWindow,8192);
  assert.deepEqual({turns,steps},{turns:45,steps:45});
  assert.deepEqual(turnOutline.map(entry=>[entry.turn,entry.seq]),coordinates);
  assert.ok(!ctx.sessionProjections.summaryKeys().has('turnOutline'));
});

test('the workbench skill registry discovers and withdraws an original bundle provider',{skip:!root},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-workbench-skills-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve(name)));
  const modules={directory:name=>dirname(require.resolve(name+'/package.json'))};
  const profile=await workbenchProfile(modules,await load('@deepseek-ai/dsh-app-boot'),dir);
  const row=profile.rows.find(entry=>entry.name==='@deepseek-ai/dsh-skill');assert.ok(row);
  const ctx=new (await load('@deepseek-ai/cordis')).Context();t.after(()=>ctx.fiber.dispose());
  await ctx.plugin((await load(row.name)).default,row.config).await();
  const office=profile.rows.find(entry=>entry.id==='skill-office');assert.ok(office);
  const {interpolate}=await load('@deepseek-ai/cordis-plugin-loader');
  const officeProvider=ctx.plugin(await load(office.name),interpolate({ctx},office.config));await officeProvider.await();
  const officeSkill=await ctx.skills.get('office');
  assert.equal(officeSkill.provider,'dsh-office');
  assert.match(officeSkill.content,/existing Python/);
  await officeProvider.dispose();assert.equal(await ctx.skills.get('office'),undefined);
  const scopes=await load('@deepseek-ai/dsh-scope');
  ctx.baseUrl=pathToFileURL(join(root,'package.json')).href;
  await ctx.plugin((await load('@deepseek-ai/cordis-plugin-loader')).default);
  ctx.loader.internal={import:load,resolveSync:name=>({url:pathToFileURL(require.resolve(name)).href})};
  ctx.loader.builtins.group=(await load('@deepseek-ai/cordis-plugin-group')).default;
  await ctx.plugin((await load('@deepseek-ai/dsh-session')).default);
  await ctx.plugin((await load('@deepseek-ai/dsh-session-projection')).default);
  await ctx.plugin((await load('@deepseek-ai/dsh-agent')).AgentRegistry);
  const native={withCaller:fn=>fn(),readPresets:async()=>({presets:['standard','minimal','ptc'].map(id=>({id,is_default:id==='standard'}))}),
    resolvePreset:async(id='standard')=>['standard','minimal','ptc'].includes(id)?{id}:null,
    selectPreset:async(_session,id)=>({selected:id,changed:true})};
  const Registry=workbenchPresetRegistry((await load('@deepseek-ai/dsh-agent-preset-registry')).default,
    (await load('@deepseek-ai/dsh-typert-protocol')).RemoteError,native,async()=>{},scopes,
    await packagedPresetPlugins(ctx,profile.rows,load));
  await ctx.plugin(Registry,{default:'standard'});
  const current=session=>ctx.sessionProjections.snapshot(session).values.agentPreset;
  assert.equal(current(ctx.sessions.create('no-preset')),null);
  const session=ctx.sessions.create('changed-preset',{meta:{agentPreset:'minimal'}});
  assert.equal(current(session),'minimal');
  session.append('agent-preset/selected',{agentPreset:'standard'});
  assert.equal(current(session),'standard');
  const agent={id:session.id,session},world=scopes.createScope(ctx,agent);agent.ctx=world.ctx;
  t.after(()=>world.dispose());
  const cold=await ctx.agentPresets.acquireScope('standard');
  t.after(()=>cold[Symbol.asyncDispose]());
  assert.equal((await ctx.skills.get('dsh-doc',{scope:cold.key})).provider,'filesystem');
  await ctx.agentPresets.bindSession(agent,'standard');
  assert.equal(scopes.scopeParentOf(agent),cold.key);
  const read=()=>ctx.skills.get('dsh-doc',{scope:agent});
  assert.equal((await read()).provider,'filesystem');
  assert.equal(await ctx.skills.get('dsh-doc'),undefined);
  const local=join(dir,'.agents','skills','workspace-only');await mkdir(local,{recursive:true});
  await writeFile(join(local,'SKILL.md'),'---\nname: workspace-only\ndescription: Owned by native discovery\n---\nFixture');
  assert.deepEqual((await ctx.skills.list({scope:agent,cwd:dir})).map(skill=>skill.name),['dsh-doc']);
  const select=preset=>ctx.agentPresets.select(agent,preset);
  await select('ptc');assert.equal((await read()).provider,'filesystem');
  await select('minimal');assert.equal(await read(),undefined);
  await select('standard');assert.equal((await read()).provider,'filesystem');
  await Promise.all([select('minimal'),select('ptc')]);assert.equal((await read()).provider,'filesystem');
  assert.equal(current(session),'ptc');
  session.append('agent-preset/selected',{agentPreset:'minimal'});
  await ctx.agentPresets.bindSession(agent,'minimal',true);
  assert.equal(await read(),undefined);
  assert.equal((await ctx.skills.get('dsh-doc',{scope:cold.key})).provider,'filesystem');
  const provider=ctx.plugin(await load('@deepseek-ai/dsh-skill-badge'));await provider.await();
  assert.ok((await ctx.skills.list()).some(skill=>skill.name==='dsh-badge'));
  assert.match((await ctx.skills.get('dsh-badge')).content,/726×120/);
  await provider.dispose();assert.equal(await ctx.skills.get('dsh-badge'),undefined);
});
test('follow opens authorized history before optional independent Agent startup',async()=>{
  const activation=Promise.withResolvers(),failure=Promise.withResolvers(),starts=[],reads=[];
  const app=new AbortController();
  class Base {constructor(ctx){this.ctx=ctx;}}
  const history={async *follow({address}) {
    if(address.sessionId==='denied')throw Error('No Session access');
    yield {type:'snapshot',header:address.sessionId==='child-by-id'?{origin:'subagent'}:{}};
  }};
  const scope={runOwned:fn=>fn(app.signal)};
  const Service=sessionController({TypertRemoteService:Base},scope,history,{
    async observe(id,signal){reads.push(id);await new Promise(r=>signal.addEventListener('abort',r,{once:true}));}
  },async(id,signal)=>{starts.push(id);assert.equal(signal,app.signal);await activation.promise;});
  const controller=new Service({get:()=>new Map([['resident',{}]]),emit:(...args)=>failure.resolve(args)});
  async function read(address,active){
    const reader=new AbortController(),frames=controller.follow({address,activate:active},reader.signal);
    try {assert.equal((await frames.next()).value.type,'snapshot');}
    finally {reader.abort();await frames.return();}
  }
  const addr=sessionId=>({kind:'session',sessionId});
  for(const active of [undefined,false])await read(addr('passive'),active);
  await read(addr('resident'),true);
  await read(addr('child-by-id'),true);
  await read({kind:'subagent',childSessionId:'child',parentSessionId:'parent'},true);
  await assert.rejects(read(addr('denied'),true),/No Session access/);
  assert.deepEqual(starts,[]);
  await read(addr('cold'),true);
  assert.deepEqual(reads,['passive','passive','resident','child-by-id','cold']);
  assert.deepEqual(starts,['cold']);
  activation.reject(Error('Agent unavailable'));
  assert.deepEqual(await failure.promise,['api-session/error','cold','Agent unavailable']);
});

test('rename uses the authorized Session and returns the title service event coordinate',async()=>{
  const session={id:'one'},calls=[];
  class SessionTitleInvalidError extends Error {}
  class RemoteError extends Error {
    constructor(code,message,data){super(message);Object.assign(this,{code,data});}
  }
  class TypertRemoteService {constructor(ctx){this.ctx=ctx;}}
  const lookupError=Error('Session not granted');
  const scope={async lookupAgent(id){
    if(id!==session.id)throw lookupError;
    return {session};
  }};
  const titles={rename(target,title){
    assert.equal(target,session);calls.push(title);
    if(!title.trim())throw new SessionTitleInvalidError('Title must contain visible characters');
    return {title:'normalized by DSH',eventSeq:0};
  }};
  const Service=sessionController({TypertRemoteService,RemoteError,SessionTitleInvalidError},scope);
  const controller=new Service({get:key=>key==='sessionTitle'?titles:undefined});
  const rename=(id,title)=>controller.rename({sessionId:id,title});
  assert.deepEqual(await rename('one',' raw title '),{title:'normalized by DSH',seq:0});
  await assert.rejects(rename('one',' '),{code:'session/title-invalid',data:{sessionId:'one'}});
  await assert.rejects(rename('other','ungranted'),error=>error===lookupError);
  assert.deepEqual(calls,[' raw title ',' ']);
});

test('confirmed archive uses the native writer before stop and follow-up, and restore waits for both',async()=>{
  const started=Promise.withResolvers(),release=Promise.withResolvers(),calls=[],warnings=[];
  const scope={workspace:async operation=>{
    calls.push(operation.type);
    if(operation.type==='archive'){
      assert.equal(operation.stop_activity,true);
      return {status:'applied',changed:true,archivedSessionIds:['s']};
    }
    if(operation.type==='archive_activity')return {status:'applied',changed:false,archivedSessionIds:['s']};
    assert.equal(operation.type,'unarchive');
    return {status:'applied',changed:true,archivedSessionIds:[]};
  }};
  const Service=workspaceController(class {constructor(ctx){this.ctx=ctx;}},scope,Error);
  const workspaces=new Service({logger:{warn:text=>warnings.push(text)},
    parallel:async(event,{sessionId})=>{
      assert.equal(sessionId,'s');calls.push(event);
      if(event==='workspace/session-stop'){started.resolve();await release.promise;throw Error('plugin stop failed');}
      if(event==='workspace/session-archived')throw Error('plugin follow-up failed');
    }});
  const archive=workspaces.archiveSession({sessionId:'s',stopActivity:true});
  await started.promise;
  const restore=workspaces.unarchiveSession({sessionId:'s'});
  await Promise.resolve();assert.deepEqual(calls,['archive','workspace/session-stop']);
  release.resolve();
  assert.deepEqual(await archive,{archivedSessionIds:['s']});
  assert.deepEqual(await restore,{archivedSessionIds:[]});
  assert.deepEqual(calls,['archive','workspace/session-stop','workspace/session-archived','archive_activity','workspace/session-unarchiving','unarchive']);
  assert.ok(warnings.some(line=>line.includes('plugin stop failed')));
  assert.ok(warnings.some(line=>line.includes('plugin follow-up failed')));
});

test('a rejected unarchiving listener keeps the session archived and a retry waits for it',async()=>{
  let archived=true,attempts=0;
  const changes=[];
  const scope={workspace:async ({type})=>{
    if(type==='archive_activity')return {status:archived?'applied':'ready',activity:[],archivedSessionIds:archived?['s']:[]};
    assert.equal(type,'unarchive');changes.push(archived);archived=false;return {archivedSessionIds:[]};
  }};
  const Service=workspaceController(class {constructor(ctx){this.ctx=ctx;}},scope,Error);
  const controller=new Service({parallel:async(event,{sessionId})=>{
    assert.equal(event,'workspace/session-unarchiving');assert.equal(sessionId,'s');assert.ok(archived);
    if(++attempts===1)throw Error('cleanup pending');
  }});
  await assert.rejects(controller.unarchiveSession({sessionId:'s'}),/cleanup pending/);
  assert.ok(archived);assert.deepEqual(changes,[]);
  assert.deepEqual(await controller.unarchiveSession({sessionId:'s'}),{archivedSessionIds:[]});
  assert.deepEqual(await controller.unarchiveSession({sessionId:'s'}),{archivedSessionIds:[]});
  assert.equal(attempts,2);assert.deepEqual(changes,[true,false]);
});

test('an activity first observed by the native archive writer is returned to the caller',async()=>{
  const activity=[{kind:'turn'}],calls=[];
  const scope={workspace:async ({type})=>{
    calls.push(type);return {status:'ready',activity:type==='archive'?activity:[]};
  }};
  const Service=workspaceController(class {constructor(ctx){this.ctx=ctx;}},scope,
    class extends Error {constructor(code,_message,data){super(code);Object.assign(this,{code,data});}});
  const controller=new Service({waterfall:async(_event,_args,next)=>next()});
  await assert.rejects(controller.archiveSession({sessionId:'s'}),{code:'workspace/session-active',data:{sessionId:'s',activity}});
  assert.deepEqual(calls,['archive_activity','archive']);
});

test('base workbench serves authorized cold pages through published Typert without a registry importer', {skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-workbench-list-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  await mkdir(join(profile,'node_modules'));
  await symlink(join(root,'node_modules/@deepseek-ai'),join(profile,'node_modules/@deepseek-ai'),process.platform==='win32'?'junction':'dir');
  const require=createRequire(join(root,'package.json')),key=randomBytes(32).toString('hex');
  const registered=new Map([['mirror',{status:'running'}]]);
  const sent=[],archives=new Set(),activityQueries=[],stops=[],nativeStops=[],archivedEvents=[];
  const scope=applicationSessions(async(method,args)=>{
    const {request,after}=args;
    if(method==='application.actor'){
      assert.equal(request,'issued-request');assert.equal(args.session_id,'blank-draft');
      return {id:args.session_id,cwd:profile};
    }
    if(method==='application.model.select'){
      assert.equal(request,'issued-request');assert.equal(args.session_id,'one');
      assert.match(args.request_id,/^[a-f0-9-]{36}$/);sent.push(args);
      return {selected:args.selection};
    }
    if(method==='application.workspaces'){
      assert.equal(request,'issued-request');
      switch(args.operation.type){
      case 'drafts':return {items:['one','blank-native','fork-native'].map(id=>({id,workspace:'a'.repeat(64),cwd:profile,
        updatedAt:2,blank:id!=='fork-native',running:false})),next:null};
      case 'unarchive':return {archivedSessionIds:[]};
      case 'archive_activity':{
        const {session}=args.operation;
        if(session==='missing')return {status:'unknown'};
        if(archives.has(session))return {status:'applied',archivedSessionIds:[...archives]};
        const activity=[];
        if(session==='working')activity.push({kind:'job',items:[{id:'active',label:'Native label'},{id:'second',label:'Bash'}]});
        if(session==='working'||session==='mirror')activity.push({kind:'turn'});
        if(session==='children')activity.push({kind:'subagent',items:[{id:'a',label:'A'},{id:'b',label:'B'}]});
        return {status:'ready',activity};
      }
      case 'archive':{
        const {session}=args.operation;
        if(session==='missing')return {status:'unknown'};
        const changed=!archives.has(session);
        if(changed&&['working','mirror'].includes(session)){
          if(!args.operation.stop_activity)return {status:'ready',activity:[{kind:'turn'}]};
          nativeStops.push(session);
        }
        archives.add(session);
        return {status:'applied',changed,archivedSessionIds:[...archives]};
      }
      case 'set_pin':{
        const {session,pinned}=args.operation;
        if(session==='missing'&&pinned)return {status:'unknown'};
        if(session==='archived'&&pinned)return {status:'archived'};
        return {status:'applied',pinnedSessionIds:pinned?[session]:[]};
      }
      case 'rename': return {id:'a'.repeat(64),path:profile,title:'Renamed',created:1,updated:3,
        sessions:['fork-native','blank-native','one']};
      case 'list':return {items:[{id:'a'.repeat(64),path:profile,title:'Renamed',created:1}],next:null,order:['a'.repeat(64)]};
      case 'insert_before':return args.operation.id==='a'.repeat(64) && (!args.operation.before || args.operation.before==='a'.repeat(64))
        ?{status:'applied',ids:['a'.repeat(64)]}:{status:'unknown',id:args.operation.id==='a'.repeat(64)?args.operation.before:args.operation.id};
      case 'membership':return {members:[{workspace:'a'.repeat(64),session:'one',account_position:0,archived:false,pinned:true,last_activity_ms:'3'}],next:null};
      default:throw Error('unexpected workspace operation');
      }
    }
    if(method==='application.create') {
      assert.equal(request,'issued-request');
      assert.match(args.fresh,/^session-[a-f0-9-]{36}$/);
      if(args.fork)assert.deepEqual(args.fork,{source_session_id:'one',point:{kind:'through_turn',turn_id:'native-turn'},turns:'all'});
      else {
        assert.equal(args.requested,'blank-draft');
        assert.equal(args.cwd,profile);
        assert.equal(args.preset,'standard');
      }
      const id=args.requested??args.fresh;
      return {id,preset:'standard',summary:{id,cwd:profile,updatedAt:10,blank:!args.fork,running:false}};
    }
    if(method==='application.cancel') {
      assert.deepEqual(args,{request:'issued-request',session_id:'one',keep_inbox:true});
      return {session_id:'one',receipt:{accepted:true,already_terminal:false}};
    }
    if(method==='application.submit') {
      args=await nativeSubmission(args,scope);
      sent.push(args);
      return {session_id:args.session_id,message_id:args.message_id,accepted_control_seq:3};
    }
    assert.equal(method,'application.sessions');assert.equal(request,'issued-request');
    const id=after?'two':'one';
    return {items:[{id,cwd:profile,updatedAt:after?3:1,blank:false,running:false}],next:after?null:{token:'next'}};
  },{owner:'application-owner',registered:id=>registered.get(id)});
  const session='@deepseek-ai/dsh-api-session-controller',hostModules=new Map();
  const modules={entry:name=>require.resolve(name),directory:name=>dirname(require.resolve(name+'/package.json'))};
  const app=await createApplication({profile,modules,hostModules,provide:async(ctx,load)=>{
    await provideHttp(ctx,load,key,scope);
    const protocol=await load('@deepseek-ai/dsh-typert-protocol');
    const {TypertRemoteService,RemoteError}=protocol;
    hostModules.set(session,sessionController({...protocol,...await load('@deepseek-ai/dsh-util-time')},scope,
      {forkTurn:async()=> 'native-turn'},undefined,(id,signal,source)=>{
        signal.throwIfAborted();assert.equal(source,'startup');registered.set(id,{status:'idle',session:{id}});
      }));
    hostModules.set('@deepseek-ai/dsh-api-workspace-controller',workspaceController(TypertRemoteService,scope,RemoteError));
    ctx.provide('agents',{get:id=>registered.get(id)});
    ctx.provide('profileContext',{name:'contract',dir:profile,installAnchor:join(root,'package.json')});
    await ctx.plugin((await load('@deepseek-ai/dsh-app-boot')).PluginPackages);
  }});
  t.after(()=>app.close());
  const entries=['dsh-typert-registry','dsh-typert-loader','dsh-api-remote-access','dsh-api-gateway','dsh-api-remotes','dsh-api-session-controller','dsh-api-workspace-controller'];
  const boot=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
  const selected=await workbenchProfile(modules,boot,profile);
  await app.reconcile([{insert:selected.rows.filter(row=>entries.some(name=>row.name==='@deepseek-ai/'+name))}]);
  const additions=[];app.ctx.on('api-session/added',row=>additions.push(row));
  const lifetime=new AbortController();t.after(()=>lifetime.abort());
  const host=new URL(app.ctx.webServer.getOrigin()).host;
  const peer=app.ctx.connection.admit({headers:{host,'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key}}).peer;
  assert.equal(peer.principal.kind,'owner');
  const observers=[0,1].map(()=>app.ctx.typertGateway.openRemoteEvents({args:{}},lifetime.signal,peer));
  for(const observer of observers)await observer.next();
  const result=await fetch(app.ctx.webServer.getOrigin()+'/api/session/list',{method:'POST',
    headers:{'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/list',payload:{args:{_request:{}}}})});
  const text=await result.text();
  assert.equal(result.status,200,text);
  const body=JSON.parse(text);
  assert.deepEqual(body.result?.value?.items?.map(row=>row.sessionId),['two','blank-native','fork-native','one'],JSON.stringify(body));
  assert.equal(body.result.value.items.find(row=>row.sessionId==='fork-native').blank,false);
  for(const reasoningEffort of [undefined,'high']){
    const selection={provider:'native',model:'chosen',...(reasoningEffort?{reasoningEffort}:{})};
    const reply=await fetch(app.ctx.webServer.getOrigin()+'/api/session/selectModel',{method:'POST',
      headers:{'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/selectModel',
        payload:{args:{request:{sessionId:'one',...selection}}}})});
    const result=await reply.json();
    assert.deepEqual(result.result?.value,{selected:selection},JSON.stringify(result));
    assert.deepEqual(sent.at(-1).selection,{model:{deployment:'native',model:'chosen'},
      ...(reasoningEffort?{reasoning_effort:reasoningEffort}:{})});
  }
  const create=await fetch(app.ctx.webServer.getOrigin()+'/api/session/create',{method:'POST',
    headers:{'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/create',payload:{args:{request:{
      sessionId:'blank-draft',cwd:profile,agentPreset:'standard'}}}})});
  const created=await create.json();
  assert.deepEqual(created.result?.value,{sessionId:'blank-draft',agentPreset:'standard'},JSON.stringify(created));
  const sessionLookup=app.ctx.typert.lookups.get('session');
  assert.equal(sessionLookup?.wire,'sessionId');assert.equal(sessionLookup.resource,'session');
  const requestScope=await scope.prepare({url:'/api/fixture',headers:{'x-rsi-upstream-request':'issued-request'}});
  assert.equal(await requestScope(()=>sessionLookup.resolve('blank-draft')),registered.get('blank-draft').session);
  const resource=app.ctx.typert.resources.get('session');
  const address=request=>resource.resolve({args:{request},parameters:[{wire:'request'}]});
  assert.equal(address({address:{kind:'subagent',childSessionId:'child'}}),'child');
  assert.equal(address({address:{kind:'session',sessionId:'blank-draft'}}),'blank-draft');
  assert.equal(address({sessionId:'blank-draft'}),'blank-draft');
  assert.throws(()=>address({sessionId:'one',address:{kind:'session',sessionId:'two'}}));
  assert.equal(resource.resolve({args:{id:'direct'},parameters:[{name:'sessionId',wire:'id'}]}),'direct');
  assert.deepEqual(additions,[{sessionId:'blank-draft',cwd:profile,updatedAt:10,blank:true,running:false,
    agentAvailable:true,formatStatus:'current'}]);
  for(const observer of observers){
    const {value}=await observer.next();assert.equal(value.event,'api-session/added');
    assert.deepEqual(value.args,[additions[0]]);
  }
  const fork=await fetch(app.ctx.webServer.getOrigin()+'/api/session/fork',{method:'POST',
    headers:{'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/fork',
      payload:{args:{request:{sessionId:'one'}}}})});
  const forked=await fork.json();assert.ok(forked.result?.ok,JSON.stringify(forked));
  assert.equal(additions.length,2);
  assert.deepEqual(additions[1],{...additions[0],sessionId:forked.result.value.sessionId,blank:false,agentAvailable:false});
  for(const observer of observers){
    const {value}=await observer.next();assert.equal(value.event,'api-session/added');
    assert.deepEqual(value.args,[additions[1]]);
  }
  const publish=catalogObserver(app.ctx);
  const unseen={id:'headless-session',updatedAt:20,cwd:profile,blank:false,running:true};
  publish([unseen]);
  for(const observer of observers){
    const {value}=await observer.next();assert.equal(value.event,'api-session/added');
    assert.equal(value.args[0].sessionId,unseen.id);assert.equal(value.args[0].running,true);
  }
  publish([{...unseen,running:false,updatedAt:21}]);
  for(const observer of observers){
    assert.equal((await observer.next()).value.event,'api-session/added');
    assert.deepEqual((await observer.next()).value.args,[unseen.id,false]);
    assert.deepEqual((await observer.next()).value.args,[unseen.id,21]);
  }
  publish([]);
  for(const observer of observers){
    const {value}=await observer.next();assert.equal(value.event,'api-session/removed');
    assert.deepEqual(value.args,[unseen.id]);await observer.return();
  }
  const schedule={kind:'schedule',items:[{id:'cron',label:'Daily'}]};
  app.ctx.on('workspace/session-activity',async({sessionId},next)=>{
    activityQueries.push(sessionId);
    const rest=await next();
    if(sessionId==='working')return [schedule,{kind:'job',items:[{id:'active',label:'Plugin worker'}]},...rest];
    if(sessionId==='children')return [{kind:'subagent',items:[{id:'a',label:'Plugin label'}]},...rest];
    return sessionId==='mirror'?[{kind:'turn'},...rest]:rest;
  });
  app.ctx.on('workspace/session-archived',({sessionId})=>{assert.ok(archives.has(sessionId));archivedEvents.push(sessionId);});
  app.ctx.on('workspace/session-stop',({sessionId})=>{
    assert.ok(archives.has(sessionId));stops.push(sessionId);
  });
  for(const [action,sessionId,expected,stopActivity] of [
    ['pinSession','one',{ok:true,value:{pinnedSessionIds:['one']}}],
    ['unpinSession','missing',{ok:true,value:{pinnedSessionIds:[]}}],
    ['unarchiveSession','missing',{ok:true,value:{archivedSessionIds:[]}}],
    ['pinSession','missing',{code:'session/not-found',details:{sessionId:'missing'}}],
    ['pinSession','archived',{code:'gateway/bad-request',details:{}}],
    ['archiveSession','missing',{code:'session/not-found',details:{sessionId:'missing'}}],
    ['archiveSession','missing',{code:'session/not-found',details:{sessionId:'missing'}},true],
    ['archiveSession','working',{code:'workspace/session-active',details:{sessionId:'working',activity:[
      schedule,{kind:'job',items:[{id:'active',label:'Plugin worker'},{id:'second',label:'Bash'}]},{kind:'turn'}]}}],
    ['archiveSession','children',{code:'workspace/session-active',details:{sessionId:'children',
      activity:[{kind:'subagent',items:[{id:'a',label:'Plugin label'},{id:'b',label:'B'}]}]}}],
    ['archiveSession','idle',{ok:true,value:{archivedSessionIds:['idle']}}],
    ['archiveSession','working',{ok:true,value:{archivedSessionIds:['idle','working']}},true],
    ['archiveSession','working',{ok:true,value:{archivedSessionIds:['idle','working']}},true],
    ['archiveSession','working',{ok:true,value:{archivedSessionIds:['idle','working']}}],
    ['archiveSession','mirror',{code:'workspace/session-active',details:{sessionId:'mirror',activity:[{kind:'turn'}]}}],
    ['archiveSession','mirror',{ok:true,value:{archivedSessionIds:['idle','working','mirror']}},true],
  ]){
    const method='workspace/'+action;
    const res=await fetch(app.ctx.webServer.getOrigin()+'/api/'+method,{method:'POST',
      headers:{'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args:{request:{sessionId,stopActivity}}}})});
    const {result}=await res.json();
    if(expected.ok)assert.deepEqual(result,expected);
    else {assert.equal(result.error.code,expected.code);assert.deepEqual(result.error.details,expected.details);}
  }
  assert.deepEqual(activityQueries,['working','children','idle','mirror']);
  assert.deepEqual(stops,['working','mirror']);
  assert.deepEqual(nativeStops,['working','mirror']);
  assert.deepEqual(archivedEvents,['idle','working','mirror']);
  const rename=await fetch(app.ctx.webServer.getOrigin()+'/api/workspace/rename',{method:'POST',
    headers:{'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'workspace/rename',payload:{args:{request:{workspaceId:'a'.repeat(64),title:'Renamed'}}}})});
  const renamed=await rename.json();
  assert.deepEqual(renamed.result?.value.workspace.sessionIds,['fork-native','blank-native','one'],JSON.stringify(renamed));
  assert.equal(renamed.result.value.workspace.updatedAt,new Date(3).toISOString());
  for(const [request,expected] of [
    [{workspaceId:'a'.repeat(64)},{ok:true,value:{workspaceIds:['a'.repeat(64)]}}],
    [{workspaceId:'a'.repeat(64),beforeWorkspaceId:'a'.repeat(64)},{ok:true,value:{workspaceIds:['a'.repeat(64)]}}],
    [{workspaceId:'absent'},{code:'workspace/not-found',id:'absent'}],
    [{workspaceId:'0'.repeat(64)},{code:'workspace/not-found',id:'0'.repeat(64)}],
    [{workspaceId:'a'.repeat(64),beforeWorkspaceId:'absent'},{code:'workspace/not-found',id:'absent'}],
  ]){
    const method='workspace/insertBefore';
    const response=await fetch(app.ctx.webServer.getOrigin()+'/api/'+method,{method:'POST',
      headers:{'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args:{request}}})});
    const {result}=await response.json();
    if(expected.ok)assert.deepEqual(result,expected);
    else {assert.equal(result.error.code,expected.code);assert.deepEqual(result.error.details,{workspaceId:expected.id});}
  }
  for(const mode of ['queue','steer']) {
    const requestId=randomUUID();
    const reply=await fetch(app.ctx.webServer.getOrigin()+'/api/session/prompt',{method:'POST',
      headers:{'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/prompt',payload:{args:{request:{
        sessionId:'one',requestId,mode,content:[{type:'text',text:'hello'}]}}}})});
    const result=await reply.json();
    assert.deepEqual(result.result?.value,{accepted:true},JSON.stringify(result));
    assert.deepEqual(sent.at(-1),{request:'issued-request',session_id:'one',message_id:requestId,
      delivery:mode==='queue'?'next_turn':'steer',content:[{kind:'text',text:'hello'}],
      attribution:{id:requestId,source:{kind:'user',rpcId:requestId}}});
  }
  const cancel=await fetch(app.ctx.webServer.getOrigin()+'/api/session/cancel',{method:'POST',
    headers:{'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/cancel',payload:{args:{request:{sessionId:'one'}}}})});
  const cancellation=await cancel.json();
  assert.deepEqual(cancellation.result?.value,{accepted:true},JSON.stringify(cancellation));
});
