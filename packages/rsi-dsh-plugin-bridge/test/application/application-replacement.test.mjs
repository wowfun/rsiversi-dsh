import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {createApplication} from '../../src/application/application.mjs';
import {fixtureTools} from '../fixtures/tool-host.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {requestBoundary} from '../../src/application/request-boundary.mjs';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';

const root=process.env.RSI_DSH_MARKET_COHORT;
async function fixture(t,options={}) {
  const directory=await mkdtemp(join(tmpdir(),'rsi-code-replacement-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const profile=join(directory,'profile');await mkdir(profile);
  const selected=new Map(),events=[];
  const require=createRequire(join(root,'package.json'));
  const app=await createApplication({profile,...options,
    modules:{entry:name=>selected.get(name)??require.resolve(name)},
    provide:async (ctx,load)=>{ctx.provide('testEvents',events);await options.provide?.(ctx,load,directory);}});
  t.after(()=>app.close());
  async function code(name,version,body) {
    const path=join(directory,name+'-'+version);await mkdir(path);
    const file=join(path,'entry.mjs');await writeFile(file,body);
    selected.set(name,file);return path;
  }
  const rows=[{insert:[{id:'probe',name:'probe',config:{value:'original'}}]}];
  return {app,events,rows,code,selected};
}
const implementation=version=>`export function apply(ctx,config){
  ctx.provide('replacementProbe',{version:'${version}',value:config.value});
  ctx.effect(()=>()=>ctx.testEvents.push('dispose ${version}'));
}`;

test('plugins enabled later receive the same immutable launch environment as the root',{skip:!root},async t=>{
  const key='RSI_DSH_LAUNCH_FIXTURE';
  const previous=process.env[key];
  t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
  process.env[key]='at boot';
  const f=await fixture(t);
  process.env[key]='after boot';
  await f.code('probe','v1',`export const inject=['launchEnvironment'];
    export function apply(ctx){ctx.provide('fixtureEnvironment',ctx.launchEnvironment);}`);
  await f.app.reconcile(f.rows);
  const snapshot=f.app.ctx.get('fixtureEnvironment');
  assert.ok(snapshot);
  assert.equal(snapshot,f.app.ctx.get('launchEnvironment'));
  assert.deepEqual(snapshot.getFrom(key,['process']),{value:'at boot',source:'process'});
  assert.equal(snapshot.getFrom(key,['project-env','user-env']),undefined);
});

test('replacement may remove an obsolete export before the next composition mounts',{skip:!root},async t=>{
  const f=await fixture(t);
  await f.code('probe','v1',implementation('v1'));await f.app.reconcile(f.rows);
  f.selected.delete('probe');
  await f.code('renamed','v2',implementation('v2'));
  await f.app.reconcile([{insert:[{id:'renamed',name:'renamed',config:{value:'new'}}]}]);
  assert.equal(f.app.ctx.replacementProbe.version,'v2');
  assert.equal([...f.app.ctx.loader.entries()].some(entry=>entry.options.id==='probe'),false);
});

test('failed code replacement restores removed siblings and drops candidate-only entries',{skip:!root},async t=>{
  const f=await fixture(t);
  await f.code('probe','v1',implementation('v1'));
  await f.code('sibling','v1',"export function apply(ctx){ctx.provide('siblingProbe','old')}");
  const rows=[{insert:[...f.rows[0].insert,{id:'sibling',name:'sibling'}]}];
  await f.app.reconcile(rows);
  f.selected.delete('sibling');
  await f.code('probe','v2',implementation('v2'));
  await f.code('broken','v2',"export function apply(){throw Error('candidate sibling failed')}");
  await assert.rejects(f.app.reconcile([{insert:[...f.rows[0].insert,{id:'broken',name:'broken'}]}]),/candidate sibling failed/);
  assert.equal(f.app.ctx.replacementProbe.version,'v1');
  assert.equal(f.app.ctx.siblingProbe,'old');
  assert.equal([...f.app.ctx.loader.entries()].some(entry=>entry.options.id==='broken'),false);
});

test('same-row replacement imports the selected code and releases the old payload',{skip:!root},async t=>{
  const f=await fixture(t);
  const old=await f.code('probe','v1',implementation('v1'));
  await f.app.reconcile(f.rows);
  assert.equal(f.app.ctx.replacementProbe.version,'v1');
  const next=await f.code('probe','v2',implementation('v2'));
  await f.app.reconcile(f.rows);
  assert.equal(f.app.ctx.replacementProbe.version,'v2');
  assert.deepEqual(f.events,['dispose v1']);
  assert.equal(f.app.usesPayload([old]),false);
  assert.equal(f.app.usesPayload([next]),true);
});

test('import failure does not retire the running implementation',{skip:!root},async t=>{
  const f=await fixture(t);
  await f.code('probe','v1',implementation('v1'));await f.app.reconcile(f.rows);
  await f.code('probe','invalid','export function apply( {');
  await assert.rejects(f.app.reconcile(f.rows),SyntaxError);
  assert.equal(f.app.ctx.replacementProbe.version,'v1');
  assert.deepEqual(f.events,[]);
});

test('activation failure restores the exact old module and config',{skip:!root},async t=>{
  const f=await fixture(t);
  const old=await f.code('probe','v1',implementation('v1'));await f.app.reconcile(f.rows);
  await f.code('probe','v2',"export function apply(){throw Error('candidate failure')}");
  await assert.rejects(f.app.reconcile([{insert:[{id:'probe',name:'probe',config:{value:'candidate'}}]}]),/candidate failure/);
  assert.equal(f.app.ctx.replacementProbe.version,'v1');
  assert.equal(f.app.ctx.replacementProbe.value,'original');
  assert.equal(f.app.usesPayload([old]),true);
});

test('configuration failure retains successful sibling changes',{skip:!root},async t=>{
  const f=await fixture(t);
  await f.code('probe','v1',implementation('v1'));await f.app.reconcile(f.rows);
  await f.code('broken','v1',"export function apply(){throw Error('broken sibling')}");
  await assert.rejects(f.app.reconcile([{insert:[
    {id:'probe',name:'probe',config:{value:'changed'}},{id:'broken',name:'broken'},
  ]}]),/broken sibling/);
  assert.equal(f.app.ctx.replacementProbe.value,'changed');
});

test('shared implementations restart every owning entry without disabling peers',{skip:!root},async t=>{
  const f=await fixture(t);
  const body=version=>`export function apply(ctx,config){ctx.provide(config.service,'${version}');}`;
  await f.code('first','v1',body('v1'));
  f.selected.set('second',f.selected.get('first'));
  const rows=[{insert:[{id:'first',name:'first',config:{service:'firstProbe'}},
    {id:'second',name:'second',config:{service:'secondProbe'}}]}];
  await f.app.reconcile(rows);
  await f.code('first','v2',body('v2'));
  await f.app.reconcile(rows);
  assert.equal(f.app.ctx.firstProbe,'v2');
  assert.equal(f.app.ctx.secondProbe,'v1');
  assert.ok([...f.app.ctx.loader.entries()].every(entry=>entry.options.disabled!==true));
});

test('replacement retains the old payload and services until admitted work drains',{skip:!root},async t=>{
  const boundary=requestBoundary();
  const f=await fixture(t,{boundary});
  const old=await f.code('probe','v1',implementation('v1'));await f.app.reconcile(f.rows);
  await f.code('probe','v2',implementation('v2'));
  const lease=await boundary.capture(new AbortController().signal,()=>{});
  const replacing=f.app.reconcile(f.rows);
  try {
    await setImmediate();
    assert.equal(f.app.ctx.replacementProbe.version,'v1');
    assert.equal(f.app.usesPayload([old]),true);
    assert.deepEqual(f.events,[]);
  } finally {lease.release();await replacing;}
  assert.equal(f.app.ctx.replacementProbe.version,'v2');
  assert.equal(f.app.usesPayload([old]),false);
});

test('real HTTP capture drains the old response batch before admitting replacement tools',{skip:!root},async t=>{
  const boundary=requestBoundary(),key=randomUUID();let listener;
  const captureReady=Promise.withResolvers(),enter=boundary.capture;let captures=0;
  boundary.capture=(...args)=>{if(++captures===25)captureReady.resolve();return enter(...args);};
  const sessions=applicationSessions(()=>{throw Error('unexpected native request');});
  const f=await fixture(t,{boundary,provide:async(ctx,load,directory)=>{
    for(const name of ['dsh-session-projection','dsh-system-prompt','dsh-tools'])
      await ctx.plugin((await load('@deepseek-ai/'+name)).default);
    listener=await fixtureTools(ctx,{load,key,generation:randomUUID(),directory:join(directory,'outcomes'),sessions,boundary});
  }});
  t.after(()=>sessions.close());
  const body=version=>`export const inject=['tools'];export function apply(ctx){
    ctx.tools.register({name:'probe',description:'${version}',parameters:{},
      output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute(){return '${version}';}});
    ctx.effect(()=>()=>ctx.testEvents.push('dispose ${version}'));
  }`;
  const post=async(path,input)=>{
    const response=await fetch('http://127.0.0.1:'+listener.port+'/v1/'+path,{method:'POST',headers:{authorization:key},body:JSON.stringify(input)});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
  };
  const capture=()=>post('capture',{view:randomUUID(),header:{id:'replacement',cwd:f.app.ctx.baseUrl},reserved:[],modelSelection:{provider:'fixture',model:'fixture'}});
  const invoke=view=>{
    const effect=randomUUID();
    return post('start',{view:view.view,session:'replacement',effect,name:'probe',args:{},registration:view.tools[0].registration,
      identity:{owner_id:'owner',invocation_id:effect,call_id:randomUUID(),request_sha256:'a'.repeat(64)}});
  };
  await f.code('probe','v1',body('v1'));await f.app.reconcile(f.rows);
  const old=await capture();assert.equal((await invoke(old)).result.value,'v1');
  await f.code('probe','v2',body('v2'));
  const replacing=f.app.reconcile(f.rows);await setImmediate();
  const next=Array.from({length:24},capture);
  await captureReady.promise;
  assert.equal((await invoke(old)).result.value,'v1');
  assert.deepEqual(f.events,[]);
  await post('release',{view:old.view});await replacing;
  const fresh=await Promise.all(next);assert.equal((await invoke(fresh[0])).result.value,'v2');
  assert.deepEqual(f.events,['dispose v1']);
  for(const view of fresh)await post('release',{view:view.view});
});
