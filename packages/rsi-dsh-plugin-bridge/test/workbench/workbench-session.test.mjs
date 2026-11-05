import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {createApplication} from '../../src/application/application.mjs';
import {provideHttp} from '../../src/application/http.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {workspaceController} from '../../src/workbench/workspace-controller.mjs';
import {sessionController} from '../../src/workbench/session-controller.mjs';
import {catalogObserver} from '../../src/workbench/catalog.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
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

test('restore waits for stop providers; a stop failure leaves the committed archive intact',async()=>{
  const started=Promise.withResolvers(),release=Promise.withResolvers(),calls=[],warnings=[];
  const scope={workspace:async({type})=>{
    calls.push(type);
    if(type==='archive')return {status:'applied',changed:true,archivedSessionIds:['s']};
    if(type==='unarchive')return {status:'applied',changed:true,archivedSessionIds:[]};
    throw Error('native stop failed');
  }};
  const Service=workspaceController(class {constructor(ctx){this.ctx=ctx;}},scope,Error);
  const workspaces=new Service({get:()=>undefined,logger:{warn:text=>warnings.push(text)},
    parallel:async()=>{started.resolve();await release.promise;throw Error('plugin stop failed');}});
  const archive=workspaces.archiveSession({sessionId:'s',stopActivity:true});
  await started.promise;
  const restore=workspaces.unarchiveSession({sessionId:'s'});
  await Promise.resolve();assert.deepEqual(calls,['archive','stop_archive_activity']);
  release.resolve();
  assert.deepEqual(await archive,{archivedSessionIds:['s']});
  assert.deepEqual(await restore,{archivedSessionIds:[]});
  assert.deepEqual(calls,['archive','stop_archive_activity','unarchive']);
  assert.ok(warnings.some(line=>line.includes('native stop failed')));
  assert.ok(warnings.some(line=>line.includes('plugin stop failed')));
});

