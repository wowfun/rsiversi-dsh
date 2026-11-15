import assert from 'node:assert/strict';
import {test} from 'node:test';
import {requestBoundary} from '../../src/application/request-boundary.mjs';
import {PassThrough} from 'node:stream';
import {Peer} from '../../../rsi-dsh-cordis/src/runtime/transport.mjs';
import {serveApplication,drainsOnCancel} from '../../src/application/entry.mjs';

test('a view callback cannot await a mutation that needs its own release',async()=>{
  const boundary=requestBoundary(),stop=new AbortController();
  const lease=await boundary.capture(new AbortController().signal,()=>{});
  let settled=false;
  const work=lease.run(()=>{lease.release();return boundary.run(()=>assert.fail('self mutation ran'),stop.signal);});
  work.then(()=>{settled=true;},()=>{settled=true;});
  try {
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,true,'self dependency must reject before waiting for drain');
    await assert.rejects(work,/view callback/);
    assert.equal(await boundary.run(()=>42),42,'rejection must not leave admission closed');
  } finally {stop.abort();lease.release();await work.catch(()=>{});await boundary.close();}
});

test('real worker and carrier keep a slow cancelled stage alive while ping remains available',async t=>{
  const input=new PassThrough(),output=new PassThrough();
  const entered=Promise.withResolvers(),cancelled=Promise.withResolvers();
  const carrier=serveApplication(input,output,'slow-stage',['slow-stage'],new URL('../fixtures/staging-cancel-worker.mjs',import.meta.url));
  const host=new Peer({input:output,output:input,generation:'slow-stage',drainOnCancel:drainsOnCancel,handler:async(method,_args,signal)=>{
    if(method==='fixture.wait')return entered.promise;
    assert.equal(method,'application.stage');
    signal.addEventListener('abort',cancelled.resolve,{once:true});entered.resolve();
    await cancelled.promise;await new Promise(resolve=>setTimeout(resolve,5500));
    return {cancelled:true};
  }});
  t.after(()=>{host.close();carrier.close();input.destroy();output.destroy();});
  let settled=false;
  const work=host.request('application.open',{});work.then(()=>{settled=true;},()=>{settled=true;});
  await cancelled.promise;
  assert.equal(await host.request('extension.ping',{}),null);assert.equal(settled,false);
  assert.deepEqual(await work,{cancelled:true});
  assert.equal(await host.request('extension.ping',{}),null);
  await host.request('extension.close',{});
});

test('queued mutation cancellation settles before leases drain without overtaking prior mutations',async()=>{
  const boundary=requestBoundary(),gate=Promise.withResolvers(),events=[];
  const lease=await boundary.capture(new AbortController().signal,()=>{});
  const first=boundary.run(async()=>{events.push('first');await gate.promise;});
  const stop=new AbortController();
  const cancelled=boundary.run(()=>assert.fail('cancelled mutation ran'),stop.signal);
  stop.abort();
  try {
    await assert.rejects(cancelled,{name:'AbortError'});
    const next=boundary.run(()=>events.push('next'));
    lease.release();await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(events,['first']);
    gate.resolve();await first;await next;assert.deepEqual(events,['first','next']);
  } finally {lease.release();gate.resolve();await boundary.close();}
});

test('shutdown releases every lease even when a selection disposer throws',async()=>{
  const boundary=requestBoundary(),disposed=[];
  await boundary.capture(new AbortController().signal,()=>{disposed.push('bad');throw Error('dispose failure');});
  const good=await boundary.capture(new AbortController().signal,()=>disposed.push('good'));
  await assert.rejects(boundary.close(),/dispose failure|selection disposal/);
  assert.equal(good.signal.aborted,true);assert.deepEqual(disposed,['bad','good']);
});

test('release waits for admitted callbacks, and nested mutations share the owner',async()=>{
  const boundary=requestBoundary(),body=Promise.withResolvers(),events=[];
  const lease=await boundary.capture(new AbortController().signal,()=>events.push('dispose'));
  const running=lease.run(async()=>{await body.promise;events.push('body');});
  const changing=boundary.run(()=>boundary.run(()=>events.push('change')));
  lease.release();assert.equal(lease.signal.aborted,true);
  await Promise.resolve();assert.deepEqual(events,[]);
  body.resolve();await running;await changing;
  assert.deepEqual(events,['body','dispose','change']);
  await boundary.close();
});

test('blocked capture cancels without holding a view or cancelling the mutation',async()=>{
  const boundary=requestBoundary(),body=Promise.withResolvers(),entered=Promise.withResolvers();
  const changing=boundary.run(async()=>{entered.resolve();await body.promise;});
  await entered.promise;
  const stop=new AbortController(),capturing=boundary.capture(stop.signal,()=>assert.fail('never admitted'));
  stop.abort();await assert.rejects(capturing,{name:'AbortError'});
  body.resolve();await changing;
  const next=await boundary.capture(new AbortController().signal,()=>{});next.release();
  await boundary.close();
});

test('shutdown cancels old work and pending changes without admitting another capture',async()=>{
  const boundary=requestBoundary(),body=Promise.withResolvers(),events=[];
  const lease=await boundary.capture(new AbortController().signal,()=>events.push('dispose'));
  const running=lease.run(()=>body.promise);
  const changing=boundary.run(()=>assert.fail('closed mutation'));
  const rejected=assert.rejects(changing,{name:'AbortError'});
  const closing=boundary.close();assert.equal(lease.signal.aborted,true);
  await assert.rejects(boundary.run(()=>assert.fail('new mutation after close')),{name:'AbortError'});
  await assert.rejects(boundary.capture(new AbortController().signal,()=>{}),{name:'AbortError'});
  assert.deepEqual(events,[]);
  body.resolve();await running;await rejected;await closing;
  assert.deepEqual(events,['dispose']);
});
