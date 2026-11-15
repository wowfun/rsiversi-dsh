import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chmod,mkdtemp,readFile,rm,stat,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureRecovery,restoreProfileFiles,readSelections,saveSelections,readProfileManifest} from '../../src/market/profile-files.mjs';

test('profile manifest reads enforce their write capacity and preserve missing-file defaults',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-manifest-capacity-')),path=join(profile,'package.json');
  t.after(()=>rm(profile,{recursive:true,force:true}));
  assert.deepEqual(await readProfileManifest(path,{private:true}),{private:true});
  const text='{"name":"fixture","padding":"'+ 'a'.repeat(1024*1024)+'"}';
  await writeFile(path,text);
  await assert.rejects(readProfileManifest(path),/package.json exceeds profile capacity/);
  assert.equal(await readFile(path,'utf8'),text);
});

test('large lockfiles survive recovery capture, journal reopen and byte-exact restore',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-profile-large-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const lock=Buffer.alloc(2*1024*1024,97),path=join(profile,'pnpm-lock.yaml');
  await writeFile(path,lock);
  const journal=join(profile,'selections.json'),rollback=await captureRecovery(journal,profile);
  await saveSelections(journal,{},rollback);
  const recovered=await readSelections(journal);
  assert.ok(Buffer.isBuffer(recovered.rollback.files['pnpm-lock.yaml']),'recovery retains its validated bytes');
  await writeFile(path,'candidate');await restoreProfileFiles(profile,recovered.rollback.files);
  assert.deepEqual(await readFile(path),lock);
});

test('profile recovery restores bytes and applies private permissions on POSIX',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-profile-permissions-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const path=join(profile,'cordis.yml'),journal=join(profile,'selections.json');
  await writeFile(path,'[]\n');await chmod(path,0o644);
  await writeFile(journal,'{}\n');await chmod(journal,0o644);
  await saveSelections(journal,{},await captureRecovery(journal,profile));
  if(process.platform!=='win32')assert.equal((await stat(journal)).mode&0o777,0o600&~process.umask());
  await writeFile(path,'candidate');
  await restoreProfileFiles(profile,(await readSelections(journal)).rollback.files);
  assert.equal(await readFile(path,'utf8'),'[]\n');
  if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600&~process.umask());
});

test('maximum recovery files stay in one immutable snapshot while metadata remains small',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-profile-bounds-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  for(const [name,size] of [['package.json',1],['cordis.yml',1],['cordis.patch.yml',1],['pnpm-lock.yaml',16]])
    await writeFile(join(profile,name),Buffer.alloc(size*1024*1024,97));
  const journal=join(profile,'selections.json'),rollback=await captureRecovery(journal,profile);
  await saveSelections(journal,{},rollback);
  assert.deepEqual((await readSelections(journal)).rollback.files,
    Object.fromEntries(Object.entries(rollback.files).map(([name,value])=>[name,value===null?null:Buffer.from(value,'base64')])));
  const snapshot=journal+'.recovery',initial=await stat(snapshot,{bigint:true});
  for(const name of ['first','second','third']) {
    rollback.touched.push(name);await saveSelections(journal,{},rollback);
    assert.ok((await stat(journal)).size<1024);
  }
  const final=await stat(snapshot,{bigint:true});
  assert.equal(final.ino,initial.ino);assert.equal(final.mtimeNs,initial.mtimeNs);
  const before=await readFile(journal);
  const oversized=Object.fromEntries(Array.from({length:128},(_,i)=>['fixture-'+i,
    {package:'rsi-dsh-selection-'+ 'a'.repeat(9000),digest:'a'.repeat(64),version:'1.0.0'}]));
  await assert.rejects(saveSelections(journal,oversized),/selections.json exceeds profile capacity/);
  assert.deepEqual(await readFile(journal),before);
  await writeFile(join(profile,'pnpm-lock.yaml'),Buffer.alloc(16*1024*1024+1));
  await assert.rejects(captureRecovery(journal,profile),/pnpm-lock.yaml exceeds profile capacity \(16777216 bytes\)/);
  assert.equal((await stat(snapshot,{bigint:true})).ino,initial.ino);
});

