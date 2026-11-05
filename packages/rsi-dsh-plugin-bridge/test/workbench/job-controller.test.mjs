import assert from 'node:assert/strict';
import {test} from 'node:test';
import {jobController} from '../../src/workbench/job-controller.mjs';

test('job streams admit the requested native Session once and allow sessionless reads of unowned jobs',async t=>{
  const admissions=[],calls=[];
  class RegistryController {
    async *list(request){calls.push(['list',request]);yield 'initial';yield 'changed';}
    async *follow(request){calls.push(['follow',request]);yield 'opened';yield 'output';}
    kill(request){calls.push(['kill',request]);return 'requested';}
  }
  const Controller=jobController(RegistryController,{metadata(id,signal){
    admissions.push(id);assert.equal(signal,t.signal);return id==='child'?{id}:null;
  }});
  const jobs=new Controller(),child={sessionId:'child'},owned={...child,jobId:'owned'};
  const unowned={jobId:'shared'},hidden={sessionId:'hidden',jobId:'private'};
  assert.deepEqual(await Array.fromAsync(jobs.list(child,t.signal)),['initial','changed']);
  assert.deepEqual(await Array.fromAsync(jobs.follow(owned,t.signal)),['opened','output']);
  assert.deepEqual(await Array.fromAsync(jobs.follow(unowned,t.signal)),['opened','output']);
  assert.equal(await jobs.kill(owned,t.signal),'requested');
  await assert.rejects(Array.fromAsync(jobs.list(hidden,t.signal)),/Session unavailable/);
  await assert.rejects(Array.fromAsync(jobs.follow(hidden,t.signal)),/Session unavailable/);
  await assert.rejects(jobs.kill(hidden,t.signal),/Session unavailable/);
  assert.deepEqual(admissions,['child','child','child','hidden','hidden','hidden']);
  assert.deepEqual(calls,[['list',child],['follow',owned],['follow',unowned],['kill',owned]]);
});
