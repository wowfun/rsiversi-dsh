import assert from 'node:assert/strict';
import {mock,test} from 'node:test';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {sessionJournalStore} from '../../src/session/session-journal-store.mjs';

test('cold metadata and history share file discovery and see only successful publications',async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'rsi-journal-discovery-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const open=mock.method(fs,'open'),hash=mock.method(crypto,'hash');
  syncBuiltinESMExports();
  t.after(()=>{open.mock.restore();hash.mock.restore();syncBuiltinESMExports();});
  let allowWrite=false;
  const create=()=>sessionJournalStore(directory,{async writeFileAtomic(path,bytes){
    if(!allowWrite)throw Error('write refused');
    await fs.mkdir(dirname(path),{recursive:true});
    await fs.writeFile(path,bytes);
  }});
  const storage=create(),id='saved',document='{"header":{"id":"saved"},"ownedEventCount":0,\n"version":8}';
  await assert.rejects(storage.save(id,document),/write refused/);
  assert.equal(await storage.metadata(id),undefined);
  assert.equal(await storage.read(id),undefined);
  assert.equal(open.mock.callCount(),0);
  allowWrite=true;
  await storage.save(id,document);
  const cold=create();
  const [meta,body,absent,missing]=await Promise.all([
    cold.metadata(id),cold.read(id),cold.metadata('native-only'),cold.read('other'),
  ]);
  assert.equal(meta.header.id,id);
  assert.equal(body,document);
  assert.equal(absent,undefined);
  assert.equal(missing,undefined);
  assert.equal(open.mock.callCount(),2);
  assert.equal((await cold.metadata(id)).header.id,id);
  assert.equal(open.mock.callCount(),2);
  hash.mock.resetCalls();
  const rows=Array.from({length:64},(_,i)=>({id:'native-'+i,createdAt:1}));
  await cold.decorate(rows);
  assert.equal(hash.mock.callCount(),0,'a known directory uses Session IDs on later listings');
  await cold.save(id,document);
  assert.equal(await cold.read(id),document);
  assert.equal(hash.mock.callCount(),0,'known journals reuse their filename for writes and reads');
});
