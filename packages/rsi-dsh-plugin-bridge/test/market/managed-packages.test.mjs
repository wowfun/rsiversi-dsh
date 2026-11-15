import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {managedPackages} from '../../src/market/managed-packages.mjs';
import {createMarketProfile} from '../../src/market/market-profile.mjs';
import {requestBoundary} from '../../src/application/request-boundary.mjs';
const cohort=process.env.RSI_DSH_MARKET_COHORT;
async function fixture(t){
  const profile=await mkdtemp(join(tmpdir(),'rsi-stage-controls-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const require=createRequire(join(cohort,'package.json')),boundary=requestBoundary();
  t.after(()=>boundary.close());
  const market=await createMarketProfile({profile,state:join(profile,'state'),boundary,
    modules:{entry:require.resolve},call:async()=>({})});
  class Original {
    listBundles(){return [];}
    registries(){return {registry:'https://registry.npmjs.org/',resolved:'https://registry.npmjs.org/',fallbackRegistries:[]};}
  }
  const ctx={effect(){},emit(){},parallel:async()=>{}};
  const Manager=managedPackages(Original,()=>market,{parseInstallSpec:()=>({kind:'registry',name:'fixture'}),classifyInstallFailure:()=> 'unknown'});
  return {manager:new Proxy(new Manager(ctx,{}),{}),market,boundary};
}
test('queued cancellation joins without starting preparation or waiting for the preceding writer',{skip:!cohort},async t=>{
  const {manager,market,boundary}=await fixture(t);
  const held=Promise.withResolvers(),entered=Promise.withResolvers();
  const writer=market.exclusive(async()=>{entered.resolve();await held.promise;});
  await entered.promise;
  market.prepare=()=>assert.fail('cancelled queue entry prepared');
  const work=manager.installBundle('fixture@1',{requestId:'queued'});
  assert.equal(manager.waitForInstall('queued'),work);
  assert.equal((await manager.cancelInstall('queued')).status,'cancelled');
  assert.equal((await work).application,'cancelled');
  const view=await boundary.capture(new AbortController().signal,()=>{});view.release();
  held.resolve();await writer;
});
test('preparation cancellation waits for importer cleanup',{skip:!cohort},async t=>{
  const {manager,market}=await fixture(t);
  const entered=Promise.withResolvers(),cancelled=Promise.withResolvers(),cleaned=Promise.withResolvers();
  market.prepare=async(_spec,signal)=>{entered.resolve();signal.addEventListener('abort',cancelled.resolve,{once:true});
    await cancelled.promise;await cleaned.promise;throw signal.reason;};
  const work=manager.installBundle('fixture@1',{requestId:'preparing'});await entered.promise;
  let settled=false;const cancellation=manager.cancelInstall('preparing').then(result=>{settled=true;return result;});
  await cancelled.promise;assert.equal(settled,false);cleaned.resolve();
  assert.equal((await cancellation).status,'cancelled');assert.equal((await work).application,'cancelled');
});
test('commit cancellation is too late and keeps its candidate until commit settles',{skip:!cohort},async t=>{
  const {manager,market}=await fixture(t);
  const entered=Promise.withResolvers(),finish=Promise.withResolvers();let disposed=false;
  market.prepare=async()=>({dispose:async()=>{disposed=true;}});
  market.commitBundle=async(_candidate,_enabled,onApply)=>{onApply();entered.resolve();await finish.promise;return {application:'applied',changed:true};};
  const work=manager.installBundle('fixture@1',{requestId:'applying'});await entered.promise;
  assert.equal((await manager.cancelInstall('applying')).status,'too-late');assert.equal(disposed,false);
  finish.resolve();assert.equal((await work).application,'applied');assert.equal(disposed,true);
});

test('a lost cleanup acknowledgement is not reported as confirmed cancellation',{skip:!cohort},async t=>{
  const {manager,market}=await fixture(t);
  const entered=Promise.withResolvers(),cancelled=Promise.withResolvers();
  market.prepare=async(_spec,signal)=>{entered.resolve();signal.addEventListener('abort',cancelled.resolve,{once:true});
    await cancelled.promise;throw new Error('connection lost before cleanup acknowledgement');};
  const work=manager.installBundle('fixture@1',{requestId:'lost'});await entered.promise;
  await assert.rejects(manager.cancelInstall('lost'),/cleanup was not confirmed/);
  assert.equal((await work).application,'failed');
});

test('candidate cleanup preserves the commit diagnostic and does not confirm failed cancellation cleanup',{skip:!cohort},async t=>{
  const {manager,market}=await fixture(t);
  market.prepare=async()=>({dispose:async()=>{throw Error('stage release lost');}});
  market.commitBundle=async()=>{throw Error('candidate activation failed');};
  const result=await manager.installBundle('fixture@1');
  assert.match(result.error.diagnostic,/candidate activation failed/);
  assert.match(result.error.diagnostic,/stage release lost/);

  const entered=Promise.withResolvers();
  market.commitBundle=async(_candidate,_enabled,_apply,signal)=>{
    entered.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw signal.reason;
  };
  const work=manager.installBundle('fixture@1',{requestId:'cleanup-lost'});await entered.promise;
  await assert.rejects(manager.cancelInstall('cleanup-lost'),/cleanup was not confirmed/);
  assert.equal((await work).application,'failed');
});

test('view callbacks reject before joining a writer already waiting for their view',{skip:!cohort},async t=>{
  const {manager,market,boundary}=await fixture(t);
  const view=await boundary.capture(new AbortController().signal,()=>{});
  const writer=market.mutate(()=>42);
  market.prepare=()=>assert.fail('self-dependent install must not prepare');
  let result;
  const callback=view.run(async()=>{result=await manager.installBundle('fixture@1',{requestId:'self'});});
  try {
    await new Promise(resolve=>setImmediate(resolve));
    assert.match(result?.error?.diagnostic??'pending',/view callback/);
    await callback;
  } finally {
    await manager.cancelInstall('self');view.release();await callback;await writer;
  }
});
