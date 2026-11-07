import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {applicationTools} from '../../src/tools/application-tools.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('original pipeline snapshots plugin values before the receipt write and HTTP reply',{skip:!root},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-result-snapshot-'));
  const require=createRequire(join(root,'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
  const ctx=new (await load('@deepseek-ai/cordis')).Context(),tools=await load('@deepseek-ai/dsh-tools');
  const sessions=applicationSessions(()=>{throw Error('unexpected native Session request');});
  t.after(async()=>{await ctx.fiber.dispose();await sessions.close();await rm(directory,{recursive:true,force:true});});
  for(const name of ['dsh-session-projection','dsh-system-prompt'])await ctx.plugin((await load('@deepseek-ai/'+name)).default);
  await ctx.plugin(tools.default);
  const raw={text:'original'},meta={label:'original metadata'};let materialized,writes=0;
  ctx.tools.register(tools.defineTool({name:'snapshot_probe',description:'Return a plugin-owned object',parameters:{},
    output:{schema:{type:'object',additionalProperties:true},render:(_,value)=>[{type:'text',text:value.text}],presentationMeta:()=>meta},
    execute(){return raw;}}));
  ctx.on('tools/result',(_exec,result)=>{materialized=result;});
  const key=randomUUID(),listener=await applicationTools(ctx,{key,generation:randomUUID(),directory,sessions,
    load:async name=>name==='@deepseek-ai/dsh-atomic-write'?{writeFileAtomic:async(...args)=>{
      assert.ok(Object.isFrozen(materialized.value));assert.ok(Object.isFrozen(materialized.meta));
      assert.notEqual(materialized.value,raw);assert.notEqual(materialized.meta,meta);
      raw.text='changed during write';meta.label='changed during write';writes++;
      return (await load(name)).writeFileAtomic(...args);
    }}:load(name)});
  const post=async(path,input)=>{
    const reply=await fetch('http://127.0.0.1:'+listener.port+'/v1/'+path,{method:'POST',headers:{authorization:key},body:JSON.stringify(input)});
    const value=await reply.json();assert.equal(reply.status,200,JSON.stringify(value));return value;
  };
  const view=await post('capture',{view:randomUUID(),header:{id:'snapshot',cwd:directory},reserved:[],modelSelection:{provider:'fixture',model:'fixture'}});
  const effect=randomUUID(),input={view:view.view,session:'snapshot',effect,name:'snapshot_probe',args:{},registration:view.tools[0].registration,
    identity:{owner_id:'owner',invocation_id:effect,call_id:randomUUID(),request_sha256:'a'.repeat(64)}};
  const live=await post('start',input);assert.equal(live.state,'settled');assert.equal(writes,1);
  assert.deepEqual(live.result.value,{text:'original'});
  assert.deepEqual(live.result.content,[{type:'text',text:'original'}]);
  assert.deepEqual(live.result.metadata,{dsh:{meta:{label:'original metadata'}}});
  assert.deepEqual(await post('outcome',input),live);
  const files=(await readdir(directory)).filter(name=>name.endsWith('.json'));assert.equal(files.length,1);
  assert.deepEqual(JSON.parse(await readFile(join(directory,files[0]),'utf8')).result,live.result);
});
