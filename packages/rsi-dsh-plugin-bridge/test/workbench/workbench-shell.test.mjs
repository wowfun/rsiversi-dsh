import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {createApplication} from '../../src/application/application.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {toolPipeline} from '../../src/tools/tool-pipeline.mjs';
import {workbenchProfile} from '../../src/workbench/profile.mjs';
import {shellPreset} from '../../../../fixtures/market/shell-preset.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('the market profile runs the release shell service and platform model tools', {skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-hook-shell-'));
  let app,world,detach;
  const sessions=applicationSessions(()=>{throw Error('Unexpected Session RPC');});
  t.after(async()=>{
    await world?.dispose();
    detach?.();
    await app?.close();
    await sessions.close();
    await rm(profile,{recursive:true,force:true});
  });
  const require=createRequire(join(root,'package.json'));
  const modules={entry:name=>require.resolve(name),directory:name=>dirname(require.resolve(name+'/package.json'))};
  const boot=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-app-boot')));
  const selected=await workbenchProfile(modules,boot,profile);
  const services=selected.rows.filter(row=>['subprocess','sandbox','sandbox-policy','pwsh-sandbox','bash-sandbox','shell-env','jobs'].includes(row.id));
  app=await createApplication({profile,modules,provide:async(ctx,load)=>{
    ctx.provide('workingDirectory',sessions.workingDirectory);
    for(const name of ['dsh-session-projection','dsh-system-prompt','dsh-tools'])
      await ctx.plugin((await load('@deepseek-ai/'+name)).default);
    await ctx.plugin((await load('@deepseek-ai/dsh-agent')).AgentRegistry);
  }});
  await app.reconcile([{insert:services}]);
  assert.ok(app.ctx.get('jobs'),'market profile must mount the release job registry');
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

  const name=process.platform==='win32'?'pwsh':'bash';
  const {Session}=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-session')));
  const header={version:4,id:'shell-test',createdAt:0,cwd:profile,isSeeded:false};
  const agent={id:header.id,ctx:app.ctx,session:Session.create(header.id,[],header),inbox:{nextStep:[]}};
  const load=name=>import(pathToFileURL(modules.entry('@deepseek-ai/'+name)));
  world=(await load('dsh-scope')).createScope(app.ctx,agent);
  agent.ctx=world.ctx;
  detach=app.ctx.agents.enter(agent);
  const tools=await load('dsh-tools');
  const execute=toolPipeline(app.ctx,await load('dsh-tools/pipeline'),tools);
  // The deterministic fixture lives in OS temp. Live release acceptance
  // exercises workspace-write in a private Session directory on each OS.
  const testServices=services.map(row=>row.id==='sandbox-policy'?{...row,config:{...row.config,mode:'danger-full-access'}}:row);
  const token=randomUUID();
  await writeFile(join(profile,'proof.txt'),token);
  for(const preset of ['standard','minimal'])await t.test(preset+' executes the original platform model tool',async()=>{
    await app.reconcile([{insert:[...testServices,...await shellPreset(root,preset)]}]);
    const selection=await app.ctx.tools.resolve({agent,modelSelection:{provider:'test',model:'test'},signal:t.signal});
    try {
      const controls=preset==='standard'?['job_list','job_output','job_kill']:[];
      assert.deepEqual(new Set(selection.view(agent).keys()),new Set([name,...controls]));
      const invoke=(name,args)=>sessions.withToolAgent(agent,()=>execute({agent,name,callId:randomUUID(),toolSet:selection,
        arguments:args,signal:t.signal}));
      const call=command=>invoke(name,{command,...preset==='standard'?{description:'Shell acceptance'}:{}});
      if(preset==='standard'){
        const command=name==='pwsh'?"[Console]::Write((Get-Content -Raw proof.txt)); [Console]::Error.Write($env:DSH_SESSION_ID); exit 7":
          'cat proof.txt; printf %s "$DSH_SESSION_ID" >&2; exit 7';
        const {value}=await call(command);
        assert.equal(value.kind,'foreground',JSON.stringify(value));
        assert.equal(value.exitCode,7);
        assert.equal(value.cwd,profile);
        assert.equal(value.stdout.text,token);
        assert.equal(value.stderr.text,agent.id);
        const background=await invoke(name,{description:'Background acceptance',run_in_background:true,
          command:name==='pwsh'?'Get-Content proof.txt; Start-Sleep -Seconds 60':'cat proof.txt; sleep 60'});
        assert.equal(background.value?.kind,'background',JSON.stringify(background));
        const id=background.value.jobId,jobs=app.ctx.jobs;
        assert.ok((await invoke('job_list',{})).value.some(job=>job.id===id&&job.status==='running'));
        assert.deepEqual(jobs.list('another-session'),[]);
        assert.throws(()=>jobs.readAt(id,0,'another-session'),/another session/);
        // The browser starts from an absolute offset. Its observation must not
        // advance the consuming model cursor or duplicate the next read.
        await t.waitFor(()=>assert.ok(jobs.readAt(id,0,agent.id).chunks.some(chunk=>chunk.text.includes(token))),{timeout:15000});
        assert.ok((await invoke('job_output',{job_id:id})).value.text.includes(token));
        assert.equal((await invoke('job_output',{job_id:id})).value.text,'');
        assert.equal((await invoke('job_kill',{job_id:id})).value.outcome,'cancellation-requested');
        const stopped=await invoke('job_output',{job_id:id,wait:true,timeout_ms:10000});
        assert.equal(stopped.value?.job.status,'killed',JSON.stringify(stopped));
      }else{
        const first=await call(name==='pwsh'?"$global:RsiProof = Get-Content -Raw proof.txt; Write-Output 'primed'":
          'export RSI_PROOF="$(cat proof.txt)"; echo primed');
        assert.equal(first.value?.split('\n')[0],'primed',JSON.stringify(first));
        const second=await call(name==='pwsh'?'Write-Output $global:RsiProof':'echo "$RSI_PROOF"');
        assert.equal(second.value?.split('\n')[0],token,JSON.stringify(second));
      }
    }finally{selection.dispose();}
  });
});
