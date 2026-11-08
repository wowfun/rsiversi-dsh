import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeMarketServiceProfile} from '../../../../scripts/market-service-profile.mjs';

test('OS-home runtime downloads stay outside the portable market profile',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-market-home-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const state=join(dir,'state'),profile=join(state,'web-applications/market');
  const receipt=join(dir,'receipt.json'),output=join(dir,'host.profile.toml');
  await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dependencies:{}}));
  await writeFile(receipt,JSON.stringify({selection:{name:'runtime',digest:'a'.repeat(64)}}));
  await writeMarketServiceProfile({receipt,document:dir,state,profile:'market',output});
  const config=await readFile(output,'utf8');
  // The producer emits an inline TOML table of JSON-quoted string fields.
  const table=/^environment = \{(.*)\}$/m.exec(config)[1];
  const env=JSON.parse('{'+table.replace(/("(?:[^"\\]|\\.)*") = /g,'$1:')+'}');
  const downloaded=execFileSync(process.execPath,['--input-type=module','-e',`
    import {homedir} from 'node:os';
    import {join,dirname} from 'node:path';
    import {mkdirSync,writeFileSync} from 'node:fs';
    const path=join(homedir(),'AppData/Local/node/corepack/pnpm/runtime.bin');
    mkdirSync(dirname(path),{recursive:true});writeFileSync(path,Buffer.alloc(2*1024*1024));
    console.log(path);
  `],{env,encoding:'utf8',windowsHide:true}).trim();
  const fromProfile=relative(profile,downloaded),fromState=relative(state,downloaded);
  assert.ok(fromProfile.startsWith('..')||isAbsolute(fromProfile));
  assert.ok(fromState&&!fromState.startsWith('..')&&!isAbsolute(fromState));
  assert.equal(env.DSH_HOME,profile);
  assert.ok(config.includes(JSON.stringify(join(state,'web-applications/.selections/market/attachments/v1'))));
  if(process.env.RSI_DSH_MARKET_COHORT){
    const {createProfileBackup}=await import(pathToFileURL(join(process.env.RSI_DSH_MARKET_COHORT,'node_modules/dshmarket/lib/backup.js')));
    const backup=createProfileBackup('market',profile);
    assert.deepEqual(backup.files.map(file=>file.path),['package.json']);
    assert.ok(Buffer.byteLength(JSON.stringify(backup))<1024);
  }
});
