import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {installedPeers} from '../../src/registry/cohort.mjs';

test('host peer selection admits new and resource-only packages without treating private libraries as singletons',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-installed-peers-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const name of ['@deepseek-ai/cordis','@deepseek-ai/new-resources','react','private-library']) {
    const directory=join(root,'node_modules',name);await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'package.json'),JSON.stringify({name,version:'9.1.0',files:['data.json']}));
    await writeFile(join(directory,'data.json'),'{}');
  }
  await writeFile(join(root,'node_modules/@deepseek-ai/.rsi-namespace-pin'),'');
  const peers=await installedPeers(root);
  assert.deepEqual([...peers.keys()].sort(),['@deepseek-ai/cordis','@deepseek-ai/new-resources','react']);
  assert.equal(peers.get('@deepseek-ai/new-resources').version,'9.1.0');
});
