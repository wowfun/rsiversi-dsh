import assert from 'node:assert/strict';
import {test} from 'node:test';
import {projectionFrame,workbenchControl} from '../../src/workbench/control.mjs';

test('a changed baseline at an already delivered cursor does not manufacture a Session event',()=>{
  const baseline={asOfSeq:3,values:{title:'one'}};
  assert.equal(projectionFrame(baseline,{...baseline,values:{...baseline.values,newPlugin:true}}),undefined);
});

test('slow receivers get every changed event with its ordered replacements in one frame',async()=>{
  let checks=0;
  const service=workbenchControl(async()=>{checks++;}),life=new AbortController();
  const snapshot=(seq,title,status)=>({asOfSeq:seq,values:{fixed:{large:['unchanged']},title,status}});
  const owner=service.open('one',snapshot(0,'old','idle')),stream=service.control(life.signal);
  assert.equal((await stream.next()).value.type,'baseline');
  owner.publish(snapshot(1,'new','waiting'));owner.publish(snapshot(2,'new','running'));
  owner.publish(snapshot(3,'new','running'));
  const frames=[(await stream.next()).value,(await stream.next()).value];
  assert.deepEqual(frames,[{type:'projection',sessionId:'one',seq:1,changes:[{key:'title',val:'new'},{key:'status',val:'waiting'}]},
    {type:'projection',sessionId:'one',seq:2,changes:[{key:'status',val:'running'}]}]);
  owner.publish(snapshot(4,'first','running'));owner.publish(snapshot(5,'first','idle'));
  owner.publish(snapshot(6,'last','idle'));
  assert.deepEqual([(await stream.next()).value,(await stream.next()).value,(await stream.next()).value].map(frame=>frame.seq),[4,5,6]);
  const waiting=stream.next();
  owner.publish(snapshot(7,'last','idle'));
  await new Promise(resolve=>setImmediate(resolve));life.abort();
  assert.equal((await waiting).done,true);assert.ok(checks>1);
  const again=service.control(new AbortController().signal);
  assert.deepEqual((await again.next()).value.value.projections.one,snapshot(7,'last','idle'));
  await again.return();owner.close();
});

test('all admitted active histories are available in the reconnect baseline',async()=>{
  const service=workbenchControl(async()=>{}),owners=[];
  const stream=service.control(new AbortController().signal);
  try {
    for(let n=0;n<257;n++)owners.push(service.open(String(n),{asOfSeq:n,values:{title:String(n)}}));
    assert.equal(Object.keys((await stream.next()).value.value.projections).length,257);
  } finally {await stream.return();for(const owner of owners)owner.close();}
});

test('an empty native draft has a baseline cursor, never a negative projection event sequence',async()=>{
  const service=workbenchControl(async()=>{}),life=new AbortController(),flow=service.control(life.signal);
  assert.equal((await flow.next()).value.type,'baseline');
  const draft=service.open('empty',{asOfSeq:-1,values:{modelSelection:{next:{provider:'native',model:'m'}}}});
  const waiting=flow.next();
  await new Promise(resolve=>setImmediate(resolve));
  draft.publish({asOfSeq:0,values:{modelSelection:{next:{provider:'native',model:'chosen'}}}});
  const frame=(await waiting).value;
  assert.equal(frame.seq,0);assert.equal(frame.changes[0].val.next.model,'chosen');
  life.abort();await flow.return();draft.close();
});

test('control baselines authorize receivers and preserve active mirror updates across browser handoff',async()=>{
  const visible=new Set(['shared']),checks=[];
  const service=workbenchControl(async id=>{checks.push(id);if(!visible.has(id))throw Error('unavailable');});
  const value=seq=>({asOfSeq:seq,values:{modelSelection:{next:{provider:'native',model:String(seq)}}}});
  const first=service.open('shared',value(2)),privateView=service.open('private',value(4));
  const life=new AbortController(),stream=service.control(life.signal);
  assert.deepEqual({...((await stream.next()).value.value.projections)},{shared:value(2)});
  const second=service.open('shared',value(2));first.close();
  second.publish(value(3));second.publish(value(5));second.publish(value(4));
  for(const seq of [3,5])assert.deepEqual((await stream.next()).value,{type:'projection',sessionId:'shared',seq,
    changes:[{key:'modelSelection',val:value(seq).values.modelSelection}]});
  const reopened=service.control(life.signal);
  assert.deepEqual({...((await reopened.next()).value.value.projections)},{shared:value(5)});
  visible.delete('shared');second.publish(value(6));
  const waiting=stream.next();
  await new Promise(resolve=>setImmediate(resolve));
  life.abort();assert.equal((await waiting).done,true);
  await reopened.return();second.close();privateView.close();
  const empty=service.control(new AbortController().signal);
  assert.deepEqual(Object.keys((await empty.next()).value.value.projections),[]);await empty.return();
  assert.ok(checks.filter(id=>id==='shared').length>=4);
});
