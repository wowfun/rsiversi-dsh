import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {loadCohort} from '../../src/runtime/cohort.mjs';

test('standalone plugin entries, subpaths and shared peers use import conditions',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-esm-cohort-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const plugin='fixture-standalone',peer='@deepseek-ai/fixture-peer';
  const pkg=join(root,'node_modules',plugin);
  async function writePeer(base) {
    const directory=join(base,'node_modules',peer);
    await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'package.json'),JSON.stringify({name:peer,exports:{import:'./peer.mjs'}}));
    await writeFile(join(directory,'peer.mjs'),'export const identity=Symbol();');
  }
  await writePeer(root);
  await mkdir(pkg);
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:plugin,
    exports:{'.':{import:'./plugin.mjs',require:'./require.cjs'},'./tools':{import:'./plugin.mjs'}},
    peerDependencies:{[peer]:'*',react:'*'},peerDependenciesMeta:{react:{optional:true}}}));
  await writeFile(join(pkg,'plugin.mjs'),`export {identity} from '${peer}';`);
  await writeFile(join(pkg,'require.cjs'),"throw Error('unexpected CommonJS plugin entry');");
  const cohort=await loadCohort(root);
  const original=await cohort.import(peer),selected=await cohort.import(plugin);
  assert.equal(selected.identity,original.identity);
  assert.equal(await cohort.subpath(plugin,'tools'),selected);
  const other=join(root,'replacement');
  await cp(join(root,'node_modules'),join(other,'node_modules'),{recursive:true});
  await writePeer(join(other,'node_modules',plugin));
  const split=await loadCohort(other);
  assert.throws(()=>split.entry(plugin),/split peer identity/);
});
