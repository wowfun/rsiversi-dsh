import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sessionController} from '../../src/workbench/session-controller.mjs';
import {updateQueue} from '../../src/workbench/queue.mjs';

class RemoteError extends Error {
  constructor(code,message,details){super(message);Object.assign(this,{code,details});}
}
const source={kind:'user',rpcId:'original'};
const entry={kind:'durable',target:'next-turn',slotId:'slot',nativeId:'generation',source,turn:'active'};
const change=(action,inbox={},queueItem=async()=>entry)=>updateQueue({sessionId:'s',itemId:'original',action},inbox,{queueItem},RemoteError);

test('an edit preserves text boundaries and recovers the exact committed receipt after a lost response',async()=>{
  const content=[{type:'text',text:'one'},{type:'text',text:'  two '}];let sent;
  const result=await change({kind:'edit',content},{
    async mutate(id,req){assert.equal(id,'s');assert.equal(sent,undefined);sent=req;throw Error('transport closed');},
    async status(id,op){assert.equal(id,'s');assert.equal(op,sent.operation_id);return {outcome:{result:'replaced'}};},
  });
  assert.equal(result,source);assert.equal(sent.slot_id,'slot');assert.equal(sent.expected_message_id,'generation');
  assert.equal(sent.mutation.action,'replace');assert.deepEqual(sent.mutation.content,content);assert.ok(sent.mutation.new_message_id);
});

test('rejected queue actions retain the native decision and original DSH error code',async()=>{
  for(const [action,reason,code] of [
    ['remove','claimed','session/queue-item-not-found'],['edit','stale_message','session/queue-item-not-found'],
    ['steer','stale_turn','session/steer-unavailable'],['steer','not_human','session/steer-unavailable'],
  ]){
    await assert.rejects(change({kind:action,content:[{type:'text',text:'ok'}]},{async mutate(id,request){
      if(action==='steer')assert.equal(request.mutation.expected_turn_id,entry.turn);
      return {outcome:{result:'rejected',reason}};
    }}),{code});
  }
  await assert.rejects(change({kind:'remove'},{},async()=>undefined),{code:'session/queue-item-not-found'});
  await assert.rejects(change({kind:'steer'},{},async()=>({...entry,target:'next-step'})),{code:'session/steer-unavailable'});
  for(const [content,code] of [[[ {type:'file'} ],'session/attachment-invalid'],[[{type:'text',text:'  '}],'gateway/bad-request']]){
    await assert.rejects(change({kind:'edit',content},{},()=>assert.fail('invalid edit must not access the Session')),{code});
  }
});

test('withdrawal racing draft publication follows only the captured predecessor',async()=>{
  for(const replaced of [true,false]){
    let reads=0,mutations=0;
    const result=change({kind:'remove'},{
      discardDraft:async(id,ids)=>{assert.deepEqual(ids,[entry.nativeId]);throw Error('published');},
      async mutate(id,req){mutations++;assert.equal(req.expected_message_id,entry.nativeId);return {outcome:{result:'withdrawn'}};},
    },async()=>++reads===1?{...entry,kind:'draft'}:{...entry,nativeId:replaced?'other':entry.nativeId});
    if(replaced)await assert.rejects(result,{code:'session/queue-item-not-found'});else assert.equal(await result,source);
    assert.equal(mutations,replaced?0:1);
  }
});

test('only a committed removal releases the original prompt upload binding',async()=>{
  class TypertRemoteService {constructor(ctx){this.ctx=ctx;}}
  const agent={},retired=[];
  const ctx={get(name){return name==='agents'?{get:()=>agent}:{retirePrompt:(...args)=>retired.push(args)};}};
  let outcome={result:'rejected',reason:'claimed'};
  const Controller=sessionController({TypertRemoteService,RemoteError},{inbox:{mutate:async()=>({outcome})}},{queueItem:async()=>entry});
  const controller=new Controller(ctx),request={sessionId:'s',itemId:'original',action:{kind:'remove'}};
  await assert.rejects(controller.updateQueue(request),{code:'session/queue-item-not-found'});
  assert.deepEqual(retired,[]);
  outcome={result:'withdrawn'};
  assert.deepEqual(await controller.updateQueue(request),{accepted:true});
  assert.deepEqual(retired,[[agent,source.rpcId]]);
});
