import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {ServerResponse} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {createApplication} from '../../src/application/application.mjs';
import {provideHttp} from '../../src/application/http.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;

test('a read-only HTTP handler owns its response until it returns or throws',async()=>{
  const scope=applicationSessions(()=>assert.fail('unexpected native call'));
  const req={method:'GET',url:'/plugins/',headers:{'x-rsi-upstream-request':'browser'}};
  for(const fails of [false,true]) {
    const res=new ServerResponse(req),listeners=res.listenerCount('close');
    let during;
    const scoped=await scope.prepare(req);
    const handled=scoped(()=>scope.respond(res,()=>{
      during=res.listenerCount('close');
      if(fails)throw Error('handler failed');
      res.end('read only');
    }));
    if(fails)await assert.rejects(handled,/handler failed/);
    else await handled;
    assert.equal(during,listeners);
    assert.equal(res.listenerCount('close'),listeners);
  }
});

test('a notification from a sealed HTTP publication starts independent owner work',{skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-late-notify-'));t.after(()=>rm(profile,{recursive:true,force:true}));
  const require=createRequire(join(root,'package.json')),key=randomBytes(32).toString('hex');
  const first=Promise.withResolvers(),followed=Promise.withResolvers(),release=Promise.withResolvers(),seen=[];
  const scope=applicationSessions(async(_method,args)=>{
    seen.push([args.request,args.operation.type]);
    if(args.operation.type==='first')await first.promise;
    else {followed.resolve();await release.promise;}
  },{owner:'owner'});
  const app=await createApplication({profile,modules:{entry:name=>require.resolve(name)},provide:(ctx,load)=>provideHttp(ctx,load,key,scope)});
  t.after(async()=>{first.resolve();release.resolve();await app.close();await scope.close();});
  let notification;
  app.ctx.webServer.register({kind:'exact',path:'/notify',handler(_req,res){
    scope.stage(async signal=>{
      await scope.command('one',{type:'first'},signal);
      notification=scope.publish(stop=>scope.command('one',{type:'notification'},stop));
    });
    res.end('accepted');
  }});
  const response=fetch(app.ctx.webServer.getOrigin()+'/notify',{method:'POST',
    headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':'browser'}});
  while(!seen.length)await setImmediate();first.resolve();await followed.promise;
  assert.equal(await (await response).text(),'accepted');
  assert.deepEqual(seen,[['browser','first'],['owner','notification']]);
  release.resolve();await notification;
});

test('overlapping sidebar requests capture after prior publication while independent Sessions proceed',{skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-sidebar-order-'));t.after(()=>rm(profile,{recursive:true,force:true}));
  const require=createRequire(join(root,'package.json')),key=randomBytes(32).toString('hex');
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),versions=new Map(),captures=[];
  const scope=applicationSessions(async(method,input)=>{
    const id=input.session_id;
    if(method==='application.session')return {id,cwd:profile};
    assert.equal(method,'application.command');
    if(input.request==='first'){entered.resolve();await release.promise;}
    versions.set(id,(versions.get(id)??0)+1);return {committed:true};
  },{capture:async id=>{const seq=versions.get(id)??0;captures.push([id,seq]);return {id,seq};}});
  const app=await createApplication({profile,modules:{entry:name=>require.resolve(name)},provide:(ctx,load)=>provideHttp(ctx,load,key,scope)});
  t.after(async()=>{release.resolve();await app.close();});
  app.ctx.webServer.register({kind:'exact',path:'/sidebar/api/mutate',handler(req,res){
    const id=req.headers['x-test-session'],before=scope.sessions.get(id).seq;
    scope.stage(signal=>scope.command(id,{type:'execute'},signal));res.end(JSON.stringify({before}));
  }});
  const request=async(request,id)=>{
    const response=await fetch(app.ctx.webServer.getOrigin()+'/sidebar/api/mutate',{method:'POST',
      headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':request,'x-test-session':id,'content-type':'application/json'},
      body:JSON.stringify({sessionId:id})});
    assert.equal(response.status,200);return response.json();
  };
  const first=request('first','a');await entered.promise;
  const second=request('second','a'),independent=await request('other','b');
  assert.deepEqual(independent,{before:0});assert.deepEqual(captures,[['a',0],['b',0]]);
  release.resolve();assert.deepEqual(await first,{before:0});assert.deepEqual(await second,{before:1});
});
test('original HTTP response waits for serial native writes and contains their failure', {skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-publication-'));t.after(()=>rm(profile,{recursive:true,force:true}));
  const key=randomBytes(32).toString('hex'),require=createRequire(join(root,'package.json'));
  const gates=new Map(),seen=[],outcomes=[];
  const scope=applicationSessions(async(method,input,signal)=>{
    assert.equal(method,'application.command');
    seen.push([input.request,input.operation.type]);
    if(input.operation.type==='status')return {committed:true};
    const gate=gates.get(input.request);gate.entered.resolve();
    if(input.request==='disconnect')await new Promise((_,reject)=>signal.addEventListener('abort',()=>{gate.aborted.resolve();reject(signal.reason);},{once:true}));
    await gate.release.promise;
    if(input.request==='failure')throw Error('native publication was not confirmed');
    if(input.request==='empty-reason')return Promise.reject(null);
    outcomes.push(input.request);return {committed:true};
  });
  const app=await createApplication({profile,modules:{entry:name=>require.resolve(name)},provide:(ctx,load)=>provideHttp(ctx,load,key,scope)});
  t.after(()=>app.close());
  app.ctx.webServer.register({kind:'exact',path:'/mutate',handler(req,res){
    scope.stage(signal=>scope.command('session',{type:'execute'},signal));
    scope.stage(signal=>scope.command('session',{type:'status'},signal));
    res.writeHead(201,{'content-type':'application/json','x-original-success':'1'});
    res.write('{"ok":');res.end('true}');
  }});
  app.ctx.webServer.register({kind:'exact',path:'/stream',async handler(_req,res){
    res.writeHead(200);res.write('first');await gates.get('stream').release.promise;res.end('last');
  }});
  app.ctx.webServer.register({kind:'exact',path:'/late',handler(_req,res){
    res.writeHead(200);res.write('started');
    assert.throws(()=>scope.stage(()=>{throw Error('must not run');}),/after response publication/);
    res.end('refused');
  }});
  const request=(id,path='/mutate',signal)=>fetch(app.ctx.webServer.getOrigin()+path,{method:'POST',signal,
    headers:{'x-rsi-upstream-key':key,'x-rsi-upstream-request':id}});
  const gate=id=>{const value={entered:Promise.withResolvers(),release:Promise.withResolvers(),aborted:Promise.withResolvers()};gates.set(id,value);return value;};
  const one=gate('one'),two=gate('two');
  let oneReplied=false;
  const first=request('one').then(response=>{oneReplied=true;return response;});
  await one.entered.promise;
  const second=request('two');await two.entered.promise;
  await setImmediate();assert.equal(oneReplied,false);assert.deepEqual(outcomes,[]);
  two.release.resolve();assert.equal((await second).status,201);assert.deepEqual(outcomes,['two']);
  assert.equal(oneReplied,false);one.release.resolve();
  const response=await first;assert.equal(response.status,201);assert.deepEqual(await response.json(),{ok:true});
  assert.deepEqual(seen,[['one','execute'],['two','execute'],['two','status'],['one','status']]);
  const failure=gate('failure'),failed=request('failure');await failure.entered.promise;failure.release.resolve();
  const rejected=await failed;assert.equal(rejected.status,502);assert.equal(rejected.headers.get('x-original-success'),null);
  assert.match((await rejected.json()).error.message,/not confirmed/);
  assert.equal(seen.filter(([id])=>id==='failure').length,1);
  const empty=gate('empty-reason'),emptyReply=request('empty-reason');await empty.entered.promise;empty.release.resolve();
  const refused=await emptyReply;assert.equal(refused.status,502);assert.equal((await refused.json()).error.message,'null');
  assert.equal(seen.filter(([id])=>id==='empty-reason').length,1);
  const disconnect=gate('disconnect'),abort=new AbortController();
  const abandoned=request('disconnect','/mutate',abort.signal).catch(()=>{});await disconnect.entered.promise;
  abort.abort();await abandoned;await disconnect.aborted.promise;
  assert.equal(seen.filter(([id])=>id==='disconnect').length,1);
  const stream=gate('stream'),streaming=await request('stream','/stream'),reader=streaming.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(),'first');
  stream.release.resolve();assert.equal(Buffer.from((await reader.read()).value).toString(),'last');
  assert.equal((await reader.read()).done,true);
  assert.equal(await (await request('late','/late')).text(),'startedrefused');
  assert.throws(()=>scope.stage(()=>{}),/active publication/);
  assert.throws(()=>scope.command('session',{type:'list'}),/active native request/);
});
