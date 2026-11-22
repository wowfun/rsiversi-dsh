import assert from 'node:assert/strict';
import {test} from 'node:test';
import {languageCalls} from '../../src/application/language.mjs';
import {resolveBody} from '../../src/request-body.mjs';

const options={provider:'configured',model:'selected',system:'Keep the date.',messages:[{role:'user',content:[{type:'text',text:'14:30'}]}]};
const opening={type:'content_started',index:0,content:{type:'text'}};
const delta=text=>({type:'content_delta',index:0,delta:{type:'text',value:text}});

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
