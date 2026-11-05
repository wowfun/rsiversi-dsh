import assert from 'node:assert/strict';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {publishBrand} from '../../src/application/brand.mjs';

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
