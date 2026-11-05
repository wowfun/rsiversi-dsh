import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createApplication} from '../../src/application/application.mjs';
import {provideHttp} from '../../src/application/http.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {workbenchHistory} from '../../src/workbench/history.mjs';
import {workbenchPersistence} from '../../src/workbench/persistence.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('original sidebar resolves each file and Git request through its authenticated Session', {skip:!root},async t=>{
  const home=await mkdtemp(join(tmpdir(),'rsi-sidebar-scopes-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const workspaces=new Map();
  for(const id of ['one','two']) {
    const cwd=join(home,id);await mkdir(cwd);
    execFileSync('git',['init','-q',cwd],{windowsHide:true});
    await writeFile(join(cwd,'note.txt'),id);
    workspaces.set(id,cwd);
  }
  const key=randomBytes(32).toString('hex'),require=createRequire(join(root,'package.json'));
  const modules={entry:name=>require.resolve(name)};
  const route={deployment:'live',model:'first'};
  let persistence;
  const session=applicationSessions(async(method,input)=>{
    if(method==='application.models'){
      assert.equal(input.request,'one');
      return input.after===null
        ?{default:route,effort:'high',models:[{route,efforts:['low','high'],default_effort:'low'}],next:route}
        :{default:route,effort:'high',models:[{route:{deployment:'offline',model:'other'},failure:'retired'}],next:null};
    }
    if(!workspaces.has(input.session_id) || input.request!==input.session_id) throw new Error('Session refused');
    if(method==='application.history'){
      const id=input.session_id,op=input.operation,through=id==='one'?4:0;
      if(op.type==='open')return {id,created_at:1,cwd:workspaces.get(id),preset:'standard',through,inherited:false,
        selection_cursor:{kind:'durable',fact_seq:through,control_seq:0},model_baseline:{model:route},model_selection:{model:route}};
      assert.equal(op.type,'fact');
      const fact=[{type:'message_turn_accepted',turn_id:'turn'},
        {type:'step_started',turn_id:'turn',step_id:'step'},
        {type:'input_message_claimed',turn_id:'turn',step_id:'step',source:{type:'human',message_id:'input'},content:[{type:'text',text:'native context'}]},
        {type:'step_inputs_prepared',turn_id:'turn',step_id:'step',decision:{kind:'enter',messages:[{kind:'claimed',claim:{fact_seq:3,ordinal:0}}]}}][op.after_seq];
      const json=JSON.stringify([{...fact,seq:op.after_seq+1,timestamp_ms:1}]),size=Buffer.byteLength(json);
      return {through_seq:op.after_seq+1,offset:0,next_offset:size,total_bytes:size,json};
    }
    if(method==='application.descendants')return input.session_id==='two'?[]:[
      {id:'child',parent:'one',depth:1,task:'review',created_at:2,activity:'running'},
      {id:'grandchild',parent:'child',depth:2,task:'verify',created_at:3,activity:'idle'},
      {id:'uncertain',parent:'one',depth:1,task:'lost',created_at:4,activity:'unknown'},
    ];
    assert.equal(method,'application.session');
    return {id:input.session_id,cwd:workspaces.get(input.session_id)};
  },{capture:(...args)=>persistence.capture(...args)});
  const app=await createApplication({modules,profile:home,provide:async(ctx,load)=>{
    ctx.provide('sessions',session.sessions);
    ctx.provide('subagents',session.subagents);
    ctx.provide('sessionController',{modelCatalog:session.modelCatalog});
    await provideHttp(ctx,load,key,session);
    for(const name of ['dsh-session-projection','dsh-system-prompt','dsh-tools']) await ctx.plugin((await load('@deepseek-ai/'+name)).default);
    const api=Object.assign({},await load('@deepseek-ai/dsh-session'),await load('@deepseek-ai/dsh-session/surface'),await load('@deepseek-ai/dsh-util-values'));
    const history=workbenchHistory({ctx,api,llm:await load('@deepseek-ai/dsh-llm'),read:session.history,listChildren:session.subagents.listChildren,authorize:session.authorize});
    persistence=workbenchPersistence(history,await load('@deepseek-ai/dsh-session-persistence'));
    ctx.provide('sessionPersistence',persistence);
  }});t.after(()=>app.close());
  const boot=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-app-boot')));
  const patch=join(root,'node_modules/dsh-better-sidebar/cordis.patch.yml');
  await app.reconcile([boot.loadOverlayPatches('rsi-dsh',patch)]);
  const origin=app.ctx.webServer.getOrigin();
  const request=(id,url,body,extra={})=>fetch(origin+url,{method:'POST',headers:{'x-rsi-upstream-key':key,
    'x-rsi-upstream-request':id,'content-type':'application/json',...extra},body});
  const settings=await request('one','/sidebar/api/settings.get','   ');
  assert.equal(settings.status,200,await settings.text());
  const models=await (await request('one','/sidebar/api/sidechat.models','{}')).json();
  assert.deepEqual(models.value,{available:true,default:{provider:'live',model:'first',reasoningEffort:'high'},
    groups:[{id:'live',name:'live',models:[{id:'first',name:'first',reasoning:{
      efforts:[{id:'low',name:'low'},{id:'high',name:'high'}],defaultEffort:'low'}}]}],
    failures:[{id:'offline',name:'offline',message:'retired'}]});
  for(const id of ['one','two']) {
    const phase=await request(id,'/sidebar/api/session.phase',JSON.stringify({sessionId:id}));
    assert.deepEqual((await phase.json()).value,{blank:id==='two'});
    const cold=await request(id,'/sidebar/api/sidechat.events',JSON.stringify({childId:id}));
    const coldBody=await cold.json();assert.equal(cold.status,200,JSON.stringify(coldBody));
    assert.equal(coldBody.value.events.some(row=>JSON.stringify(row).includes('native context')),id==='one');
    const info=await (await request(id,'/sidebar/api/sidechat.info',JSON.stringify({childId:id}))).json();
    assert.deepEqual(info.value,{live:false,images:{available:false},preset:'standard'});
    const r=await request(id,'/sidebar/api/subagents.live',JSON.stringify({rootSessionId:id}));
    const data=await r.json();
    assert.equal(r.status,200,JSON.stringify(data));
    const live=data.live??data.data?.live??data.value?.live;
    assert.ok(live,JSON.stringify(data));
    assert.ok(Object.hasOwn(live,id));
    if(id==='one'){
      assert.equal(live.child.running,true);assert.equal(live.grandchild.running,false);
      assert.ok(!Object.hasOwn(live,'uncertain'));
    } else assert.deepEqual(Object.keys(live),[id]);
  }
  for(const [route,body] of [
    ['sidechat.info',{childId:'two'}],
    ['sidechat.prompt',{sessionId:'one',childId:'two',text:'denied'}],
    ['subagents.live',{rootSessionId:'two'}],
  ]) {
    const denied=await request('one','/sidebar/api/'+route,JSON.stringify(body));
    assert.equal(denied.status,403,await denied.text());
  }
  for(const [body,message] of [['{','request body is not valid JSON'],
    ['x'.repeat(1024*1024+1),'request body too large']]) {
    const response=await request('one','/sidebar/api/settings.get',body);
    assert.equal(response.status,400);
    assert.deepEqual((await response.json()).error,{code:'bad-request',message});
  }
  for(const id of workspaces.keys()) {
    const result=await request(id,'/sidebar/api/fs.read',JSON.stringify({sessionId:id,path:'note.txt'}));
    const json=await result.json();assert.equal(result.status,200,JSON.stringify(json));
    assert.ok(JSON.stringify(json).includes('"'+id+'"'),JSON.stringify(json));
    const write=await request(id,'/sidebar/write?sessionId='+id+'&path=note.txt','changed-'+id,{'content-type':'text/plain'});
    assert.equal(write.status,200,await write.text());
    assert.equal(await readFile(join(workspaces.get(id),'note.txt'),'utf8'),'changed-'+id);
    const git=await request(id,'/sidebar/api/git.status',JSON.stringify({sessionId:id}));
    assert.equal(git.status,200,await git.text());
  }
  assert.equal((await request('one','/sidebar/api/fs.read',JSON.stringify({sessionId:'two',path:'note.txt'}))).status,403);
  const hinted=await request('one','/sidebar/api/fs.read',JSON.stringify({sessionId:'one',cwd:workspaces.get('two'),path:'note.txt'}));
  const hintedBody=await hinted.json();
  assert.equal(hinted.status,200,JSON.stringify(hintedBody));
  assert.ok(JSON.stringify(hintedBody).includes('changed-one'),JSON.stringify(hintedBody));
  assert.equal((await request('one','/sidebar/write?path=note.txt','fail')).status,403);
  // A local operator can open an absolute host path. This is the published
  // plugin's behavior even when its native Session cwd is another directory.
  const explicit=await request('one','/sidebar/api/fs.read',JSON.stringify({
    sessionId:'one',path:join(workspaces.get('two'),'note.txt')}));
  assert.equal(explicit.status,200);
  assert.ok(JSON.stringify(await explicit.json()).includes('changed-two'));
  const WebSocket=require('ws');
  const notifications=new WebSocket(origin.replace('http:','ws:')+'/sidebar/ws/sidechat',{
    origin,headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'one'}});
  try {
    await once(notifications,'open',{signal:AbortSignal.timeout(5000)});
    notifications.send(JSON.stringify({op:'watch',threadIds:['one']}));
    // A ping round-trip establishes that the preceding watch frame was read.
    const ready=once(notifications,'pong',{signal:AbortSignal.timeout(5000)});notifications.ping();await ready;
    const notified=once(notifications,'message',{signal:AbortSignal.timeout(5000)});
    app.ctx.emit('session/event',{id:'one'},{type:'user/message'});
    assert.deepEqual(JSON.parse((await notified)[0]),{threadId:'one'});
  }finally{notifications.terminate();}
  for(const id of ['one','two']) {
    const socket=new WebSocket(origin.replace('http:','ws:')+'/sidebar/ws/fs-watch?sessionId='+id,{
      origin,headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':id}});
    try {
      await once(socket,'open',{signal:AbortSignal.timeout(5000)});
      const message=once(socket,'message',{signal:AbortSignal.timeout(5000)});
      socket.send(JSON.stringify({op:'watch',path:'.'}));
      const frame=JSON.parse((await message)[0]);
      assert.equal(frame.ok,true,JSON.stringify(frame));
      assert.equal(frame.dir,workspaces.get(id));
    } finally {socket.terminate();}
  }
});
