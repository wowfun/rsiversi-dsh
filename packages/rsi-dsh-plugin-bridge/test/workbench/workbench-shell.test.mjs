import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {createApplication} from '../../src/application/application.mjs';
import {workbenchProfile} from '../../src/workbench/profile.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('the market profile provides the release platform shell to command plugins', {skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-hook-shell-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const require=createRequire(join(root,'package.json'));
  const modules={entry:name=>require.resolve(name),directory:name=>dirname(require.resolve(name+'/package.json'))};
  const boot=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-app-boot')));
  const selected=await workbenchProfile(modules,boot,profile);
  const services=selected.rows.filter(row=>['subprocess','sandbox','sandbox-policy','pwsh-sandbox','bash-sandbox'].includes(row.id));
  const app=await createApplication({profile,modules,provide:async(ctx,load)=>{
    await ctx.plugin((await load('@deepseek-ai/dsh-session-projection')).default);
  }});
  t.after(()=>app.close());
  await app.reconcile([{insert:services}]);
  const policy=app.ctx.sandboxPolicy.resolve();
  assert.equal(policy.workspaceRoot,join(profile,'shell-workspace'));
  assert.ok((await stat(policy.workspaceRoot)).isDirectory());
  const shell=app.ctx.shell;
  const platformShell=process.platform==='win32'?'dsh-pwsh-sandbox':'dsh-bash-sandbox';
  const {default:Executor}=await import(pathToFileURL(modules.entry('@deepseek-ai/'+platformShell)));
  assert.ok(shell instanceof Executor);
  const command=process.platform==='win32'?'[Console]::Write([Console]::In.ReadToEnd())':'cat';
  const spec=shell.resolve({command,stdin:'hook input',workdir:profile});
  assert.deepEqual(spec.sandboxPolicy,policy);
  const unconfined=app.ctx.sandboxPolicy.resolve({mode:'danger-full-access'});
  const result=await (await shell.execute({...spec,sandboxPolicy:unconfined})).result();
  assert.equal(result.exitCode,0);
  assert.equal(result.stdout.text,'hook input');
});
