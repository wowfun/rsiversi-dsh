import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { MessageChannel } from 'node:worker_threads';
import { Peer, MAX_PENDING } from '../../src/runtime/transport.mjs';
import { MAX_FRAME_BYTES } from '../../src/runtime/frames.mjs';
import { discoverNode, runtimeEnvironment, supportsNode } from '../../src/runtime/node.mjs';

function pair(t, handler) {
  const a = new PassThrough(), b = new PassThrough();
  const left = new Peer({ input: b, output: a, generation: 'test', handler: async (_, value) => value });
  const right = new Peer({ input: a, output: b, generation: 'test', handler });
  t.after(() => { left.close(); right.close(); a.destroy(); b.destroy(); });
  return { left, right };
}

function portPair(t, handler) {
  const {port1,port2} = new MessageChannel();
  t.after(() => {port1.close();port2.close();});
  const left = new Peer({port:port1,generation:'test',handler:async (_,value)=>value});
  const right = new Peer({port:port2,generation:'test',handler});
  t.after(() => {left.close();right.close();});
  return {left,right};
}

test('a normal reply settles only after releasing its outbound slot',{timeout:5000},async t=>{
  const a=new PassThrough(),b=new PassThrough(),received=Promise.withResolvers();
  let release,settled=false;
  const output=new Writable({write(bytes,encoding,callback){a.write(bytes);release=callback;}});
  const left=new Peer({input:b,output,generation:'test',handler:()=>null});
  const right=new Peer({input:a,output:b,generation:'test',handler:()=>{received.resolve();return 'pong';}});
  t.after(()=>{left.close();right.close();a.destroy();b.destroy();output.destroy();});
  const first=left.request('extension.ping',null).then(value=>{settled=true;return value;});
  await received.promise;await new Promise(resolve=>setImmediate(resolve));
  try {assert.equal(settled,false,'the result must not promise reusable capacity before the write completes');}
  finally {release();await first;}
  const next=left.request('extension.ping',null);
  await new Promise(resolve=>setImmediate(resolve));release();
  assert.equal(await next,'pong');
});

for (const factory of [pair, portPair]) test(`${factory.name}: saturated business requests retain ping and close capacity`, async t => {
  const gate = Promise.withResolvers();
  const {left} = factory(t, method => method === 'work' ? gate.promise : null);
  const pending = Array.from({length: MAX_PENDING}, () => left.request('work', null));
  await assert.rejects(left.request('overflow', null), /capacity/);
  assert.equal(await left.request('extension.ping', null), null);
  assert.equal(await left.request('extension.close', null), null);
  await assert.rejects(left.request('after-close', null), /closing/);
  gate.resolve(true); await Promise.all(pending);
  assert.equal(left.closed, false);
});

for (const factory of [pair, portPair]) test(`${factory.name}: failed and cancelled close keep terminal draining but admit a close retry`,async t=>{
  const entered=Promise.withResolvers(),cancelled=Promise.withResolvers();let attempts=0;
  const {left}=factory(t,async(method,_,signal)=>{
    assert.equal(method,'extension.close');attempts++;
    if(attempts===1)throw Error('shutdown failed after retiring a callback');
    if(attempts===2){entered.resolve();signal.addEventListener('abort',cancelled.resolve,{once:true});await cancelled.promise;throw signal.reason;}
    return null;
  });
  const retryClose=async signal=>{
    const deadline=Date.now()+2000;
    for(;;){
      try {return await left.request('extension.close',null,{signal});}
      catch(error){
        if(error.message!=='request capacity'||Date.now()>=deadline)throw error;
        // The previous reply and its retained writes must both settle first.
        await new Promise(resolve=>setImmediate(resolve));
      }
    }
  };
  await assert.rejects(left.request('extension.close',null),/shutdown failed/);
  await assert.rejects(left.request('business',null),/extension closing/);
  const stop=new AbortController(),closing=left.request('extension.close',null,{signal:stop.signal});
  await entered.promise;stop.abort(new Error('close cancelled'));
  await assert.rejects(closing,/close cancelled/);await cancelled.promise;
  await assert.rejects(left.request('extension.ping',null),/extension closing/);
  assert.equal(await retryClose(),null);
  assert.equal(attempts,3);
});

test('worker messages detach payloads and preserve callbacks and cancellation', async t => {
  const {left,right} = portPair(t, async (method,value) => method==='review'?new Promise(()=>{}):value);
  const payload={text:'字'.repeat(100_000)},expected=structuredClone(payload);
  const result=left.request('echo',payload);payload.text='changed after sending';
  assert.deepEqual(await result,expected);
  assert.deepEqual(await right.request('callback',{receipt:42}),{receipt:42});
  const stop=new AbortController(),review=left.request('review',null,{signal:stop.signal});
  stop.abort(new Error('stop'));await assert.rejects(review,/stop/);
  assert.equal(await left.request('echo',true),true);
  assert.equal(left.closed,false);
});

