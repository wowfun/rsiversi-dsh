import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applicationSessions} from '../../src/application/sessions.mjs';

for(const outcome of ['held','durable','lost-reply','aborted'])test(`native draft ownership cleans up ${outcome}`,async()=>{
  const calls=[],held=new Set(),stop=new AbortController();
  const scope=applicationSessions(async(method,args,signal)=>{
    assert.equal(method,'application.inbox');assert.equal(args.request,'application-owner');assert.equal(args.session_id,'one');
    assert.equal(signal.aborted,false,'cleanup escapes the aborted acquisition');calls.push(args.operation);
    const {type,key}=args.operation;
    if(type==='retain_draft'){
      if(outcome==='durable')return false;
      held.add(key);
      if(outcome==='lost-reply')throw Error('lost reply');
      if(outcome==='aborted')stop.abort(Error('setup aborted'));
      return true;
    }
    assert.equal(type,'release_draft');assert.ok(held.delete(key));return null;
  },{owner:'application-owner'});
  try {
    if(outcome==='lost-reply'||outcome==='aborted')await assert.rejects(scope.retainDraft('one',stop.signal),/lost reply|setup aborted/);
    else {
      const release=await scope.retainDraft('one',stop.signal);
      assert.equal(held.size,outcome==='held'?1:0);
      await Promise.all([release(),release()]);
    }
    assert.equal(held.size,0);
    assert.equal(calls.length,outcome==='durable'?1:2);
    if(calls.length===2)assert.equal(calls[0].key,calls[1].key);
  }finally{await scope.close();}
});
