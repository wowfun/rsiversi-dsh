import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../../src/application/application.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {provideHttp} from '../../src/application/http.mjs';
import {workbenchInteractions} from '../../src/workbench/interactions.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('authenticated browser windows share the original owner Peer and settle one native approval',{skip:!root,timeout:15000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-dsh-interactions-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const require=createRequire(join(root,'package.json'));
  const received=Promise.withResolvers(),abort=new AbortController();
  const reads=new Set(),firstWindow=new AbortController();
  let interactions,decisions=0;
  const scope=applicationSessions(async(method,{request,operation},signal)=>{
    assert.equal(method,'application.interactions');assert.ok(['first','second'].includes(request));
    if(operation.type==='next'){
      if(reads.has(request))return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
      reads.add(request);
      const json=JSON.stringify({approvals:[{subject:{session_id:'session'},id:'approved',action:'run tool probe',reason:'evidence',
        review:{sandbox:'danger-full-access',cwd:directory,arguments:{target:'visible'}}}],questions:[]});
      return {json,offset:0,next_offset:Buffer.byteLength(json),total_bytes:Buffer.byteLength(json)};
    }
    if(operation.type==='approval'){assert.equal(request,'second');decisions++;received.resolve(operation);return {accepted:true};}
    return null;
  });
  const app=await createApplication({profile:directory,modules:{entry:name=>require.resolve(name)},
    provide:async(ctx,load)=>{
      await provideHttp(ctx,load,'a'.repeat(64),scope);
      interactions=workbenchInteractions(ctx,scope,await load('@deepseek-ai/dsh-scope'));
    }});
  t.after(async()=>{abort.abort();await app.close();});
  await app.reconcile([{insert:['dsh-typert-registry','dsh-api-remote-access','dsh-api-gateway','dsh-api-remotes'].map(id=>({id,name:'@deepseek-ai/'+id}))}]);
  const bridge=app.ctx.typertGateway;
  const admission=()=>app.ctx.connection.admit({headers:{'x-rsi-upstream-key':'a'.repeat(64)}});
  const peer=admission().peer,other=admission().peer;
  assert.equal(peer,other);
  assert.equal(peer,app.ctx.connection.browserPeer);
  assert.equal(app.ctx.connection.admit({headers:{}}).rejection,403);
  const frames=bridge.openRemoteEvents({args:{}},abort.signal,peer);
  const foreign=bridge.openRemoteEvents({args:{}},abort.signal,other);
  await frames.next();
  async function observe(request,signal){
    const enter=await scope.prepare({url:'/api/remote.mux',headers:{'x-rsi-upstream-request':request}});
    await enter(()=>interactions.observe('session',signal));
  }
  const observing=Promise.all([observe('first',firstWindow.signal),observe('second',abort.signal)]);
  try{
    const {value}=await frames.next();
    assert.equal(value.event,'approval/request');assert.match(value.request.reason,/danger-full-access/);
    // A newly connected window can pick up an event that was already delivered.
    const otherId=(await foreign.next()).value.clientId;
    assert.equal((await foreign.next()).value.eventId,value.eventId);
    firstWindow.abort();
    await frames.return();
    const payload={args:{clientId:otherId,eventId:value.eventId,outcome:{kind:'result',value:'allowed-once'}}};
    assert.equal((await bridge.dispatchRpc('$events/result',payload,abort.signal,other)).ok,true);
    assert.deepEqual(await received.promise,{type:'approval',owner:'session',id:'approved',decision:'allow_once'});
    payload.args.outcome.value='rejected';
    assert.equal((await bridge.dispatchRpc('$events/result',payload,abort.signal,other)).ok,true);
    assert.equal(decisions,1);
  }finally{firstWindow.abort();abort.abort();await observing;await frames.return();await foreign.return();}
});
