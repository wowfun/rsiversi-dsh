import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {createApplication} from '../../src/application/application.mjs';
import {provideHttp} from '../../src/application/http.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('admitted handler failures retain the original WebServer error path', {skip:!root}, async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-handler-errors-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const key=randomBytes(32).toString('hex'), require=createRequire(join(root,'package.json'));
  const sessions=applicationSessions(async()=>{throw Error('Session unavailable');});
  const app=await createApplication({profile,modules:{entry:n=>require.resolve(n)},
    provide:(ctx,load)=>provideHttp(ctx,load,key,sessions)});
  t.after(()=>app.close());
  const handler=()=>{throw Error('plugin handler failure');};
  app.ctx.webServer.register({kind:'exact',path:'/failure',handler});
  app.ctx.webServer.registerFallback(handler);
  const origin=app.ctx.webServer.getOrigin(),headers={'x-rsi-upstream-key':key,'x-rsi-upstream-request':'admitted'};
  for(const prefix of ['','/document']) {
    assert.equal((await fetch(origin+prefix+'/failure')).status,403);
    const malformed=await fetch(origin+prefix+'/sidebar/api/failure',{method:'POST',headers,body:'{'});
    assert.equal(malformed.status,400);
    const body=await malformed.text();
    assert.equal(JSON.parse(body||'null')?.error?.code,'bad-request',prefix+' sidebar body: '+body);
    const denied=await fetch(origin+prefix+'/sidebar/html/missing',{headers});
    assert.equal(denied.status,403);
    assert.equal((await denied.json()).error.code,'forbidden');
    for(const path of ['/failure','/fallback']) {
      const failed=await fetch(origin+prefix+path,{headers});
      assert.equal(failed.status,400,'WebServer owns errors after admission');
      assert.equal(await failed.text(),'');
    }
  }
});
test('Fetch resources preserve the admitted Peer and original path on both HTTP mounts',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const {WebServer}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-host-webserver')));
  if(typeof WebServer.prototype.readResource!=='function')return t.skip('WebServer exposes handler routes only');
  const profile=await mkdtemp(join(tmpdir(),'rsi-resource-'));t.after(()=>rm(profile,{recursive:true,force:true}));
  const key=randomBytes(32).toString('hex'), scoped=[];
  const sessions={async prepare(req,id) {
    scoped.push([new URL(req.url).pathname,id]);
    if(id!=='admitted')throw Error('unknown native request');
    return run=>run(req);
  }};
  const app=await createApplication({profile,modules:{entry:n=>require.resolve(n)},provide:(ctx,load)=>provideHttp(ctx,load,key,sessions)});
  t.after(()=>app.close());
  const server=app.ctx.webServer,origin=server.getOrigin(),owner=app.ctx.connection.browserPeer;
  const read=(req,peer)=>new Response(JSON.stringify([new URL(req.url).pathname+new URL(req.url).search,peer===owner]));
  server.register({kind:'exact',path:'/named',resource:read});
  server.registerFallback({resource:read});
  for(const path of ['/named','/fallback'])for(const prefix of ['','/document']){
    const url=origin+prefix+path+'?q=1';
    assert.equal((await fetch(url)).status,403);
    assert.equal((await fetch(url,{headers:{'x-rsi-upstream-key':key}})).status,403);
    const headers={'x-rsi-upstream-key':key,'x-rsi-upstream-request':'admitted'};
    const res=await fetch(url,{headers}); assert.deepEqual(await res.json(),[path+'?q=1',false]);
    assert.deepEqual(scoped.at(-1),[path,'admitted']);
    const head=await fetch(url,{method:'HEAD',headers});assert.equal(head.status,200);assert.equal(await head.text(),'');
    assert.equal((await fetch(url,{method:'POST',headers})).status,405);
    const count=scoped.length;
    assert.deepEqual(await (await server.readResource(new Request(url),owner)).json(),[path+'?q=1',true]);
    assert.equal(scoped.length,count);
  }
});
test('released web server admits the native proxy and serves its original composed document', {skip:!root}, async t => {
  const profile=await mkdtemp(join(tmpdir(),'rsi-app-http-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const key=randomBytes(32).toString('hex');
  const require=createRequire(join(root,'package.json'));
  const modules={entry:name=>require.resolve(name)};
  const app=await createApplication({modules,profile,provide:(ctx,load)=>provideHttp(ctx,load,key)});
  t.after(()=>app.close());
  await app.reconcile([[{insert:[
    {id:'modules',name:'@deepseek-ai/dsh-client-modules'},
    {id:'web',name:'@deepseek-ai/dsh-web-app',config:{openBrowser:false,printUrl:false}},
    {id:'ui-renderer',name:'@deepseek-ai/dsh-client-ui-renderer'},
  ]}]]);
  const origin=app.ctx.webServer.getOrigin();
  const url=origin+'/document/';
  assert.equal((await fetch(url)).status,403);
  const headers={'x-rsi-upstream-key':key};
  const doc=await fetch(url,{headers});
  assert.equal(doc.status,200);
  const html=await doc.text();
  assert.match(html,/__DSH_BOOT__/);
  assert.match(html,/<title>DeepSeek Harness<\/title>/);
  const initial=html.match(/<script[^>]*src="(plugins\/[^"]+)"/)?.[1];
  assert.ok(initial,'original bootstrap module is preloaded relative to the document');
  const preload=await fetch(new URL(initial.replaceAll('&amp;','&'),url),{headers});
  assert.equal(preload.status,200);
  assert.match(await preload.text(),/__ModuleLoader__/);
  const graph=app.ctx.clientModules.graph();
  const renderer=graph.entries.find(row=>row.id==='@deepseek-ai/dsh-client-ui-renderer');
  assert.ok(renderer?.url,JSON.stringify(graph).slice(0,500));
  assert.equal((await fetch(new URL(renderer.url,origin))).status,403);
  const bundle=await fetch(new URL(renderer.url,origin),{headers});
  assert.equal(bundle.status,200);
  assert.ok((await bundle.arrayBuffer()).byteLength>1000);
});
