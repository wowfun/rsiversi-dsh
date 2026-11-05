import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,posix} from 'node:path';
import {test} from 'node:test';
import {writeSelection} from './market-selection.mjs';

test('the installable application contains its literal relative module imports',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-selection-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeSelection(root,'0.0.0','x86_64-unknown-linux-gnu',[],{},[]);
  const {selection}=JSON.parse(await readFile(join(root,'receipt.json'),'utf8'));
  const archive=await readFile(join(root,selection.name,'profile.rsi'));
  assert.equal(archive.subarray(0,8).toString(),'RSITREE1');
  let cursor=12+archive.readUInt32LE(8);
  const {files}=JSON.parse(archive.subarray(12,cursor));
  const names=new Set(files.map(file=>file.path));
  for(const file of files){
    const source=archive.subarray(cursor,cursor+file.bytes).toString();cursor+=file.bytes;
    if(!/\.(mjs|js)$/.test(file.path))continue;
    for(const [,specifier] of source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)['"](\.\.?\/[^'"]+)['"]/g)){
      const target=posix.normalize(posix.join(posix.dirname(file.path),specifier));
      assert.ok(names.has(target),`${file.path} requires missing packaged file ${target}`);
    }
  }
  assert.equal(cursor,archive.length);
});
