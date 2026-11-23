import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {readSessionState,observeSessionState} from '../../src/workbench/session-state.mjs';

test('activation during a cold read publishes live queue placement and only this Session’s pending input',async()=>{
  const agents=new Map(),id='one',stop=new AbortController();
  const pending=['approval/request','approval/request','user-questions/request','plugin/input']
    .map(event=>({agentId:id,event}));
  pending.unshift({agentId:'two',event:'plugin/input'});
  const services={agents,typertGateway:{getPendingRemoteEvents:()=>pending}};
  const ctx={get:name=>services[name]};
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const history={metadata:async()=>({id,cwd:'/work'}),capture:async()=>{
    entered.resolve();await release.promise;return {seq:1,header:{cwd:'/work'}};
  }};
  const answer=readSessionState(ctx,history,Error,id,stop.signal);
  await entered.promise;
  const text=[{type:'text',text:'queued'}];
  agents.set(id,{session:{header:{cwd:'/work'},seq:9},status:'running',inbox:{
    nextTurn:[{id:'a',source:{kind:'user',rpcId:'request'},content:text}],
    nextStep:[{id:'b',source:{kind:'user'},content:text},{id:'c',source:{kind:'plugin'},content:text}],
  }});
  release.resolve();
  const expected={cursor:8,active:true,running:true,queue:[
    {id:'a',placement:'queued',content:text,rpcId:'request'},
    {id:'b',placement:'steering',content:text},{id:'c',placement:'context',content:text},
  ],pendingInput:['approval','question','other']};
  assert.deepEqual(await answer,expected);
  assert.deepEqual(await readSessionState(ctx,undefined,Error,id,stop.signal),expected);
  const missing=readSessionState(ctx,{metadata:async()=>undefined},class extends Error{
    constructor(code,message,details){super(message);this.code=code;this.details=details;}
  },'absent',stop.signal);
  await assert.rejects(missing,{code:'session/not-found',details:{sessionId:'absent'}});
});

test('state observers coalesce addressed changes during a read and release all listeners on retirement',async()=>{
  const bus=new EventEmitter(),stop=new AbortController(),entered=Promise.withResolvers(),release=Promise.withResolvers();
  let dispose,reads=0;
  const ctx={on(event,fn){bus.on(event,fn);return ()=>bus.off(event,fn);},
    effect(setup){dispose=setup();return dispose;}};
  const states=observeSessionState(ctx,'one',stop.signal,async()=>{
    const sample=++reads;
    if(sample===1){entered.resolve();await release.promise;}
    return sample;
  });
  const first=states.next();await entered.promise;
  bus.emit('session/event',{id:'one'});
  bus.emit('agent/status',{agent:{id:'one'}});
  release.resolve();
  assert.deepEqual(await first,{value:2,done:false});
  const next=states.next();
  bus.emit('session/created',{id:'two'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,2);
  bus.emit('agent/disposed',{agent:{id:'one'}});
  assert.deepEqual(await next,{value:3,done:false});
  const waiting=states.next();dispose();
  assert.equal((await waiting).done,true);
  assert.deepEqual(bus.eventNames(),[]);
});
