import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {replayableInstalls} from '../../src/market/install-receipts.mjs';

const cohort=process.env.RSI_DSH_MARKET_COHORT;
test('lost replies, concurrent retries and interrupted installs preserve their original request identity',{skip:!cohort},async t=>{
  const state=await mkdtemp(join(tmpdir(),'rsi-install-receipts-'));
  t.after(()=>rm(state,{recursive:true,force:true}));
  const require=createRequire(join(cohort,'package.json'));
  const atomic=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')));
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  let runs=0;
  class Manager {
    async installBundle() {runs++;entered.resolve();await release.promise;return {changed:true,application:'applied'};}
  }
  const instance=async()=>new (await replayableInstalls(Manager,state,atomic))();
  const manager=await instance(),spec='demo@1.2.3',options={requestId:'stable-id',enabled:true};
  const first=manager.installBundle(spec,options);
  await entered.promise;
  const concurrent=manager.installBundle(spec,{enabled:true,requestId:'stable-id'});
  assert.equal(first,concurrent);
  await assert.rejects(manager.installBundle('other',options),/different arguments/);
  const disconnected=await instance();
  await assert.rejects(disconnected.installBundle(spec,options),/interrupted/);
  release.resolve();
  const result=await concurrent;
  const restarted=await instance();
  assert.deepEqual(await restarted.installBundle(spec,options),result);
  await assert.rejects(restarted.installBundle(spec,{...options,enabled:false}),/different arguments/);
  assert.equal(runs,1);

  const cancelled=Promise.withResolvers();
  class Cancellable {
    installBundle() {return cancelled.promise;}
    cancelInstall() {cancelled.resolve({changed:false,application:'cancelled'});return {status:'cancelled'};}
  }
  const manager2=new (await replayableInstalls(Cancellable,state,atomic))();
  const options2={requestId:'cancel-before-admission'};
  const submitted=manager2.installBundle(spec,options2);
  assert.deepEqual(await manager2.cancelInstall(options2.requestId),{status:'cancelled'});
  assert.equal((await submitted).application,'cancelled');
  assert.equal((await restarted.installBundle(spec,options2)).application,'cancelled');
});
