import assert from 'node:assert/strict';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createExtension} from '../../src/importer.mjs';
import {writePayload} from '../../../rsi-dsh-cordis/src/archive/payload.mjs';

for(const fails of [false,true])test(`standalone importer drains temporary files after ${fails?'failure':'publication'}`,async t=>{
  const staging=await mkdtemp(join(tmpdir(),'rsi-import-stage-'));
  t.after(()=>rm(staging,{recursive:true,force:true}));
  let temporary;
  const importer=createExtension({cohortRoot:staging,hostModules:{writePayload,
    async importCohort({work}) {
      temporary=work;
      if(fails)throw Error('npm failed');
      const root=join(work,'cohort');await mkdir(root);
      await writeFile(join(root,'kept.txt'),'package-private data');
      return {root,plugins:['fixture'],runtimeVersion:'0.2.2-rc.1',npmVersion:'11.17.0',lockSha256:'c'.repeat(64)};
    }}});
  t.after(()=>importer.close());
  const request={format:1,staging,workspace:staging,specifications:['fixture'],
    importer:{package:'rsi-dsh-plugin-bridge',digest:'a'.repeat(64),dependencies:[{name:'rsi-dsh-cordis',digest:'b'.repeat(64)}]}};
  const result=importer.handle('package.import',request,t.signal);
  if(fails)await assert.rejects(result,/npm failed/);
  else {
    const published=join(staging,(await result).directories[0]);
    const receipt=JSON.parse(await readFile(join(published,'import.json'),'utf8'));
    assert.deepEqual(receipt,{format:1,runtimeVersion:'0.2.2-rc.1',plugins:['fixture'],npm:'11.17.0',lockSha256:'c'.repeat(64)});
    assert.ok((await readFile(join(published,'payload.rsi'))).includes(Buffer.from('package-private data')));
  }
  await assert.rejects(access(temporary),{code:'ENOENT'});
});
