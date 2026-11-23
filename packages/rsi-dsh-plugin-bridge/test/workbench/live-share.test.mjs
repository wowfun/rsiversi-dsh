import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {createApplication} from '../../src/application/application.mjs';
import {provideHttp} from '../../src/application/http.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {sessionController} from '../../src/workbench/session-controller.mjs';
import {workspaceController} from '../../src/workbench/workspace-controller.mjs';
import {workbenchProfile} from '../../src/workbench/profile.mjs';
import {workbenchControl} from '../../src/workbench/control.mjs';

const cohort=process.env.RSI_DSH_MARKET_COHORT;
for(const restored of [false,true])test(`the published Live Share Host serves granted native rows after ${restored?'a cold restore':'enablement'}`,{skip:!cohort,timeout:60_000},async()=>{
  const require=createRequire(join(cohort,'package.json'));
  const liveshare='@deepseek-ai/dsh-experimental-liveshare';
  const {WebSocketServer}=createRequire(require.resolve(liveshare))('ws');
  const home=await mkdtemp(join(tmpdir(),'rsi-share-host-'));
  const key=randomBytes(32).toString('hex');
  const actor={providerId:'fixture',tenantId:'tenant',subjectId:'reader'};
  let authority={version:1,accessMode:'open',allowedSubjectIds:[],sessionMode:'view'};
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/__liveshare/requests' && req.headers.authorization==='Bearer fixture-token'){
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(authority));
    }else res.writeHead(404).end();
  });
  const sockets=new WebSocketServer({server});
  const connected=once(sockets,'connection',{signal:AbortSignal.timeout(45_000)});
  connected.catch(()=>{});
  const modules={entry:name=>require.resolve(name),directory:name=>dirname(require.resolve(name+'/package.json'))};
  const shared='source',hidden='other',workspace='a'.repeat(64),otherWorkspace='b'.repeat(64);
  const sessionIds=[shared,hidden],workspaceIds=[workspace,otherWorkspace];
  const scope=applicationSessions(async(method,{request,operation,session_id})=>{
    assert.equal(request,'native-application');
    if(method==='application.history'){
      assert.equal(session_id,shared);assert.equal(operation.type,'open');
      return {id:shared,created_at:1};
    }
    if(method==='application.sessions')return {items:sessionIds.map(id=>({id,updatedAt:1,blank:true,running:false})),next:null};
    if(method==='application.workspaces'){
      if(operation.type==='drafts')return {items:[],next:null};
      if(operation.type==='list')return {items:workspaceIds.map(id=>({id,path:home,title:id,created:1})),order:workspaceIds,next:null};
      if(operation.type==='membership')return {members:sessionIds.map((session,index)=>({workspace,session,archived:true,pinned:true,account_position:index,last_activity_ms:'1'})),next:null};
    }
    throw Error('Unexpected native read '+method);
  },{owner:'native-application'});
  const live=workbenchControl(async()=>{throw Error('unexpected native browser context');});
  for(const id of sessionIds)live.open(id,{asOfSeq:1,values:{}});
  let app;
  try{
    await mkdir(join(home,'node_modules'));
    await symlink(join(cohort,'node_modules/@deepseek-ai'),join(home,'node_modules/@deepseek-ai'),process.platform==='win32'?'junction':'dir');
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const relay='http://127.0.0.1:'+server.address().port,stateFile=join(home,'owner.json');
    await writeFile(stateFile,JSON.stringify({instanceId:'fixture-host',relayUrl:relay,shares:[{
      relay,shareId:'share',sessionId:shared,sessionTitle:'Source',accessMode:'open',sessionMode:'view',
      allowedSubjectIds:[],gatewayToken:'fixture-token',createdAt:new Date().toISOString(),
    }]}));
    const hostModules=new Map();
    let boot;
    app=await createApplication({modules,profile:home,hostModules,provide:async(ctx,load)=>{
      boot=await load('@deepseek-ai/dsh-app-boot');
      await provideHttp(ctx,load,key,scope);
      const protocol=await load('@deepseek-ai/dsh-typert-protocol');
      const history={control:live.control,
        async metadata(id,signal){return {...await scope.history(id,{type:'open'},signal),cwd:home};},
        async capture(_id,meta){return {header:meta,seq:13};},
        async page({address},signal){
          await scope.history(address.sessionId,{type:'open'},signal);
          return {cursor:-1,hasMore:false,records:[]};
        },
        async *follow({address},signal){
          const meta=await scope.history(address.sessionId,{type:'open'},signal);
          yield {type:'snapshot',header:{id:meta.id,version:4,createdAt:meta.created_at},cursor:-1,
            records:[],hasMore:false,projections:{asOfSeq:-1,values:{}}};
        },
      };
      hostModules.set('@deepseek-ai/dsh-api-session-controller',sessionController(protocol,scope,history));
      hostModules.set('@deepseek-ai/dsh-api-workspace-controller',workspaceController(protocol.TypertRemoteService,scope,protocol.RemoteError));
      ctx.provide('agents',{get:()=>undefined});
      ctx.provide('sessions',scope.sessions);
      ctx.provide('sessionTitle',{get:()=>assert.fail('Cold Session has no resident title projection')});
      ctx.provide('workspaceRegistry',{list:()=>[{id:workspace,sessionIds},{id:otherWorkspace,sessionIds:[]}]});
      ctx.provide('profileContext',{name:'share-test',dir:home,installAnchor:join(cohort,'package.json')});
      await ctx.plugin(boot.PluginPackages);
    }});
    const selected=await workbenchProfile(modules,boot,home);
    const required=['client-connection','typert-registry','typert-loader','api-remote-access','api-gateway','api-remotes','api-session-controller','api-workspace-controller'];
    const entries=selected.rows.filter(row=>required.some(name=>row.name==='@deepseek-ai/dsh-'+name));
    if(!restored)await app.reconcile([{insert:entries}]);
    await app.reconcile([{insert:entries},{insert:[{id:'liveshare',name:liveshare,config:{ownerStateFile:stateFile}}]}],{restore:restored});
    assert.ok(app.ctx.get('typertGateway'),'release Gateway is mounted');
    assert.ok(app.ctx.typert.local.get('session/list'),'release Session descriptors are loaded');
    const [socket,registration]=await connected;
    assert.equal(new URL(registration.url,relay).searchParams.get('shareId'),'share');
    let sequence=0;
    async function read(body){
      const id=++sequence,deadline=AbortSignal.timeout(10_000);
      socket.send(JSON.stringify({type:'share-rpc',id,body,actor}));
      for(;;){
        const [message]=await once(socket,'message',{signal:deadline});
        const frame=JSON.parse(message);
        if(frame.type==='share-rpc-res' && frame.id===id)return frame;
      }
    }
    const list=()=>read({op:'call',path:'/api/session/list',body:{type:'client-request',rpcId:'list',method:'session/list',payload:{args:{_request:{}}}}});
    const listing=await list();
    assert.equal(listing.status,200,JSON.stringify(listing));
    assert.deepEqual(listing.body.result?.value?.items.map(row=>row.sessionId),[shared],JSON.stringify(listing));
    const args={request:{address:{kind:'session',sessionId:shared}}};
    const page=await read({op:'call',path:'/api/session/page',body:{type:'client-request',rpcId:'history',method:'session/page',payload:{args}}});
    assert.deepEqual(page.body.result?.value,{cursor:-1,hasMore:false,records:[]},JSON.stringify(page));
    const stateArgs={request:{sessionId:shared}};
    const state=await read({op:'call',path:'/api/session/state',body:{type:'client-request',rpcId:'state',method:'session/state',payload:{args:stateArgs}}});
    const cold={cursor:12,active:false,running:false,queue:null,pendingInput:[]};
    assert.deepEqual(state.body.result?.value,cold,JSON.stringify(state));
    const states=await read({op:'stream-open',id:4,endpoint:'session/observeState',payload:{args:stateArgs}});
    assert.equal(states.status,200);
    const first=await read({op:'stream-next',id:4});
    assert.deepEqual(first.body.values,[cold],JSON.stringify(first));
    assert.equal((await read({op:'stream-cancel',id:4})).status,200);
    for(const [id,endpoint] of [[1,'workspace/follow'],[2,'session/control'],[3,'session/follow']]){
      const opening=await read({op:'stream-open',id,endpoint,payload:{args:id===3?args:{}}});
      assert.equal(opening.status,200,JSON.stringify(opening));
      const next=await read({op:'stream-next',id});
      assert.equal(next.status,200,JSON.stringify(next));
      const baseline=next.body.values?.[0];
      assert.equal(baseline?.type,id===3?'snapshot':'baseline',JSON.stringify(next));
      if(id===1){
        assert.deepEqual(baseline.value.items.map(row=>[row.workspaceId,row.sessionIds]),[[workspace,[shared]]]);
        assert.deepEqual(baseline.value.pinnedSessionIds,[shared]);
        assert.deepEqual(baseline.value.archivedSessionIds,[shared]);
      }else if(id===2)assert.deepEqual(Object.keys(baseline.value.projections),[shared]);
      else assert.equal(baseline.header.id,shared);
      const closed=await read({op:'stream-cancel',id});
      assert.equal(closed.status,200,JSON.stringify(closed));
    }
    const peer={kind:'share-viewer',shareId:'share',actor};
    for(const method of ['list','pick','createDirectory']){
      const decision=app.ctx.remoteAccess.decide({principal:peer,action:'directoryPicker/'+method,resources:[{kind:'global'}]});
      assert.equal(decision.kind,'deny');
    }
    authority={...authority,version:2,accessMode:'selected'};
    const revoked=await list();
    assert.equal(revoked.status,403,JSON.stringify(revoked));
  }finally{
    for(const socket of sockets.clients)socket.terminate();
    try{await app?.close();}finally{
      live.close();await scope.close();sockets.close();
      await new Promise(resolve=>server.close(resolve));
      await rm(home,{recursive:true,force:true});
    }
  }
});
