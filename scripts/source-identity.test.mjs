import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {sourceIdentity} from './source-identity.mjs';

test('source archives and edited checkouts build without reusing a clean commit receipt',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-build-input-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  assert.deepEqual(sourceIdentity(root),{revision:null,cacheable:false});
  const git=(...args)=>execFileSync('git',args,{cwd:root,windowsHide:true,encoding:'utf8'});
  git('init','--quiet');
  await writeFile(join(root,'input'),'one');
  git('add','input');
  git('-c','user.name=fixture','-c','user.email=fixture@invalid','-c','commit.gpgsign=false','commit','--quiet','-m','input');
  const revision=git('rev-parse','HEAD').trim();
  assert.deepEqual(sourceIdentity(root),{revision,cacheable:true});
  await writeFile(join(root,'input'),'two');
  assert.deepEqual(sourceIdentity(root),{revision,cacheable:false});
});

test('packing a built control preserves its client environment and never invokes a compiler',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-packed-control-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const put=async(path,bytes)=>{
    const file=join(root,path);
    await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes);
  };
  const names=['store','ui-slots','ui-primitives','ui-dockkit'];
  for(const name of names){
    const dir='packages/client/'+name;
    await put(dir+'/package.json',JSON.stringify({name:'@deepseek-ai/dsh-client-'+name,version:'1.0.0',main:'lib/index.js'}));
    await put(dir+'/lib/index.js','export const control = true;');
  }
  const record={environment:{DSH_CLIENT_TITLE:'Control build'},artifacts:{sha256:'a'.repeat(64)}};
  await put('.dsh-build/client-build-environment.json',JSON.stringify(record));
  await put('pnpm-lock.yaml','lockfileVersion: 9');
  for(const tool of ['typescript','tsdown','pnpm'])await put('node_modules/'+tool+'/package.json',
    JSON.stringify({version:'1.0.0',bin:{pnpm:'pack.cjs'}}));
  await put('node_modules/pnpm/pack.cjs',`
    const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
    if (!args.includes('pack') || !args.includes('--recursive')) throw Error('unexpected command');
    for (const option of args.filter(arg => arg.startsWith('--filter='))) {
      const name = option.slice('--filter='.length).replace('@', '').replace('/', '-');
      fs.writeFileSync(path.join(args.at(-1), name + '-1.0.0.tgz'), name);
    }
  `);
  const producer=fileURLToPath(new URL('./build-upstream.mjs',import.meta.url));
  const output=join(root,'packed');
  execFileSync(process.execPath,[producer,root,output,'--built'],{windowsHide:true});
  const receipt=JSON.parse(await readFile(join(output,'receipt.json')));
  assert.deepEqual(receipt.clientBuild,record);
  assert.equal(receipt.cacheable,false);
  assert.deepEqual(receipt.artifacts.map(a=>a.name).sort(),names.map(n=>'@deepseek-ai/dsh-client-'+n).sort());
});
