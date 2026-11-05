import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
