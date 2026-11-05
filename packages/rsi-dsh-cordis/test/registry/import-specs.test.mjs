import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { npmImportFlags } from '../../src/registry/import.mjs';
import { runtimeEnvironment } from '../../src/runtime/node.mjs';

test('npm admits an explicit built directory but refuses its transitive local directory', {skip:process.env.RSI_DSH_IMPORT !== '1'}, async t => {
  const root = await mkdtemp(join(tmpdir(),'rsi-dsh-spec-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const directories = Object.fromEntries(['workspace','plugin','outside'].map(name=>[name,join(root,name)]));
  for (const [name,dir] of Object.entries(directories)) {
    await mkdir(dir);
    const dependencies = name === 'plugin' ? {outside:`file:${directories.outside.replaceAll('\\','/')}`} : {};
    await writeFile(join(dir,'package.json'),JSON.stringify({name,version:'1.0.0',dependencies}));
  }
  const require = createRequire(join(process.env.RSI_DSH_COHORT,'package.json'));
  const npm = join(dirname(require.resolve('npm/package.json')),'bin/npm-cli.js');
  const result = spawnSync(process.execPath,[npm,'install',...npmImportFlags,'--offline','--',directories.plugin],
    {cwd:directories.workspace,env:{...runtimeEnvironment(),HOME:root,USERPROFILE:root,npm_config_cache:join(root,'cache')},encoding:'utf8',timeout:30_000});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/EALLOWDIRECTORY/);
});
