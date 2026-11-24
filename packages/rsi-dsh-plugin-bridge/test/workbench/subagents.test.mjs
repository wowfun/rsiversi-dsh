import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {createApplication} from '../../src/application/application.mjs';
import {SessionProjectionJournal} from '../../src/session/session-projection-journal.mjs';
import {workbenchSubagents} from '../../src/workbench/subagents.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('mixed descendants retain original descriptors and place native children below their creator',async()=>{
  const child={kind:'child',id:'child',parentId:'root',hasChildren:false,label:'original',path:'worker'};
  const external={kind:'child',id:'external',parentId:'root',mode:'external',hasChildren:false};
  const program={kind:'diagnostic',id:'program',parentId:'child',depth:2,reason:'unsupported'};
  class Runtime { listDescendants(){return [child,external];} }
  const scope=rows=>({withCaller:run=>run(),subagents:{listDescendants:async()=>rows}});
  const adapter=workbenchSubagents(Runtime,Symbol(),scope([{...child,label:'native'},program]));
  assert.deepEqual(await new adapter.Runtime().listDescendants('root'),[{...child,hasChildren:true},program,external]);
  const hidden=workbenchSubagents(class {listDescendants(){return [];}},Symbol(),scope([program]));
  assert.deepEqual(await new hidden.Runtime().listDescendants('root'),[]);
});
test('the released manager carries the initiating Loader package to the unseeded native factory',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json')),runtime='@deepseek-ai/dsh-subagent',guest='example-delegator';
  const profile=await mkdtemp(join(tmpdir(),'rsi-plugin-child-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const modules={entry:name=>name===guest?fileURLToPath(import.meta.url):require.resolve(name)};
  const hostModules=new Map(),seen=[];
  let start,parent;
  const app=await createApplication({modules,profile,hostModules,async provide(ctx,load){
    await ctx.plugin((await load('@deepseek-ai/dsh-session-projection')).default);
    await ctx.plugin((await load('@deepseek-ai/dsh-agent')).AgentRegistry);
    ctx.provide('workingDirectory',{get:()=>profile,ensure:async()=>profile});
    const service=workbenchSubagents((await load(runtime)).default,(await load('@deepseek-ai/cordis')).symbols.caller,
      {withPluginParent:(_parent,run)=>run()});
    hostModules.set(runtime,service.Runtime);
    hostModules.set(guest,{inject:['subagents'],apply(caller){
      start=spec=>caller.subagents.startActivation(spec);
    }});
    const api={...await load('@deepseek-ai/dsh-session'),...await load('@deepseek-ai/dsh-session/surface'),...await load('@deepseek-ai/dsh-util-values')};
    const session=new SessionProjectionJournal(ctx,api,{header:{version:4,id:'root',createdAt:1,cwd:profile,isSeeded:false}}).session;
    parent={id:'root',ctx,session,options:{},status:'idle'};
    ctx.agents.enter(parent);
    ctx.agents.setFactory({async createAgent(owner,options){
      assert.equal(options.seed,undefined);
      seen.push(service.creation(owner,options));
      assert.equal(service.creation(owner,options),undefined);
      throw Error('native creation observed');
    }});
  }});
  t.after(()=>app.close());
  await app.reconcile([[{insert:[{id:'runtime',name:runtime},
    {id:'spawn',name:'@deepseek-ai/dsh-subagent-spawn-in-process'},{id:'guest',name:guest}]}]]);
  const spec={parent,cwd:profile,provider:'spawn',prompt:'inspect',label:'inspect',name:'worker',delivery:'caller',
    signal:new AbortController().signal};
  await assert.rejects(start({...spec,parent:{...parent}}),/exact live parent/);
  await assert.rejects(start(spec),/native creation observed/);
  const sibling=resolve(profile,'../another-workspace');
  await assert.rejects(start({...spec,cwd:sibling}),/native creation observed/);
  await assert.rejects(start({...spec,cwd:'../another-workspace'}),/native creation observed/);
  const origin={parent:'root',plugin:guest,task_name:'worker'};
  assert.deepEqual(seen,[origin,{...origin,cwd:sibling},{...origin,cwd:sibling}]);
  assert.equal(parent.session.seq,0);
});
