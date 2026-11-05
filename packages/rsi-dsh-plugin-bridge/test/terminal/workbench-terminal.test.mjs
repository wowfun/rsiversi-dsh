import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,rm,symlink} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {createApplication} from '../../src/application/application.mjs';
import {provideHttp} from '../../src/application/http.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {sessionController} from '../../src/workbench/session-controller.mjs';
import {terminalController} from '../../src/terminal/controller.mjs';
import {attachTerminal} from '../../src/terminal/stream.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('a busy PTY observes an idle uplink once and still accepts its next command',async()=>{
  let subscriptions=0,reads=0,releases=0;
  class IdleRead extends Promise {
    then(...args){subscriptions++;return super.then(...args);}
  }
  const idle=IdleRead.withResolvers(),park=Promise.withResolvers();
  const status={id:'term',phase:{state:'running'},size:{columns:80,rows:24},controller:'follower',controller_epoch:1};
  const scope={async terminal(_session,{operation}){
    if(operation.type==='attach')return {value:{id:'follower',stream_epoch:1,terminal:status}};
    if(operation.type==='input')return {value:{result:{state:'accepted',bytes:operation.bytes.length}}};
    assert.equal(operation.type,'read');
    if(++reads>65)return park.promise;
    return {value:{terminal:status,text:'x',next_cursor:reads,stream_epoch:1}};
  },releaseTerminal(){releases++;park.resolve();}};
  const input={ [Symbol.asyncIterator](){return this;},next:()=>idle.promise,return:()=>({done:true})};
  const frames=attachTerminal(scope,{binding:async()=>({terminal:status,catalog:{}}),info:()=>({})},
    'session','key',input,undefined,new AbortController().signal);
  try {
    assert.equal((await frames.next()).value.type,'snapshot');
    for(let n=1;n<=64;n++)assert.deepEqual((await frames.next()).value,{type:'output',sequence:n,data:'x'});
    assert.equal(subscriptions,1);
    idle.resolve({value:{type:'write',sequence:1,data:'y'}});
    assert.deepEqual((await frames.next()).value,{type:'ack',sequence:1});
  }finally{await frames.return();}
  assert.equal(releases,1);
});
test('a native screen reset repaints within the original Remote attachment sequence',async()=>{
  const status={id:'term',phase:{state:'running'},size:{columns:80,rows:24},controller:'follower'};
  const pages=[{text:'old',reset:false,next_cursor:3,stream_epoch:1},{text:'new',reset:true,next_cursor:3,stream_epoch:2},
    {text:'!',reset:false,next_cursor:4,stream_epoch:2}];
  let released;
  const scope={async terminal(_session,{operation}){
    if(operation.type==='attach')return {value:{id:'follower',stream_epoch:1,terminal:status}};
    assert.equal(operation.type,'read');return {value:{terminal:status,...pages.shift()}};
  },releaseTerminal(id){released=id;}};
  const input={ [Symbol.asyncIterator](){return this;},next(){return new Promise(()=>{});},return(){return {done:true};}};
  const frames=attachTerminal(scope,{binding:async()=>({terminal:status,catalog:{}}),info:()=>({id:'key'})},
    'session','key',input,undefined,new AbortController().signal);
  const first=(await frames.next()).value;
  assert.equal(first.type,'snapshot');assert.equal(first.screen,'old');
  assert.deepEqual((await frames.next()).value,{type:'output',sequence:1,data:'\x1bcnew'});
  assert.deepEqual((await frames.next()).value,{type:'output',sequence:2,data:'!'});
  await frames.return();assert.equal(released,'follower');
});
test('a read-only terminal follower only publishes changes visible to that attachment',async()=>{
  const status={id:'term',phase:{state:'running'},size:{columns:80,rows:24},controller:'other',controller_epoch:2};
  const owned={...status,controller:'follower',controller_epoch:4};
  const pages=[status,{...status,controller:'another',controller_epoch:3},owned];
  const scope={async terminal(_session,{operation}){
    if(operation.type==='attach')return {value:{id:'follower',stream_epoch:1,terminal:status}};
    if(operation.type==='takeover')return {value:owned};
    return {value:{terminal:pages.shift(),text:'',next_cursor:0,stream_epoch:1}};
  },releaseTerminal(){}};
  const idle={ [Symbol.asyncIterator](){return this;},next:()=>new Promise(()=>{})};
  const frames=attachTerminal(scope,{binding:async()=>({terminal:status,catalog:{}}),info:()=>({})},
    'session','key',idle,undefined,new AbortController().signal);
  assert.equal((await frames.next()).value.writable,false);
  assert.deepEqual((await frames.next()).value,{type:'state',info:{},writable:true});
  await frames.return();
});
test('published commands and terminals share the authorized Agent and preserve terminal creation IDs',{skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-terminal-gateway-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  await mkdir(join(profile,'node_modules'));
  await symlink(join(root,'node_modules/@deepseek-ai'),join(profile,'node_modules/@deepseek-ai'),process.platform==='win32'?'junction':'dir');
  const require=createRequire(join(root,'package.json')),key=randomBytes(32).toString('hex');
  const modules={entry:name=>require.resolve(name),directory:name=>dirname(require.resolve(name+'/package.json'))};
  const terminal='@deepseek-ai/dsh-api-terminal-controller',hostModules=new Map(),calls=[];
  const state={id:'native-terminal',size:{rows:24,columns:80},phase:{state:'running'},controller:null,controller_epoch:2};
  let mirror,activations=0,authorizations=0;
  const events=[];
  const scope=applicationSessions(async(method,args)=>{
    assert.equal(args.request,'issued');
    if(method==='application.actor') {
      authorizations++;
      if(args.session_id!=='allowed')throw new Error('not visible');
      return {id:'allowed',cwd:profile,createdAt:1};
    }
    assert.equal(method,'application.terminal');assert.equal(args.session_id,'allowed');
    if(!args.operation)return {cwd:profile,program:'/bin/bash',arguments:['-i'],bindings:calls.length?[{key:'client-key',terminal:state}]:[]};
    calls.push(args.operation);
    return {type:'terminal',value:state};
  },{owner:'application-test-owner',agent:id=>mirror?.id===id?mirror:undefined});
  const app=await createApplication({profile,modules,hostModules,provide:async(ctx,load)=>{
    await provideHttp(ctx,load,key,scope);
    ctx.provide('profileContext',{name:'terminal',dir:profile,installAnchor:join(root,'package.json')});
    await ctx.plugin((await load('@deepseek-ai/dsh-app-boot')).PluginPackages);
    await ctx.plugin((await load('@deepseek-ai/dsh-session-projection')).default);
    await ctx.plugin((await load('@deepseek-ai/dsh-agent')).AgentRegistry);
    const {TypertRemoteService}=await load('@deepseek-ai/dsh-typert-protocol');
    hostModules.set('@deepseek-ai/dsh-api-session-controller',sessionController({TypertRemoteService},scope,undefined,undefined,async id=>{
      activations++;return mirror={id,ctx,session:{id,append(type,data){events.push({type,data});}}};
    }));
    hostModules.set(terminal,terminalController(TypertRemoteService,scope,(await load(terminal)).default.Config({})));
  }});
  t.after(()=>app.close());
  await app.reconcile([{insert:['dsh-typert-registry','dsh-typert-loader','dsh-api-remote-access','dsh-api-gateway','dsh-api-session-controller','dsh-api-terminal-controller','dsh-commands']
    .map(id=>({name:'@deepseek-ai/'+id,id}))}]);
  async function invoke(method,args) {
    const res=await fetch(app.ctx.webServer.getOrigin()+'/api/'+method,{method:'POST',
      headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'issued','content-type':'application/json'},
      body:JSON.stringify({type:'client-request',method,rpcId:randomUUID(),payload:{args}})});
    const body=await res.text();
    assert.equal(res.status,200,method+' '+body.slice(0,400));
    return JSON.parse(body).result;
  }
  app.ctx.commands.register({name:'identify',description:'Identify this Agent',handler:({agent})=>{
    assert.equal(agent,mirror);return {kind:'success',text:agent.id};
  }});
  assert.equal((await invoke('commands/list',{agentId:'hidden'})).ok,false);
  assert.equal(activations,0);
  const invoked=await invoke('commands/execute',{agentId:'allowed',line:'/identify',submittedAttachments:[]});
  assert.deepEqual(invoked.value?.result,{kind:'success',text:'allowed'},JSON.stringify(invoked));
  assert.deepEqual(events.map(e=>e.type),['command/run','command/done']);
  assert.equal(authorizations,2);assert.equal(activations,1);
  const request={id:'client-key',cols:80,rows:24};
  assert.equal((await invoke('terminal/create',{agentId:'hidden',request})).ok,false);
  assert.equal(calls.length,0);
  const added=await invoke('terminal/create',{agentId:'allowed',request});
  assert.equal(added.ok,true,JSON.stringify(added));
  assert.equal(added.value.id,'client-key');
  assert.deepEqual(calls,[{type:'create',key:'client-key',size:{rows:24,columns:80}}]);
  assert.equal((await invoke('terminal/list',{sessionId:'allowed'})).value[0].id,'client-key');
  assert.equal(activations,1);
});