test('worker port closure rejects outstanding work', async t => {
  const {left,right} = portPair(t, () => new Promise(()=>{}));
  const pending=left.request('wait',null);
  right.close();
  await assert.rejects(pending,/EOF/);
  assert.equal(left.closed,true);
});

test('worker ports retain request admission and release settled slots', async t => {
  const gate=Promise.withResolvers(),{left}=portPair(t,()=>gate.promise);
  const pending=Array.from({length:MAX_PENDING},()=>left.request('wait',null));
  await assert.rejects(left.request('overflow',null),/capacity/);
  gate.resolve(true);assert.deepEqual(await Promise.all(pending),Array(MAX_PENDING).fill(true));
  assert.equal(await left.request('after',null),true);
});

test('a stale worker message closes before entering the handler', async t => {
  const {port1,port2}=new MessageChannel(),closed=Promise.withResolvers();let calls=0;
  t.after(()=>{port1.close();port2.close();});
  const peer=new Peer({port:port1,generation:'current',handler:()=>calls++,onClose:closed.resolve});
  t.after(()=>peer.close());
  port2.postMessage({generation:'stale',message:{kind:'request',id:1,method:'read',payload:null}});
  assert.match((await closed.promise).message,/generation mismatch/);
  assert.equal(calls,0);
});
test('a pending review does not serialize commands or reverse callbacks', async t => {
  let answer; const wait = new Promise(resolve => { answer = resolve; });
  const { left, right } = pair(t, async (method, payload) => method === 'review' ? wait : payload);
  const review = left.request('review', null);
  assert.equal(await left.request('command', 'plan off'), 'plan off');
  assert.deepEqual(await right.request('callback', { receipt: 42 }), { receipt: 42 });
  answer(null);
  assert.equal(await review, null);
});
test('cancellation settles its slot without stopping unrelated requests', async t => {
  const { left } = pair(t, async method => method === 'review' ? new Promise(() => {}) : true);
  const controller = new AbortController();
  const pending = left.request('review', null, { signal: controller.signal });
  controller.abort(new Error('stop'));
  await assert.rejects(pending, /stop/);
  assert.equal(await left.request('command', null), true);
  assert.equal(left.closed, false);
});
test('a close frame rejected before sending does not start terminal draining',async t=>{
  const {left}=pair(t,async(_method,payload)=>payload);
  await assert.rejects(left.request('extension.close','x'.repeat(MAX_FRAME_BYTES)),/output capacity/);
  assert.equal(left.closed,false);
  assert.equal(await left.request('business','still open'),'still open');
  assert.equal(await left.request('extension.close',null),null);
});

test('oversized and stale frames close before handler execution', t => {
  const input = new PassThrough(), output = new PassThrough(); let calls = 0;
  const peer = new Peer({ input, output, generation: 'new', handler: () => { calls++; } });
  t.after(() => { peer.close(); input.destroy(); output.destroy(); });
  input.write(Buffer.alloc(MAX_FRAME_BYTES + 1, 32));
  assert.equal(peer.closed, true); assert.equal(calls, 0);
});
test('frames preserve split UTF-8 and accept multiple lines from one write', async t => {
  const input = new PassThrough(), output = new PassThrough(), received = [];
  const peer = new Peer({input, output, generation: 'test', handler: (_, value) => received.push(value)});
  t.after(() => { peer.close(); input.destroy(); output.destroy(); });
  const line = (id, payload) => JSON.stringify({generation:'test', message:{kind:'request', id, method:'read', payload}});
  const full = Buffer.from(line(1, '字'.repeat(3000)) + '\n' + line(2, 'next') + '\n');
  const split = full.indexOf('字') + 1, first = Buffer.from(full.subarray(0, split));
  input.write(first); first.fill(0);
  input.write(full.subarray(split, split + 200));
  input.write(full.subarray(split + 200));
  await new Promise(done => setImmediate(done));
  assert.deepEqual(received, ['字'.repeat(3000), 'next']);
});
test('the frame limit applies across fragments and excludes the newline', async t => {
  const input = new PassThrough(), output = new PassThrough(), sizes = [];
  const peer = new Peer({input, output, generation:'test', handler: (_, value) => sizes.push(value.length)});
  t.after(() => { peer.close(); input.destroy(); output.destroy(); });
  const line = value => JSON.stringify({generation:'test',message:{kind:'request',id:1,method:'read',payload:value}});
  const size = MAX_FRAME_BYTES - Buffer.byteLength(line(''));
  input.write(Buffer.from(line('x'.repeat(size))));
  input.write(Buffer.from('\n'));
  await new Promise(done => setImmediate(done));
  assert.deepEqual(sizes, [size]);
  input.write(Buffer.alloc(MAX_FRAME_BYTES));
  input.write(Buffer.from('x'));
  assert.ok(peer.closed);
});
test('rejects a non-string wire method before dispatch', async t => {
  const input = new PassThrough(), output = new PassThrough();
  let calls = 0;
  const peer = new Peer({input, output, generation:'test', handler: () => calls++});
  t.after(() => { peer.close(); input.destroy(); output.destroy(); });
  input.write(JSON.stringify({generation:'test',message:{kind:'request',id:1,method:null,payload:null}}) + '\n');
  await new Promise(done => setImmediate(done));
  assert.equal(calls, 0);
  assert.ok(peer.closed);
});
test('the generation must be a string at construction', () => {
  assert.throws(() => new Peer({generation: 42}), /invalid generation/);
});
test('Node probe rejects shims, scrubs configuration and returns actual executable', async () => {
  assert.equal(supportsNode('24.8.0'), false); assert.equal(supportsNode('24.9.0'), true);
  assert.deepEqual(runtimeEnvironment({ NODE_OPTIONS: '--inspect', NODE_PATH: 'bad', npm_config_registry: 'bad' }), {});
  await assert.rejects(discoverNode({ executable: 'fake.cmd' }));
  const result = await discoverNode({ executable: process.execPath });
  assert.equal(result.version, process.version);
});

