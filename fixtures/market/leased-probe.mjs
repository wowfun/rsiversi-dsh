// Invoked by the native opt-in lease test. Session and settings are controlled
// fixtures; the Loader, tools, sidebar registry, HTTP server and WS are real.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installReleaseResolver} from '../../packages/rsi-dsh-cordis/src/release/resolver.mjs';
import {createApplication} from '../../packages/rsi-dsh-plugin-bridge/src/application/application.mjs';

let input=''; for await(const chunk of process.stdin) input+=chunk;
const {layout,roots}=JSON.parse(input), modules=installReleaseResolver(layout,new Map(Object.entries(roots)));
const directory=await mkdtemp(join(tmpdir(),'rsi-profile-proof-')), token=randomBytes(32).toString('hex');
const target=join(directory,'proof.txt'); await writeFile(target,'selected workspace');
const plugin=modules.entry('dsh-better-sidebar'), consumer=createRequire(plugin);
const report={runtime:layout.version,plugins:layout.plugins,
  sharedCordis:consumer.resolve('@deepseek-ai/cordis')===modules.entry('@deepseek-ai/cordis')};
assert.ok(report.sharedCordis);
for(const name of layout.plugins) await import(pathToFileURL(modules.entry(name)));
let app, socket, other;
// Reserve stdout for the machine-readable result.
for(const key of ['log','info','warn','debug']) console[key]=(...items)=>console.error(...items);
try {
  app=await createApplication({modules,profile:directory,provide:async(ctx,load)=>{
    const plugins=['dsh-session-projection','dsh-system-prompt','dsh-tools','dsh-agent','dsh-host-webserver'];
    for(const name of plugins) {
      const module=await load('@deepseek-ai/'+name);
      await ctx.plugin(name==='dsh-agent'?module.AgentRegistry:module.default,
        name==='dsh-host-webserver'?{host:'127.0.0.1',port:0}:undefined);
    }
    ctx.provide('sessions',{get:id=>['profile-proof','profile-other'].includes(id)?{id,header:{cwd:directory}}:undefined});
    ctx.provide('connection',{requestRejection:req=>req.headers['x-rsi-fixture-token']===token?undefined:'forbidden'});
    ctx.provide('settings',{configure:()=>()=>{},describe:()=>[{ns:'better-sidebar',value:{agentOpenTools:true,tabsEnabled:{editor:true}}}]});
  }});
  const boot=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-app-boot')));
  const sidebarManifest=JSON.parse(await readFile(consumer.resolve('dsh-better-sidebar/package.json'),'utf8'));
  const patch=join(consumer.resolve('dsh-better-sidebar/package.json'),'..',sidebarManifest.dsh.bundle.patch);
  const layers=[boot.loadOverlayPatches('rsi-dsh',patch)];
  await app.reconcile(layers);
  const fiber=app.ctx.loader.resolve('include:better-sidebar').fiber;
  await app.reconcile(layers);
  assert.equal(app.ctx.loader.resolve('include:better-sidebar').fiber,fiber);
  const origin=app.ctx.webServer.getOrigin();
  const WebSocket=consumer('ws');
  socket=new WebSocket(origin.replace('http:','ws:')+'/sidebar/ws/agent-opens?sessionId=profile-proof',
    {headers:{'x-rsi-fixture-token':token},handshakeTimeout:5000});
  await once(socket,'open');
  other=new WebSocket(origin.replace('http:','ws:')+'/sidebar/ws/agent-opens?sessionId=profile-other',
    {headers:{'x-rsi-fixture-token':token},handshakeTimeout:5000});
  await once(other,'open');
  const otherEvents=[];other.on('message',bytes=>otherEvents.push(JSON.parse(bytes.toString())));
  const events=[];socket.on('message',bytes=>events.push(JSON.parse(bytes.toString())));
  const next=once(socket,'message',{signal:AbortSignal.timeout(10000)});
  const tool=app.ctx.tools.get('sidebar_open');
  assert.ok(tool,'sidebar setting registered its real Tool');
  const outcome=await tool.execute({target},{signal:AbortSignal.timeout(10000),agent:{id:'profile-proof',session:{id:'profile-proof'}}});
  const [message]=await next;
  const event=JSON.parse(message.toString());
  assert.equal(event.target,target);
  const barrier=async ws=>{const pong=once(ws,'pong',{signal:AbortSignal.timeout(5000)});ws.ping();await pong;};
  await Promise.all([barrier(socket),barrier(other)]);
  assert.equal(events.length,1);assert.deepEqual(otherEvents,[]);
  Object.assign(report,{sidebarCalls:events.length, otherSessionEvents:otherEvents.length,stableFiber:true,
    tool:'sidebar_open',event,outcome,loaderEntries:[...app.ctx.loader.entries()].map(entry=>entry.options.id)});
  process.stdout.write(JSON.stringify(report));
} finally {
  socket?.terminate(); other?.terminate(); await app?.close(); modules.close(); await rm(directory,{recursive:true,force:true});
}
