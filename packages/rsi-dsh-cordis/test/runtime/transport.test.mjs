import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { MessageChannel } from 'node:worker_threads';
import { Peer, MAX_FRAME_BYTES, MAX_PENDING } from '../../src/runtime/transport.mjs';
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