test('unsupported journal formats preserve their bytes and explain the refusal',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-profile-format-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const path=join(profile,'selections.json');
  for(const bytes of ['{"installed":{},"preparing":{}}\n','{"format":2,"installed":{},"rollback":null}\n']) {
    await writeFile(path,bytes);
    await assert.rejects(readSelections(path),/Unsupported host selection journal format.*expected 3/);
    assert.equal(await readFile(path,'utf8'),bytes);
  }
});

test('journal writes cannot exceed the selection cardinality accepted on reopen',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-profile-cardinality-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const path=join(profile,'selections.json');await saveSelections(path,{});
  const before=await readFile(path),installed=Object.fromEntries(Array.from({length:129},(_,i)=>
    ['fixture-'+i,{package:'rsi-dsh-selection-fixture',digest:'a'.repeat(64),version:'1.0.0'}]));
  await assert.rejects(saveSelections(path,installed),/selection capacity/);
  const rollback=await captureRecovery(path,profile);
  await assert.rejects(saveSelections(path,{}, {...rollback,touched:Object.keys(installed)}),/selection capacity/);
  assert.deepEqual(await readFile(path),before);
  assert.deepEqual((await readSelections(path)).installed,{});
});

test('snapshot publication and commit leave orphans harmless but pending intent requires exact bytes',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-profile-snapshot-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const journal=join(profile,'selections.json'),snapshot=journal+'.recovery';
  await saveSelections(journal,{});
  await writeFile(join(profile,'package.json'),'{}\n');
  const rollback=await captureRecovery(journal,profile);
  assert.equal((await readSelections(journal)).rollback,null,'snapshot alone is not recovery intent');
  await saveSelections(journal,{},rollback);
  const good=await readFile(snapshot);
  await unlink(snapshot);
  await assert.rejects(readSelections(journal),/Missing Profile recovery snapshot/);
  await writeFile(snapshot,JSON.stringify({id:'stale',files:rollback.files}));
  await assert.rejects(readSelections(journal),/does not match/);
  await writeFile(snapshot,JSON.stringify({id:rollback.id,files:{'../outside':null}}));
  await assert.rejects(readSelections(journal),/Invalid Profile recovery files/);
  await writeFile(snapshot,JSON.stringify({id:rollback.id,files:{'package.json':'not-base64!'}}));
  await assert.rejects(readSelections(journal),/Invalid Profile recovery bytes/);
  await writeFile(snapshot,good);
  assert.deepEqual((await readSelections(journal)).rollback.files,
    Object.fromEntries(Object.entries(rollback.files).map(([name,value])=>[name,value===null?null:Buffer.from(value,'base64')])));
  await saveSelections(journal,{});
  await assert.rejects(stat(snapshot),{code:'ENOENT'});
  await writeFile(snapshot,'incomplete orphan');
  assert.equal((await readSelections(journal)).rollback,null,'committed metadata never reads orphan bytes');
});

test('malformed write-side metadata is refused before replacing a valid journal',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-profile-write-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const path=join(profile,'selections.json');await saveSelections(path,{});
  const before=await readFile(path);
  await assert.rejects(saveSelections(path,{},{}),/Invalid host selection journal/);
  await assert.rejects(saveSelections(path,{fixture:{package:'invalid',digest:'bad',version:'1'}}),/Invalid host selection/);
  assert.deepEqual(await readFile(path),before);
});

test('raw package recovery only captures its manifest and leaves other profile files alone',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-profile-raw-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const path=join(profile,'package.json'),lock=join(profile,'pnpm-lock.yaml'),patch=join(profile,'cordis.patch.yml');
  const journal=join(profile,'selections.json');
  await writeFile(path,'{}\n');await writeFile(lock,Buffer.alloc(16*1024*1024+1));
  const rollback=await captureRecovery(journal,profile,false);
  assert.deepEqual(Object.keys(rollback.files),['package.json']);
  await saveSelections(journal,{},rollback);
  await writeFile(path,'candidate');await writeFile(lock,'independent lock');await writeFile(patch,'independent patch');
  await restoreProfileFiles(profile,(await readSelections(journal)).rollback.files);
  assert.equal(await readFile(path,'utf8'),'{}\n');
  assert.equal(await readFile(lock,'utf8'),'independent lock');
  assert.equal(await readFile(patch,'utf8'),'independent patch');
});
