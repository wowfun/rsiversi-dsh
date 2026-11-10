import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { importCohort } from '../../src/registry/import.mjs';
import { createBridge } from '../../../rsi-dsh-plugin-bridge/src/index.mjs';
import { loadCohort } from '../../src/runtime/cohort.mjs';

test('pinned npm import preserves singleton identity, suppresses scripts and activates the imported command',
  {skip: process.env.RSI_DSH_IMPORT !== '1', timeout: 600_000}, async t => {
    const work = await mkdtemp(join(tmpdir(),'dsh-import-test-'));
    t.after(() => rm(work,{recursive:true,force:true}));
    const specification=join(work,'linked-fixture');
    await symlink(resolve('fixtures/import-plugin'),specification,process.platform==='win32'?'junction':'dir');
    const imported = await importCohort({cohortRoot:resolve(process.env.RSI_DSH_COHORT),workspace:process.cwd(),work,
      specifications:[specification],signal:t.signal});
    assert.deepEqual(imported.plugins,['dsh-import-fixture']);
    const boot=JSON.parse(await readFile(join(imported.root,'node_modules/@deepseek-ai/dsh-app-boot/package.json'),'utf8'));
    assert.equal(imported.runtimeVersion,boot.version);
    assert.equal(imported.npmVersion,'11.17.0');
    const bridge = await createBridge({cohortRoot:imported.root,cohortLoader:loadCohort,configuration:{format:1,plugins:imported.plugins}});
    t.after(() => bridge.close());
    assert.ok(bridge.catalog().commands.some(command=>command.name==='imported'));
    await bridge.load({header:{version:4,id:'import-session',createdAt:0,isSeeded:false},events:[],revision:0});
    const staged = await bridge.command('import-session','import-execution','imported');
    assert.deepEqual(staged.payload.result,{kind:'success',text:'Imported DSH command executed.'});
    await bridge.receipt('import-session','import-execution',staged.token,'committed',1);
    assert.equal(bridge.canonical('import-session').events.at(-1).type,'command/done');
  });
