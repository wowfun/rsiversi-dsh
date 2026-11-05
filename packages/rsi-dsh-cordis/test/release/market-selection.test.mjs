import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {writeNpmToolchain,writeSelection} from '../../../../scripts/market-selection.mjs';

test('only the importer leases npm at launch and declares both native interfaces',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-selection-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const npm=join(root,'published-npm');
  await mkdir(npm);
  await writeFile(join(npm,'package.json'),'{"name":"npm","version":"1.0.0"}');
  const toolchain=await writeNpmToolchain(root,npm,'linux-x86_64');
  const runtime={name:'rsi-dsh-runtime-0',manifestDigest:'a'.repeat(64)};
  await writeSelection(root,'0.2.1','linux-x86_64',[],{},[runtime],toolchain);
  const read=async(...parts)=>JSON.parse(await readFile(join(root,...parts),'utf8'));
  const receipt=await read('receipt.json');
  const app=await read(receipt.selection.name,'package.json');
  assert.deepEqual(app.dependencies,[{name:runtime.name,digest:runtime.manifestDigest}]);
  const importer=await read(receipt.importer.name,'package.json');
  assert.deepEqual(importer.dependencies,[receipt.selection,...app.dependencies,toolchain]);
  assert.deepEqual(importer.requires,[{name:'rsi.extension.process',version:1},{name:'rsi.packages.importer',version:1}]);
  const launch=await read(receipt.importer.name,'import.json');
  assert.equal(launch.arguments.at(-1).location.package,toolchain.name);
  assert.equal(launch.arguments.at(-1).location.path,'node_modules/npm');

  // Import from the installed payload rather than the working source graph.
  const payload=await readFile(join(root,receipt.selection.name,'profile.rsi'));
  assert.equal(payload.subarray(0,8).toString(),'RSITREE1');
  const length=payload.readUInt32LE(8);
  const tree=JSON.parse(payload.subarray(12,12+length));
  let offset=12+length;
  const extracted=join(root,'installed');
  for(const file of tree.files){
    const target=join(extracted,file.path);await mkdir(dirname(target),{recursive:true});
    await writeFile(target,payload.subarray(offset,offset+file.bytes));offset+=file.bytes;
  }
  assert.equal(offset,payload.length);
  const load=name=>import(pathToFileURL(join(extracted,'rsi-dsh-plugin-bridge/src',name)));
  assert.equal(typeof (await load('tools/application-tools.mjs')).applicationTools,'function');
  assert.equal(typeof (await load('history/history.mjs')).observeFact,'function');
});
