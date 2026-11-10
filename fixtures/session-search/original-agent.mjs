import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createApplication} from '../../packages/rsi-dsh-plugin-bridge/src/application/application.mjs';
import {searchDistribution} from './distribution.mjs';

/** Original production Agent/JSONL/checkpoint chain with a deterministic model. */
export async function originalSearchAgent({cohort,profile,corpus=[],sessionId='search-caller',cwd,
  resume=false,onRequest}) {
  await mkdir(profile,{recursive:true});
  const {modules,load,patches,version}=await searchDistribution(cohort);
  const llm=await load('@deepseek-ai/dsh-llm');
  let app,handle,active;
  class ScriptedModel extends llm.LlmAdapter {
    async *stream(options) {
      assert.ok(active,'Unexpected model request outside the scripted turn');
      const request=active.requests++;
      if(request===1)active.toolCycleMs=performance.now()-active.started;
      assert.ok(request<2,'Search turn must request one tool batch and one final answer');
      await onRequest?.({request,callId:active.callId,options});
      if(request===0) {
        assert.ok(options.tools.some(tool=>tool.name===active.name),'Requested tool is absent from the real model catalog');
        active.started=performance.now();
        yield {type:'block-start',index:0,blockType:'tool-call'};
        yield {type:'block-end',index:0,block:{type:'tool-call',id:active.callId,
          name:active.name,arguments:JSON.stringify(active.args)}};
        yield {type:'finish',reason:{kind:'tool-calls'}};
      } else {
        yield {type:'block-start',index:0,blockType:'text'};
        yield {type:'block-end',index:0,block:{type:'text',text:'Search complete.'}};
        yield {type:'finish',reason:{kind:'stop'}};
      }
    }
  }
  try {
    app=await createApplication({profile,modules,provide:async ctx=>{
      for(const name of ['dsh-llm','dsh-session','dsh-session-projection','dsh-system-prompt','dsh-tools','dsh-agent'])
        await ctx.plugin((await load('@deepseek-ai/'+name)).default);
      await ctx.plugin(await load('@deepseek-ai/dsh-tool-executor-native'));
      await ctx.plugin(await load('@deepseek-ai/dsh-session-persistence-jsonl'),
        {root:join(profile,'sessions'),compression:'none'});
      await ctx.plugin((await load('@deepseek-ai/dsh-agent-loop')).default,{agents:[]});
      await ctx.plugin(await load('@deepseek-ai/dsh-session-checkpoint-policy'));
      ctx.llm.registerAdapter(['search-fixture'],new ScriptedModel());
    }});
    for(const row of corpus) {
      const writer=await app.ctx.sessionPersistence.create(row.header,{inheritedEventCount:row.inheritedEventCount??0});
      try {await writer.append(row.events);}finally{await writer.close();}
    }
    assert.deepEqual(await app.reconcile(patches),[]);
    const agentOptions={provider:'search-fixture',model:'search-fixture'};
    handle=resume
      ?await app.ctx.agents.resume({resumeSessionId:sessionId,agentOptions})
      :await app.ctx.agents.create({sessionId,agentOptions,meta:{cwd:cwd??corpus[0]?.header.cwd}});
    const {agent}=handle;
    // Imported histories can retain a real provider route; this fixture never calls it.
    agent.model.select(agentOptions);
    return {version,app,agent,policyScope:{checkpointPolicy:true,agentLoop:true},
      async execute(name,args) {
        assert.equal(active,undefined,'Overlapping benchmark turns are not supported');
        const turn={name,args,callId:randomUUID(),requests:0};active=turn;
        const offset=agent.session.seq;
        try {
          agent.followup(llm.createUserMessage({content:[{type:'text',text:'Run the selected search tool.'}],source:{kind:'user'}}));
          await agent.whenIdle();
          const events=agent.session.snapshotEvents().slice(offset);
          const terminal=events.findLast(event=>event.type==='turn/end');
          assert.equal(terminal?.data.reason.kind,'completed',JSON.stringify(terminal));
          assert.equal(turn.requests,2);
          const result=events.find(event=>event.type==='tool/result'&&event.data.message.source.callId===turn.callId);
          assert.ok(result,'The original Agent must publish its own tool result');
          return {callId:turn.callId,toolCycleMs:turn.toolCycleMs,
            result:{isError:result.data.message.isError,content:result.data.message.content}};
        } finally {active=undefined;}
      },
      async close(){try{await handle.dispose();}finally{await app.close();}},
    };
  }catch(error){try{await handle?.dispose();}finally{await app?.close();}throw error;}
}