test('cooperative cancellation keeps the caller pending until the remote cleanup reply',async t=>{
  const input=new PassThrough(),output=new PassThrough(),sent=[];
  output.on('data',bytes=>sent.push(JSON.parse(bytes.toString()).message));
  const peer=new Peer({input,output,generation:'drain',handler:()=>null});
  t.after(()=>{peer.close();input.destroy();output.destroy();});
  const controller=new AbortController();let settled=false;
  const work=peer.request('application.stage',{}, {signal:controller.signal,drainOnCancel:true}).finally(()=>{settled=true;});
  controller.abort();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);assert.deepEqual(sent.map(frame=>frame.kind),['request','cancel']);
  input.write(JSON.stringify({generation:'drain',message:{kind:'reply',id:sent[0].id,result:{status:'error',value:'cleanup finished'}}})+'\n');
  await assert.rejects(work,/cleanup finished/);
});

test('slow cooperative cleanup retains its slot without applying the ordinary cancellation deadline',async t=>{
  const peers=[];
  for(const drainOnCancel of [false,true]) {
    const input=new PassThrough(),output=new PassThrough(),sent=[];
    output.on('data',bytes=>sent.push(JSON.parse(bytes.toString()).message));
    const peer=new Peer({input,output,generation:'slow-drain',handler:()=>null});
    t.after(()=>{peer.close();input.destroy();output.destroy();});
    const stop=new AbortController();let settled=false;
    const work=peer.request('application.stage',{}, {signal:stop.signal,drainOnCancel});
    work.then(()=>{settled=true;},()=>{settled=true;});
    stop.abort();peers.push({peer,input,sent,work,settled:()=>settled});
  }
  await new Promise(resolve=>setTimeout(resolve,5500));
  assert.equal(peers[0].peer.closed,true,'ordinary cancellations still expire');
  const drain=peers[1];
  assert.equal(drain.peer.closed,false,'cleanup is allowed to outlast five seconds');
  assert.equal(drain.settled(),false);
  drain.input.write(JSON.stringify({generation:'slow-drain',message:{kind:'reply',id:drain.sent[0].id,result:{status:'ok',value:{cancelled:true}}}})+'\n');
  assert.deepEqual(await drain.work,{cancelled:true});
});

test('a carrier keeps cooperative cancellation attached through its forwarding hop',async t=>{
  const {port1,port2}=new MessageChannel();
  const entered=Promise.withResolvers(),cancelled=Promise.withResolvers(),cleanup=Promise.withResolvers();
  const server=new Peer({port:port1,generation:'drain',drainOnCancel:()=>true,handler:async(_method,_args,signal)=>{
    entered.resolve();signal.addEventListener('abort',cancelled.resolve,{once:true});
    await cancelled.promise;await cleanup.promise;return {cancelled:true};
  }});
  const client=new Peer({port:port2,generation:'drain',handler:()=>null});
  t.after(()=>{client.close();server.close();});
  const stop=new AbortController();let finished=false;
  const work=client.request('application.stage',{}, {signal:stop.signal,drainOnCancel:true}).then(value=>{finished=true;return value;});
  await entered.promise;stop.abort();await cancelled.promise;
  assert.equal(finished,false);cleanup.resolve();assert.deepEqual(await work,{cancelled:true});
});
