import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {nativeForkSeed} from '../../src/workbench/fork-seed.mjs';

const start={type:'turn/start',seq:0,time:1,data:{turn:1,rsi:{session:'parent',turn:'running',fact:1}}};
const user={type:'user/message',seq:1,time:2,data:{id:'question',role:'user',source:{kind:'user'},content:[{type:'text',text:'Remember OPEN-123'}]}};
const answer={type:'assistant/message',seq:2,time:3,data:{message:{role:'assistant',content:[
  {type:'text',text:'Answer so far'},{type:'reasoning',text:'Observed reasoning'}]}}};

test('open seed keeps its exact native cut and preserves inputs as reference context',()=>{
  const closer={type:'turn/end',data:{turn:1,reason:{kind:'interrupted'}}};
  const seed=[start,user,answer,closer];
  const result=nativeForkSeed('parent',seed);
  assert.deepEqual(result.point,{kind:'before_turn',turn_id:'running'});
  assert.match(result.context,/reference only/);assert.match(result.context,/OPEN-123/);
  assert.match(result.context,/Answer so far/);assert.match(result.context,/Observed reasoning/);
  assert.doesNotMatch(result.context,/interrupted/);
  assert.deepEqual(seed,[start,user,answer,closer]);
});

test('completed and empty prefixes never include a later native Turn',()=>{
  const completed={type:'turn/end',data:{rsi:{session:'parent',turn:'finished',fact:20}}};
  assert.deepEqual(nativeForkSeed('parent',[completed]),
    {point:{kind:'through_turn',turn_id:'finished'}});
  const later={...start,data:{...start.data,rsi:{session:'parent',turn:'later',fact:50}}};
  const events=[start,user,completed,later],reads=[];
  assert.deepEqual(nativeForkSeed('parent',[],{seq:events.length,eventAt:seq=>{reads.push(seq);return events[seq];}}),
    {point:{kind:'before_turn',turn_id:'running'}});
  assert.deepEqual(reads,[0]);
});

test('reference snapshot distinguishes actual tool results and pending calls and reports truncation',()=>{
  const call=(id,name)=>({type:'tool/call',data:{callId:id,name,arguments:'{}'}});
  const result={type:'tool/result',data:{message:{source:{callId:'done'},content:[{type:'text',text:'result evidence'}]}}};
  const context=nativeForkSeed('parent',[start,user,call('done','read'),result,call('pending','bash')]).context;
  assert.match(context,/read.*arguments:[\s\S]*Result: result evidence/);
  assert.match(context,/bash \(executing\)/);
  const huge={...user,data:{...user.data,content:[{type:'text',text:'x'.repeat(9000)}]}};
  const truncated=nativeForkSeed('parent',[start,huge]).context;
  assert.match(truncated,/\[Snapshot truncated\]/);assert.ok(truncated.length<8200);
});

test('original Better Sidebar synthetic closer and dangling-tool fallback map to native cuts',
  {skip:!process.env.RSI_DSH_MARKET_COHORT},async()=>{
    const {build}=await import('esbuild');
    const {outputFiles}=await build({entryPoints:[join(process.env.RSI_DSH_MARKET_COHORT,
      'node_modules/dsh-better-sidebar/src/sidechat-core.ts')],bundle:true,write:false,platform:'node',format:'esm'});
    const {buildSidechatInheritance}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
    const original=buildSidechatInheritance([start,user,answer]);
    assert.equal(original.snapshot,null);
    assert.equal(original.seed.at(-1).data.reason.kind,'interrupted');
    assert.equal(original.seed.at(-1).data.rsi,undefined);
    const mapped=nativeForkSeed('parent',original.seed);
    assert.deepEqual(mapped.point,{kind:'before_turn',turn_id:'running'});
    assert.match(mapped.context,/OPEN-123/);
    const pending={type:'tool/call',seq:3,time:4,data:{callId:'pending',name:'bash',arguments:'sleep 10'}};
    const dangling=buildSidechatInheritance([start,user,answer,pending]);
    assert.equal(dangling.seed.length,0);assert.match(dangling.snapshot,/executing/);
    const events=[start,user,answer,pending];
    assert.deepEqual(nativeForkSeed('parent',dangling.seed,{seq:events.length,eventAt:seq=>events[seq]}),
      {point:{kind:'before_turn',turn_id:'running'}});
});
