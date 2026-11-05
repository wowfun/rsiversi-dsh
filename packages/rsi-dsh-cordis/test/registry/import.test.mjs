import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { importCohort } from '../../src/registry/import.mjs';
import { createBridge } from '../../../rsi-dsh-plugin-bridge/src/index.mjs';
import { loadCohort } from '../../src/runtime/cohort.mjs';

test('pinned npm import preserves singleton identity, suppresses scripts and activates the imported command',
  {skip: process.env.RSI_DSH_IMPORT !== '1', timeout: 600_000}, async t => {
    const work = await mkdtemp(join(tmpdir(),'dsh-import-test-'));
    t.after(() => rm(work,{recursive:true,force:true}));
    const lock = JSON.parse(await readFile(new URL('../../../rsi-dsh-plugin-bridge/src/upstream-lock.json',import.meta.url),'utf8'));
    const imported = await importCohort({cohortRoot:resolve(process.env.RSI_DSH_COHORT),lock,workspace:process.cwd(),work,
      specifications:['./fixtures/import-plugin'],signal:t.signal});
    assert.deepEqual(imported.plugins,['dsh-import-fixture']);
    const bridge = await createBridge({cohortRoot:imported.root,cohortLoader:loadCohort,configuration:{format:1,plugins:imported.plugins}});
    t.after(() => bridge.close());
    assert.ok(bridge.catalog().commands.some(command=>command.name==='imported'));
    await bridge.load({header:{version:4,id:'import-session',createdAt:0,isSeeded:false},events:[],revision:0});
    const staged = await bridge.command('import-session','import-execution','imported');
    assert.deepEqual(staged.payload.result,{kind:'success',text:'Imported DSH command executed.'});
    await bridge.receipt('import-session','import-execution',staged.token,'committed',1);
    assert.equal(bridge.canonical('import-session').events.at(-1).type,'command/done');
  });