test('published Typert gateway serves two authorized cold pages using the original session codec', {skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-workbench-list-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  await mkdir(join(profile,'node_modules'));
  await symlink(join(root,'node_modules/@deepseek-ai'),join(profile,'node_modules/@deepseek-ai'),process.platform==='win32'?'junction':'dir');
  const require=createRequire(join(root,'package.json')),key=randomBytes(32).toString('hex');
  const sent=[],archives=new Set(),activityQueries=[],stops=[],nativeStops=[];
  const scope=applicationSessions(async(method,args)=>{
    const {request,after}=args;
    if(method==='application.model.select'){
      assert.equal(request,'issued-request');assert.equal(args.session_id,'one');
      assert.match(args.request_id,/^[a-f0-9-]{36}$/);sent.push(args);
      return {selected:args.selection};
    }
    if(method==='application.workspaces'){
      assert.equal(request,'issued-request');
      switch(args.operation.type){
      case 'drafts':return {items:['one','blank-native','fork-native'].map(id=>({id,workspace:'ws',cwd:profile,
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
        archives.add(session);
        return {status:'applied',changed,archivedSessionIds:[...archives]};
      }
      case 'stop_archive_activity':
        assert.ok(archives.has(args.operation.session));
        nativeStops.push([args.operation.session,args.operation.stop_root]);return null;
      case 'set_pin':{
        const {session,pinned}=args.operation;
        if(session==='missing'&&pinned)return {status:'unknown'};
        if(session==='archived'&&pinned)return {status:'archived'};
        return {status:'applied',pinnedSessionIds:pinned?[session]:[]};
      }
      case 'rename': return {id:'ws'};
      case 'list':return {items:[{id:'ws',path:profile,title:'Renamed',created:1}],next:null};
      case 'membership':return {groups:['ws'],members:[{group:0,session:'one',archived:false,pinned:true,last_activity_ms:'3'}]};
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
      sent.push(args);
      return {session_id:args.session_id,message_id:args.message_id,accepted_control_seq:3};
    }
    assert.equal(method,'application.sessions');assert.equal(request,'issued-request');
    const id=after?'two':'one';
    return {items:[{id,cwd:profile,updatedAt:1,blank:false,running:false}],next:after?null:{token:'next'}};
  });
  const session='@deepseek-ai/dsh-api-session-controller',hostModules=new Map();
  const modules={entry:name=>require.resolve(name),directory:name=>dirname(require.resolve(name+'/package.json'))};
  const app=await createApplication({profile,modules,hostModules,provide:async(ctx,load)=>{
    await provideHttp(ctx,load,key,scope);
    const {TypertRemoteService,RemoteError}=await load('@deepseek-ai/dsh-typert-protocol');
    hostModules.set(session,sessionController({TypertRemoteService,RemoteError},scope,
      {forkTurn:async()=> 'native-turn'}));
    hostModules.set('@deepseek-ai/dsh-api-workspace-controller',workspaceController(TypertRemoteService,scope,RemoteError));
    ctx.provide('agents',{get:id=>id==='mirror'?{status:'running'}:undefined});
    ctx.provide('profileContext',{name:'contract',dir:profile,installAnchor:join(root,'package.json')});
    await ctx.plugin((await load('@deepseek-ai/dsh-app-boot')).PluginPackages);
  }});
  t.after(()=>app.close());
  const entries=['dsh-typert-registry','dsh-typert-loader','dsh-api-remote-access','dsh-api-gateway','dsh-api-remotes','dsh-api-session-controller','dsh-api-workspace-controller'];
  await app.reconcile([{insert:entries.map(id=>({id,name:'@deepseek-ai/'+id}))}]);
  const additions=[];app.ctx.on('api-session/added',row=>additions.push(row));
  const lifetime=new AbortController();t.after(()=>lifetime.abort());
  const peer=app.ctx.connection.admit({headers:{'x-rsi-upstream-key':key}}).peer;
  const observers=[0,1].map(()=>app.ctx.typertGateway.openRemoteEvents({args:{}},lifetime.signal,peer));
  for(const observer of observers)await observer.next();
  const result=await fetch(app.ctx.webServer.getOrigin()+'/api/session/list',{method:'POST',
    headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/list',payload:{args:{_request:{}}}})});
  const text=await result.text();
  assert.equal(result.status,200,text);
  const body=JSON.parse(text);
  assert.deepEqual(body.result?.value?.items?.map(row=>row.sessionId),['one','two','blank-native','fork-native'],JSON.stringify(body));
  assert.equal(body.result.value.items.find(row=>row.sessionId==='fork-native').blank,false);
  for(const reasoningEffort of [undefined,'high']){
    const selection={provider:'native',model:'chosen',...(reasoningEffort?{reasoningEffort}:{})};
    const reply=await fetch(app.ctx.webServer.getOrigin()+'/api/session/selectModel',{method:'POST',
      headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/selectModel',
        payload:{args:{request:{sessionId:'one',...selection}}}})});
    const result=await reply.json();
    assert.deepEqual(result.result?.value,{selected:selection},JSON.stringify(result));
    assert.deepEqual(sent.at(-1).selection,{model:{deployment:'native',model:'chosen'},
      ...(reasoningEffort?{reasoning_effort:reasoningEffort}:{})});
  }
  const create=await fetch(app.ctx.webServer.getOrigin()+'/api/session/create',{method:'POST',
    headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/create',payload:{args:{request:{
      sessionId:'blank-draft',cwd:profile,agentPreset:'standard'}}}})});
  const created=await create.json();
  assert.deepEqual(created.result?.value,{sessionId:'blank-draft',agentPreset:'standard'},JSON.stringify(created));
  assert.deepEqual(additions,[{sessionId:'blank-draft',cwd:profile,updatedAt:10,blank:true,running:false,
    agentAvailable:false,formatStatus:'current'}]);
  for(const observer of observers){
    const {value}=await observer.next();assert.equal(value.event,'api-session/added');
    assert.deepEqual(value.args,[additions[0]]);
  }
  const fork=await fetch(app.ctx.webServer.getOrigin()+'/api/session/fork',{method:'POST',
    headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/fork',
      payload:{args:{request:{sessionId:'one'}}}})});
  const forked=await fork.json();assert.ok(forked.result?.ok,JSON.stringify(forked));
  assert.equal(additions.length,2);
  assert.deepEqual(additions[1],{...additions[0],sessionId:forked.result.value.sessionId,blank:false});
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
      headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args:{request:{sessionId,stopActivity}}}})});
    const {result}=await res.json();
    if(expected.ok)assert.deepEqual(result,expected);
    else {assert.equal(result.error.code,expected.code);assert.deepEqual(result.error.details,expected.details);}
  }
  assert.deepEqual(activityQueries,['working','children','idle','mirror']);
  assert.deepEqual(stops,['working','mirror']);
  assert.deepEqual(nativeStops,[['working',true],['mirror',false]]);
  const rename=await fetch(app.ctx.webServer.getOrigin()+'/api/workspace/rename',{method:'POST',
    headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'workspace/rename',payload:{args:{request:{workspaceId:'ws',title:'Renamed'}}}})});
  const renamed=await rename.json();
  assert.deepEqual(renamed.result?.value.workspace.sessionIds,['fork-native','blank-native','one'],JSON.stringify(renamed));
  assert.equal(renamed.result.value.workspace.updatedAt,new Date(3).toISOString());
  for(const mode of ['queue','steer']) {
    const requestId=randomUUID();
    const reply=await fetch(app.ctx.webServer.getOrigin()+'/api/session/prompt',{method:'POST',
      headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/prompt',payload:{args:{request:{
        sessionId:'one',requestId,mode,content:[{type:'text',text:'hello'}]}}}})});
    const result=await reply.json();
    assert.deepEqual(result.result?.value,{accepted:true},JSON.stringify(result));
    assert.deepEqual(sent.at(-1),{request:'issued-request',session_id:'one',message_id:requestId,
      delivery:mode==='queue'?'next_turn':'steer',content:[{kind:'text',text:'hello'}]});
  }
  const cancel=await fetch(app.ctx.webServer.getOrigin()+'/api/session/cancel',{method:'POST',
    headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued-request','content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/cancel',payload:{args:{request:{sessionId:'one'}}}})});
  const cancellation=await cancel.json();
  assert.deepEqual(cancellation.result?.value,{accepted:true},JSON.stringify(cancellation));
});
