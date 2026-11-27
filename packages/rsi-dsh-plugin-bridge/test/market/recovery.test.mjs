import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMarketProfile} from '../../src/market/market-profile.mjs';
import {fileURLToPath} from 'node:url';
import {crashProfile} from '../fixtures/staging-crash.mjs';

for(const point of ['prepared','snapshot','intent','roots','links','reconciled','committed']){
  test('replacement process loss after '+point+' recovers the authoritative generation',async t=>{
    const profile=await mkdtemp(join(tmpdir(),'rsi-staging-crash-'));
    t.after(()=>rm(profile,{recursive:true,force:true}));
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('../fixtures/staging-crash.mjs',import.meta.url)),profile,point],
      {encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(child.status,71,child.stderr);
    const fixture=crashProfile(profile);
    const market=await createMarketProfile(fixture.options);
    assert.deepEqual(await market.activate(),{ok:true});
    const version=point==='committed'?'2.0.0':'1.0.0';
    const manifest=await readFile(join(profile,'package.json'),'utf8');
    assert.equal(JSON.parse(manifest).dependencies.fixture,version);
    if(point!=='committed')assert.equal(manifest,await readFile(join(profile,'before.json'),'utf8'));
    assert.equal(await realpath(join(profile,'node_modules/fixture')),await realpath(fixture.payload(version)));
    assert.deepEqual(JSON.parse(await readFile(join(profile,'roots.json'),'utf8')),{[fixture.digest(version)]:'rsi-dsh-selection-fixture'});
    assert.equal(JSON.parse(await readFile(join(profile,'state/selections.json'),'utf8')).rollback,null);
  });
}

test('a process loss after restore cleanup recovers the exact pre-cleanup manifest',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-restore-crash-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const state=join(profile,'state'),path=join(profile,'package.json');
  const before=JSON.stringify({private:true,dependencies:{missing:'1.0.0'},dsh:{profile:{bundles:['missing']}}},null,2)+'\n';
  await writeFile(path,before);
  const source=`
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    import {join} from 'node:path';
    const [profile,module]=process.argv.slice(1);
    let failing=false,writes=0;
    const rename=fs.rename;
    fs.rename=async(from,to)=>{
      await rename(from,to);
      if(failing&&to===join(profile,'package.json')&&++writes===1)process.exit(71);
    };
    syncBuiltinESMExports();
    const {createMarketProfile}=await import(module);
    const market=await createMarketProfile({profile,state:join(profile,'state'),modules:{},call:async method=>{
      if(method==='application.stage.release')return null;
      if(method==='application.roots')return {};
      if(method==='application.stage'){failing=true;throw Error('unavailable package');}
      throw Error('unexpected '+method);
    }});
    await market.packageRunner.runPlugin(['install'],profile).done;
    throw Error('crash point was not reached');
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',source,profile,
    new URL('../../src/market/market-profile.mjs',import.meta.url).href],{encoding:'utf8',windowsHide:true});
  assert.equal(child.status,71,child.stderr);
  const journal=await readFile(join(state,'selections.json')).then(JSON.parse).catch(error=>{if(error.code!=='ENOENT')throw error;});
  assert.ok(journal?.rollback,'cleanup must publish recovery intent before changing the manifest');
  assert.notEqual(await readFile(path,'utf8'),before);
  await createMarketProfile({profile,state,modules:{},call:async()=>({})});
  assert.equal(await readFile(path,'utf8'),before);
  await assert.rejects(readFile(join(state,'selections.json')),{code:'ENOENT'});
});
