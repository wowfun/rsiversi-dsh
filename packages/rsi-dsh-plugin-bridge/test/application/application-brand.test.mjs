import assert from 'node:assert/strict';
import {chmod,mkdtemp,readFile,rm,stat,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {publishBrand} from '../../src/application/brand.mjs';

test('reopening preserves the DSH client revision until the original brand changes',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-brand-revision-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const profile=join(dir,'brand'),logo=join(dir,'logo.svg');
  const official={client:join(dir,'official.js'),inject:[]};
  await writeFile(logo,'svg');
  await writeFile(official.client,'/* first */');
  await publishBrand(profile,logo,official);
  const client=join(profile,'src/browser/brand.client.js');
  await utimes(client,1,1);
  const revision=async()=>{
    const {mtimeMs,ctimeMs,size}=await stat(client);
    return [mtimeMs,ctimeMs,size];
  };
  const before=await revision();
  await publishBrand(profile,logo,official);
  assert.deepEqual(await revision(),before);
  await writeFile(official.client,'/* other */');
  await publishBrand(profile,logo,official);
  assert.notDeepEqual(await revision(),before);
  assert.match(await readFile(client,'utf8'),/\/\* other \*\//);
});

test('a changed brand can replace read-only assets on restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-brand-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const logo=join(dir,'source.svg'),profile=join(dir,'brand');
  await writeFile(logo,'old');
  const host=await publishBrand(profile,logo);
  await chmod(host,0o400);
  const published=join(profile,'assets/logo.svg');
  await chmod(published,0o400);
  await writeFile(logo,'new');
  await publishBrand(profile,logo);
  assert.equal(await readFile(published,'utf8'),'new');
});
