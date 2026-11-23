import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {buildMarketDocument} from '../../../../scripts/build-market-document.mjs';

test('an incomplete document never publishes a partially usable directory',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-document-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'rsi-build.json'),JSON.stringify({
    family_sha256:'a'.repeat(64),desktop_bridge:{name:'rsi.desktop.bridge',version:5},
  }));
  await assert.rejects(buildMarketDocument(root,join(root,'output'),join(root,'absent-sdk')),/document pairing failed/i);
  assert.deepEqual(await readdir(root),['rsi-build.json']);
});
