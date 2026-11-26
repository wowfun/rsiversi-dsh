import {cohortModules} from '../../../../fixtures/market/cohort-modules.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {createApplication} from '../../src/application/application.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {applicationTools} from '../../src/tools/application-tools.mjs';
import {SessionFacade} from '../../src/session/session.mjs';
import {workbenchProfile} from '../../src/workbench/profile.mjs';
import {shellPreset} from '../../../../fixtures/market/shell-preset.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('preset plugins receive the released question, web fetch and TypeScript workflow services',{skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-preset-services-'));
  let app;
  t.after(async()=>{await app?.close();await rm(profile,{recursive:true,force:true});});
  const modules=await cohortModules(root);
  const boot=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-app-boot')));
  const {rows}=await workbenchProfile(modules,boot,profile);
  const namesById=new Map(rows.map(row=>[row.id,row.name]));
  assert.equal(namesById.get('web'),'@deepseek-ai/dsh-web');
  assert.equal(namesById.get('web-runtime'),'@deepseek-ai/dsh-web-app');
  app=await createApplication({profile,modules,provide:async(ctx,load)=>{
    await ctx.plugin((await load('@deepseek-ai/dsh-session-projection')).default);
  }});
  const services=new Set(['dsh-user-questions','dsh-web','dsh-web-fetch-http','dsh-ptc-runtime-node',
    'dsh-sandbox-local','dsh-subprocess-local','dsh-sandbox-policy','dsh-fs-sandbox'].map(name=>'@deepseek-ai/'+name));
  await app.reconcile([{insert:rows.filter(row=>services.has(row.name))}]);
  const {ctx}=app;
  ctx.on('user-questions/request',async request=>({answers:[{id:request.questions[0].id,selected:['Continue']}]}));
  const question={id:'choice',question:'Continue?',options:[{label:'Continue'}]};
  assert.deepEqual(await ctx.userQuestions.ask({questions:[question]}),{answers:[{id:'choice',selected:['Continue']}]});
  assert.deepEqual(ctx.web.listProviders().fetch.map(provider=>provider.id),['http']);
  assert.equal(ctx.ptcRuntime.language,'typescript');
  assert.equal(ctx.ptcRuntime.isolation,'process');
});

test('the market filesystem enforces the release policy for the Session workspace',{skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-dsh-fs-'));
  const workspace=join(profile,'project');
  let app;
  t.after(async()=>{await app?.close();await rm(profile,{recursive:true,force:true});});
  await mkdir(workspace);
  const modules=await cohortModules(root);
  const boot=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-app-boot')));
  const {rows}=await workbenchProfile(modules,boot,profile);
  app=await createApplication({profile,modules,provide:async(ctx,load)=>{
    await ctx.plugin((await load('@deepseek-ai/dsh-session-projection')).default);
  }});
  await app.reconcile([{insert:rows.filter(row=>['fs-sandbox','sandbox-policy'].includes(row.id))}]);
  const fs=app.ctx.get('fs');
  assert.ok(fs,'market profile must mount its sandboxed filesystem');
  const {Session}=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-session')));
  const session=Session.create('plugin-fs',[],{version:4,id:'plugin-fs',cwd:workspace,createdAt:0,isSeeded:false});
  const policy=app.ctx.sandboxPolicy.resolve({session});
  assert.equal(policy.workspaceRoot,workspace);
  const file=await fs.resolve('plugin-note.txt',{cwd:workspace});
  await fs.writeText(file,'first',undefined,undefined,policy);
  assert.equal(await readFile(join(workspace,'plugin-note.txt'),'utf8'),'first');
  const readOnly=app.ctx.sandboxPolicy.resolve({session,mode:'read-only'});
  await assert.rejects(fs.writeText(file,'second',undefined,undefined,readOnly),{code:'FS_SANDBOX_DENIED'});
  assert.equal(await fs.readText(file),'first');
});

