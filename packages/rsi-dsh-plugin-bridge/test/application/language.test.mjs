import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {languageCalls,provideLanguage} from '../../src/application/language.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {resolveBody} from '../../src/request-body.mjs';

const options={provider:'configured',model:'selected',system:'Keep the date.',messages:[{role:'user',content:[{type:'text',text:'14:30'}]}]};
const opening={type:'content_started',index:0,content:{type:'text'}};
const delta=text=>({type:'content_delta',index:0,delta:{type:'text',value:text}});

const cohort=process.env.RSI_DSH_MARKET_COHORT;
test('released LLM resolves native context capacity and applies only a configured output default', {skip:!cohort}, async t=>{
  const require=createRequire(join(cohort,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve(name)).href);
  const {Context}=await load('@deepseek-ai/cordis');
  const ctx=new Context();
  t.after(()=>ctx.fiber.dispose());
  const route={deployment:'configured',model:'selected'};
  const model=(id,cap)=>({route:{...route,model:id},efforts:[],context_window:64000,default_output_tokens:cap});
  const requests=[];
  const sessions=applicationSessions(async (method,request)=>{
    assert.equal(method,'application.models');
    requests.push(request.optional_default);
    return {default:route,models:[model('selected',2048),model('uncapped',null)],next:null};
  },{owner:'owner'});
  t.after(()=>sessions.close());
  const submitted=[];
  const calls=languageCalls(async (_method,{body})=>{
    submitted.push(body.value.settings.max_output_tokens);
    return {events:[{type:'finished',reason:'stop'}]};
  },'owner');
  t.after(()=>calls.close());
  const picker=await sessions.observeOwned(signal=>sessions.modelCatalog(signal));
  assert.deepEqual(picker.groups[0].models,[{id:'selected',name:'selected'},{id:'uncapped',name:'uncapped'}]);
  const registry=await sessions.observeOwned(signal=>sessions.modelCatalog(signal,true));
  assert.deepEqual(requests,[undefined,true]);
  await provideLanguage(ctx,load,registry,calls);
  const llm=ctx.llm;
  const bounded=await llm.resolveModelInfo('configured','selected');
  assert.deepEqual(bounded.context,{contextWindow:64000});
  assert.equal(bounded.defaultMaxTokens,2048);
  const uncapped=await llm.resolveModelInfo('configured','uncapped');
  assert.deepEqual(uncapped.context,bounded.context);
  assert.equal(uncapped.defaultMaxTokens,undefined);
  for(const overrides of [{},{maxTokens:32},{model:'uncapped'}]) {
    const chunks=await Array.fromAsync(llm.stream({...options,...overrides}));
    assert.deepEqual(chunks.at(-1).reason,{kind:'stop'});
  }
  assert.deepEqual(submitted,[2048,32,undefined]);
});

test('an inline final reply completes the stream without an extra callback',async()=>{
  const calls=languageCalls(async()=>({events:[opening,delta('answer'),{type:'content_finished',index:0},{type:'finished',reason:'stop'}]}),'owner');
  const chunks=await Array.fromAsync(calls.stream(options));
  assert.deepEqual(chunks.map(chunk=>chunk.type),['block-start','text-delta','block-end','finish']);
  assert.equal(chunks[2].block.text,'answer');calls.close();
});

test('standalone calls feed the native route, stream with backpressure and cancel when the reader leaves',async()=>{
  const cancelled=Promise.withResolvers();let delivered=false;
  const calls=languageCalls(async(method,args,signal)=>{
    assert.equal(method,'application.language');assert.equal(args.request,'owner');
    assert.deepEqual(args.model,{deployment:'configured',model:'selected'});
    assert.deepEqual(args.body.value.messages.map(m=>[m.role,m.content[0].content.text]),[['system','Keep the date.'],['user','14:30']]);
    try{await calls.deliver({id:args.id,events:[opening,delta('first')]},signal);delivered=true;}
    finally{cancelled.resolve(signal.aborted);}
  },'owner');
  const stream=calls.stream(options);
  assert.equal((await stream.next()).value.type,'block-start');
  assert.equal((await stream.next()).value.text,'first');assert.equal(delivered,false);
  await stream.return();assert.equal(await cancelled.promise,true);calls.close();
});

test('paged standalone input and large provider batches preserve exact UTF-8 through finish',async()=>{
  const text='花'.repeat(110000);
  const calls=languageCalls(async(_method,{id,body},signal)=>{
    assert.equal(body.kind,'paged');
    const value=await resolveBody(body,16*1024*1024,(token,offset)=>calls.read({id,token,offset}));
    assert.equal(value.messages.at(-1).content[0].content.text,text);
    const bytes=Buffer.from(JSON.stringify([opening,delta(text),{type:'content_finished',index:0},{type:'finished',reason:'stop'}]));
    for(let offset=0;offset<bytes.length;offset+=65536)await calls.deliver({id,bytes:bytes.length,part:{offset,data:bytes.subarray(offset,offset+65536).toString('base64')}},signal);
  },'owner');
  const chunks=await Array.fromAsync(calls.stream({...options,messages:[{role:'user',content:[{type:'text',text}]}]}));
  assert.deepEqual(chunks.map(row=>row.type),['block-start','text-delta','block-end','finish']);
  assert.equal(chunks[2].block.text,text);assert.deepEqual(chunks[3].reason,{kind:'stop'});calls.close();
});
