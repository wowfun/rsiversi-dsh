import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {createApplication} from '../../src/application/application.mjs';
import {provideHttp} from '../../src/application/http.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('a private field transaction retains only its own 2xx acceptance and carries the exact provider body',{skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-model-fields-')),key=randomBytes(32).toString('hex');
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const require=createRequire(join(root,'package.json')),{WebSocket}=require('ws');
  const accepted=[],prepared=[],refreshes=[];
  const scope=applicationSessions(()=>assert.fail('unexpected native RPC'),{owner:'test'});
  const entry=name=>name==='ws'?join(dirname(require.resolve('ws/package.json')),require('ws/package.json').exports['.'].import):require.resolve(name);
  const app=await createApplication({profile,modules:{entry},provide:async(ctx,load)=>{
    await ctx.plugin((await load('@deepseek-ai/dsh-deepseek-llm-api-extensions')).default);
    ctx.provide('sessions',scope.sessions);
    ctx.deepseekLlmApiExtensions.register('new_field',{prepare({body,sessionId,purpose}){
      prepared.push({body,sessionId,purpose,active:!!ctx.sessions.get(sessionId)});
      return {value:body.model,accept:()=>accepted.push([body.model,ctx.sessions.get(sessionId)?.id])};
    }});
    await provideHttp(ctx,load,key,scope,(id,active)=>{refreshes.push([id,active]);return active?{id}:undefined;});
  }});
  t.after(async()=>{await app.close();await scope.close();});
  const url=app.ctx.webServer.getOrigin().replace(/^http:/,'ws:')+'/rsi-model-fields';
  const headers={'x-rsi-model-key':key};
  for(const wrong of [{},{...headers,origin:'http://localhost'},{...headers,'x-rsi-upstream-key':key}]){
    await assert.rejects(once(new WebSocket(url,{headers:wrong}),'open'),/403/);
  }
  async function open(model){
    const ws=new WebSocket(url,{headers});
    await once(ws,'open');
    const response=once(ws,'message');
    ws.send(JSON.stringify({sessionId:'test-session',purpose:'test',activeSession:model==='accepted'}));
    ws.send(Buffer.from(JSON.stringify({model,input:[{text:'input'}]})));
    const [value,binary]=await response;
    assert.equal(binary,true);assert.deepEqual(JSON.parse(value),{new_field:model});
    return ws;
  }
  const first=await open('uncertain'),second=await open('accepted');
  first.terminate();
  const reply=once(second,'message');second.send('accept');
  assert.equal((await reply)[0].toString(),'ok');
  assert.deepEqual(accepted,[['accepted','test-session']]);assert.deepEqual(refreshes,[['test-session',false],['test-session',true]]);
  assert.equal(prepared[0].active,false);
  assert.deepEqual(prepared[1],{body:{model:'accepted',input:[{text:'input'}]},sessionId:'test-session',purpose:'test',active:true});
});