test('the market profile runs the release shell service and platform model tools', {skip:!root,timeout:120000},async t=>{
  // bwrap gives the child a private /tmp. Keep the fixture on the host filesystem.
  const profile=await mkdtemp(join(homedir(),'.rsi-dsh-shell-'));
  const workspace=join(profile,'session');
  let app,sessions;
  const agents=[];
  t.after(async()=>{
    for(const {world,detach} of agents){
      await world.dispose();
      detach();
    }
    await app?.close();
    await sessions?.close();
    await rm(profile,{recursive:true,force:true});
  });
  await mkdir(join(workspace,'nested dir'),{recursive:true});
  const modules=await cohortModules(root);
  const boot=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-app-boot')));
  const selected=await workbenchProfile(modules,boot,profile);
  const services=selected.rows.filter(row=>['subprocess','sandbox','sandbox-policy','pwsh-sandbox','bash-sandbox','shell-env','jobs'].includes(row.id));
  app=await createApplication({profile,modules,provide:async(ctx,load)=>{
    sessions=applicationSessions(()=>{throw Error('Unexpected Session RPC');},{ctx});
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
  const spec=shell.resolve({command,stdin:'hook input',workdir:policy.workspaceRoot});
  assert.deepEqual(spec.sandboxPolicy,policy);
  const result=await (await shell.execute(spec)).result();
  assert.equal(result.exitCode,0);
  assert.equal(result.stdout.text,'hook input');

  const name=process.platform==='win32'?'pwsh':'bash';
  const {Session}=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-session')));
  const load=name=>import(pathToFileURL(modules.entry('@deepseek-ai/'+name)));
  const {createScope}=await load('dsh-scope');
  function enterAgent(id,createSession=header=>Session.create(header.id,[],header)){
    const header={version:4,id,createdAt:0,cwd:workspace,isSeeded:false};
    const agent={id,session:createSession(header),inbox:{nextStep:[]}};
    const world=createScope(app.ctx,agent);
    agent.ctx=world.ctx;
    agents.push({world,detach:app.ctx.agents.enter(agent)});
    return agent;
  }
  const agent=enterAgent('shell-test');
  const key=randomUUID();
  const {port}=await applicationTools(app.ctx,{load:name=>import(pathToFileURL(modules.entry(name))),
    key,generation:randomUUID(),directory:profile,sessions,resolveAgent:id=>app.ctx.agents.get(id)});
  async function post(operation,input){
    const response=await fetch('http://127.0.0.1:'+port+'/v1/'+operation,{method:'POST',
      headers:{authorization:key,'content-type':'application/json'},body:JSON.stringify(input),signal:t.signal});
    const result=await response.json();
    assert.equal(response.status,200,JSON.stringify(result));
    return result;
  }
  const token=randomUUID();
  await writeFile(join(workspace,'proof.txt'),token);
  const select=agent=>post('capture',{header:agent.session.header,view:randomUUID(),reserved:[],
    modelSelection:{provider:'test',model:'test'}});
  function invocation(agent,selection,name,args){
    const effect=randomUUID();
    return {session:agent.id,view:selection.view,effect,name,args,
      registration:selection.tools.find(tool=>tool.definition.name===name).registration,
      identity:{owner_id:'shell-test',invocation_id:effect,call_id:randomUUID(),request_sha256:'a'.repeat(64)}};
  }
  async function invoke(agent,selection,name,args){
    const input=invocation(agent,selection,name,args);
    const {result}=await post('start',input);
    assert.deepEqual((await post('outcome',input)).result,result);
    return result;
  }
  for(const preset of ['standard','minimal'])await t.test(preset+' executes the original platform model tool',async test=>{
    await app.reconcile([{insert:[...services,...await shellPreset(root,preset)]}]);
    const selection=await select(agent);
    try {
      const controls=preset==='standard'?['job_list','job_output','job_kill']:[];
      assert.deepEqual(new Set(selection.tools.map(tool=>tool.definition.name)),new Set([name,...controls]));
      const run=(name,args)=>invoke(agent,selection,name,args);
      if(preset==='standard'){
        const allowed=await run(name,{workdir:'nested dir',description:'Write in the Session workspace',
          command:name==='pwsh'?'Set-Content -NoNewline -LiteralPath allowed.txt -Value $env:DSH_SESSION_ID':
            'printf %s "$DSH_SESSION_ID" > allowed.txt'});
        assert.equal(allowed.value?.exitCode,0,JSON.stringify(allowed));
        assert.equal(allowed.value.cwd,join(workspace,'nested dir'));
        assert.deepEqual(allowed.metadata,{dsh:{meta:{cwd:allowed.value.cwd}}});
        assert.equal(allowed.value.sandbox.mode,'workspace-write');
        assert.equal(allowed.value.sandbox.denied,false);
        assert.equal(await readFile(join(workspace,'nested dir','allowed.txt'),'utf8'),agent.id);
        const denied=await run(name,{description:'Check the Session workspace boundary',
          command:name==='pwsh'?'Set-Content -LiteralPath ../outside.txt -Value probe':'printf probe > ../outside.txt'});
        assert.equal(denied.value?.cwd,workspace,JSON.stringify(denied));
        assert.notEqual(denied.value.exitCode,0);
        assert.equal(denied.is_error,false,'the shell reports a process exit as a tool value');
        assert.deepEqual(denied.metadata,{dsh:{meta:{cwd:workspace}}});
        assert.equal(denied.value.sandbox.denied,true,JSON.stringify(denied));
        await assert.rejects(stat(join(profile,'outside.txt')),{code:'ENOENT'});
        const command=name==='pwsh'?"[Console]::Write((Get-Content -Raw proof.txt)); [Console]::Error.Write($env:DSH_SESSION_ID); exit 7":
          'cat proof.txt; printf %s "$DSH_SESSION_ID" >&2; exit 7';
        const {value}=await run(name,{command,description:'Shell acceptance'});
        assert.equal(value.kind,'foreground',JSON.stringify(value));
        assert.equal(value.exitCode,7);
        assert.equal(value.cwd,workspace);
        assert.equal(value.stdout.text,token);
        assert.equal(value.stderr.text,agent.id);
        const background=await run(name,{description:'Background acceptance',run_in_background:true,
          command:name==='pwsh'?'Get-Content proof.txt; Start-Sleep -Seconds 60':'cat proof.txt; sleep 60'});
        assert.equal(background.value?.kind,'background',JSON.stringify(background));
        const id=background.value.jobId,jobs=app.ctx.jobs;
        assert.ok((await run('job_list',{})).value.some(job=>job.id===id&&job.status==='running'));
        assert.deepEqual(jobs.list('another-session'),[]);
        assert.throws(()=>jobs.readAt(id,0,'another-session'),/another session/);
        // The browser starts from an absolute offset. Its observation must not
        // advance the consuming model cursor or duplicate the next read.
        await t.waitFor(()=>assert.ok(jobs.readAt(id,0,agent.id).chunks.some(chunk=>chunk.text.includes(token))),{timeout:15000});
        assert.ok((await run('job_output',{job_id:id})).value.text.includes(token));
        assert.equal((await run('job_output',{job_id:id})).value.text,'');
        assert.equal((await run('job_kill',{job_id:id})).value.outcome,'cancellation-requested');
        const stopped=await run('job_output',{job_id:id,wait:true,timeout_ms:10000});
        assert.equal(stopped.value?.job.status,'killed',JSON.stringify(stopped));
      }else{
        const first=await run(name,{command:name==='pwsh'?"$global:RsiProof = Get-Content -Raw proof.txt; Write-Output 'primed'":
          'export RSI_PROOF="$(cat proof.txt)"; echo primed'});
        assert.equal(first.value?.split('\n')[0],'primed',JSON.stringify(first));
        assert.equal(Object.hasOwn(first,'metadata'),false);
      }
    }finally{await post('release',{view:selection.view});}
    if(preset==='minimal'){
      const command=name==='pwsh'?"if ($global:RsiProof) { $global:RsiProof } else { 'fresh' }":
        'echo "${RSI_PROOF:-fresh}"';
      for(const [owner,expected] of [[enterAgent('second-shell-test'),'fresh'],[agent,token]]){
        const next=await select(owner);
        try{
          const reply=await invoke(owner,next,name,{command});
          assert.equal(reply.value?.split('\n')[0],expected,JSON.stringify(reply));
        }finally{await post('release',{view:next.view});}
      }
    }
    await test.test('cancels an executing command and can execute again',{timeout:30000},async()=>{
      const selected=await select(agent),ready=preset+'-cancel-ready.txt';
      const command=name==='pwsh'?
        `$global:RsiCancelled = 'pending'; Set-Content -NoNewline -LiteralPath ${ready} -Value ready; Start-Sleep -Seconds 60`:
        `export RSI_CANCELLED=pending; printf ready > ${ready}; sleep 60`;
      const input=invocation(agent,selected,name,{command,...preset==='standard'?{description:'Cancel the running shell'}:{}});
      const pending=post('start',input);
      try {
        // The child, rather than a timer, proves that cancellation reaches an
        // executing native command after shell initialization has completed.
        await t.waitFor(async()=>assert.equal(await readFile(join(workspace,ready),'utf8'),'ready'),{timeout:15000});
        assert.deepEqual(await post('cancel',input),{accepted:true});
        const outcome=await pending;
        assert.equal(outcome.state,'settled',JSON.stringify(outcome));
        assert.equal(outcome.result.is_error,true,JSON.stringify(outcome));
        assert.equal(outcome.result.metadata.dsh.error.code,'ABORTED');
        assert.deepEqual(await post('outcome',input),outcome);
        const command=name==='pwsh'?"if ($global:RsiCancelled) { $global:RsiCancelled } else { 'fresh' }":
          'echo "${RSI_CANCELLED:-fresh}"';
        const reply=await invoke(agent,selected,name,{command,...preset==='standard'?{description:'Use shell after cancellation'}:{}});
        assert.equal(reply.is_error,false,JSON.stringify(reply));
        assert.equal((preset==='standard'?reply.value.stdout.text:reply.value).split(/\r?\n/)[0],'fresh');
      } finally {
        await post('cancel',input);
        await pending;
        await post('release',{view:selected.view});
      }
    });
  });

  await t.test('Claude Code Mods can gate the standard shell on the calling Session history',async()=>{
    const mods=await load('dsh-experimental-claude-code-mods');
    const sessionApi={...await load('dsh-session'),...await load('dsh-session/surface'),...await load('dsh-util-values')};
    const {createUserMessage}=await load('dsh-llm');
    const modTool=name==='bash'?'Bash':'pwsh';
    const observations=[];
    await app.reconcile([{insert:[...services,...await shellPreset(root,'standard'),
      {id:'mods',name:'@deepseek-ai/dsh-experimental-claude-code-mods'}]}]);
    const mod=await app.ctx.plugin(mods.defineMod({name:'shell-history',register(on){
      on('tool.call',{tool:modTool},async(api,event,next)=>{
        const messages=await api.session.messages();
        const allowed=messages.some(message=>message.role==='user'&&message.text==='allow writing');
        observations.push({id:await api.session.id(),tool:event.tool,allowed});
        return allowed?next(event):{deny:'Session declined writing'};
      });
    }}));
    await mod.await();
    const output=join(workspace,'gated.txt');
    const command=name==='pwsh'?"[IO.File]::AppendAllText((Join-Path (Get-Location) 'gated.txt'), 'x')":
      "printf x >> gated.txt";
    for(const allowed of [false,true]){
      const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:allowed?'allow writing':'deny writing'}]});
      const agent=enterAgent('gate-'+allowed,header=>new SessionFacade(app.ctx,sessionApi,{header,
        events:[{seq:0,time:1,type:'user/message',data:message,surfaceOp:'append'}]},false));
      const selected=await select(agent);
      try{
        const result=await invoke(agent,selected,name,{command,description:'Append once to gated.txt'});
        assert.equal(result.is_error,!allowed,JSON.stringify(result));
        if(allowed){
          assert.equal(result.value.exitCode,0);
          assert.equal(await readFile(output,'utf8'),'x');
        }else{
          assert.equal(result.metadata.dsh.error.code,'MOD_DENIED');
          await assert.rejects(stat(output),{code:'ENOENT'});
        }
      }finally{await post('release',{view:selected.view});}
    }
    assert.deepEqual(observations,[false,true].map(allowed=>({id:'gate-'+allowed,tool:modTool,allowed})));
  });
});
