import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {workbenchHistory} from '../../src/workbench/history.mjs';
import {workbenchAgents} from '../../src/workbench/agents.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
const inline=value=>{const text=JSON.stringify(value);return {kind:'inline',text,sha256:createHash('sha256').update(text).digest('hex')};};
const until=async predicate=>{const end=Date.now()+8000;while(!predicate()){assert.ok(Date.now()<end,'expected observation');await setImmediate();}};

test('original Side Chat receives dense Agent frames across attach, reconnect, durable settlement and disposal',
  {skip:!root,timeout:15000},async t=>{
    const require=createRequire(join(root,'package.json')),load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
    const ctx=new (await load('cordis')).Context();
    await ctx.plugin((await load('dsh-session-projection')).default);await ctx.plugin((await load('dsh-agent')).AgentRegistry);
    const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
    const llm=await load('dsh-llm');
    const directory=await mkdtemp(join(tmpdir(),'rsi-stream-plugin-'));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const outfile=join(directory,'live.mjs');
    const {build}=await import('esbuild');
    await build({entryPoints:[join(root,'node_modules/dsh-better-sidebar/src/assistant-live.ts')],
      outfile,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
    const buffer=(await import(pathToFileURL(outfile))).createAssistantLiveBuffer(ctx);t.after(()=>buffer.dispose());
    const facts=[],readers=new Map(),durableWaiters=new Set(),frames=[],sequence=[];
    let active='turn',current='effect',agents,releaseCount=0,cancelCount=0,captures=0,capturesAtCommit;
    const frameCaptures=[];
    const writeErrors=[];let notificationWrites=0;
    let modelEvents=[[0,{type:'content_started',index:0,content:{type:'text'}}],
      [5,{type:'content_delta',index:0,delta:{type:'text',value:'prefix'}}]];
    const add=fact=>facts.push({...fact,seq:facts.length+1,timestamp_ms:fact.type==='model_started'?1000:1100+facts.length});
    const evidence={availability:'available',
      configuration:inline({prepared:{deployment:'native',model:'configured',language_settings:{}},settings:{stop:[]},extensions:[]}),
      tools:inline({definitions:[],hosted:[],choice:'none'}),system:inline([])};
    const begin=()=>{
      add({type:'message_turn_accepted',turn_id:active});add({type:'step_started',turn_id:active,step_id:'step-'+active});
      add({type:'model_intent',effect_id:current,purpose:{kind:'conversation'},
        snapshot:{deployment_id:'native',model:'configured',language_settings:{}},evidence});
      add({type:'model_started',effect_id:current});
    };begin();
    const cursor=()=>({fact_seq:facts.length,control_seq:1});
    const selection={model:{deployment:'native',model:'configured'}};
    const metadata=()=>({id:'thread',created_at:1,inherited:false,through:facts.length,
      model_baseline:selection,model_selection:selection,selection_cursor:{kind:'durable',...cursor()}});
    const fragment=(value,through)=>{const json=JSON.stringify(value),bytes=Buffer.byteLength(json);
      return {json,offset:0,next_offset:bytes,total_bytes:bytes,through_seq:through};};
    const wake=()=>{for(const notify of durableWaiters)notify();};
    const call=async(method,args,signal)=>{
      assert.equal(args.request,'owner');signal?.throwIfAborted();
      if(method==='application.cancel'){cancelCount++;return {session_id:'thread'};}
      assert.equal(method,'application.history');const op=args.operation;
      if(op.type==='open')return metadata();
      if(op.type==='controls')return fragment([],1);
      if(op.type==='fact')return fragment([facts[op.after_seq]],op.after_seq+1);
      if(op.type==='wait') {
        if(op.cursor.fact_seq<facts.length)return cursor();
        return new Promise((resolve,reject)=>{
          const done=()=>{durableWaiters.delete(done);signal?.removeEventListener('abort',abort);resolve(cursor());};
          const abort=()=>{durableWaiters.delete(done);reject(signal.reason);};
          durableWaiters.add(done);signal?.addEventListener('abort',abort,{once:true});
        });
      }
      if(op.type==='model_open'){readers.set(op.key,{offset:0,events:modelEvents});return;}
      const reader=readers.get(op.key);assert.ok(reader,op.type);
      if(op.type==='model_close') {
        // Cancellation must not cancel cleanup under the long-lived owner capability.
        assert.equal(signal,undefined);releaseCount++;readers.delete(op.key);reader.reject?.(Error('reader closed'));return;
      }
      assert.equal(op.type,'model_next');
      if(reader.offset===reader.events.length)await new Promise((resolve,reject)=>{
        const abort=()=>{reader.wake=undefined;reader.reject=undefined;reject(signal.reason);};
        signal?.addEventListener('abort',abort,{once:true});
        reader.wake=()=>{signal?.removeEventListener('abort',abort);reader.wake=undefined;reader.reject=undefined;resolve();};
        reader.reject=error=>{signal?.removeEventListener('abort',abort);reader.wake=undefined;reader.reject=undefined;reject(error);};
      });
      const events=reader.events.slice(reader.offset);reader.offset=reader.events.length;
      return {...fragment(events),revision:reader.offset,complete:true,status:{state:'streaming'}};
    };
    const scope=applicationSessions(call,{owner:'owner',agent:id=>agents?.get(id)});
    scope.inbox.capture=async()=>{
      captures++;
      return {kind:'durable',session_id:'thread',cursor:cursor(),history:metadata(),active_turn_id:active,pending:[]};
    };
    const history=workbenchHistory({ctx,api,llm,read:scope.history,release:scope.releaseHistory,listChildren:async()=>[],authorize:async()=>{}});
    const adapterOwner=ctx.plugin({inject:['agents','sessionProjections'],apply(){}});await adapterOwner;
    agents=await workbenchAgents(adapterOwner.ctx,scope,history,await load('dsh-scope'),await load('dsh-agent'),api.snapshotJsonValue);
    t.after(async()=>{await ctx.fiber.dispose();await scope.close();await history.close();});
    ctx.on('agent/assistant-stream',({agent,frame})=>{assert.equal(agent.id,'thread');frames.push(frame);frameCaptures.push(captures);sequence.push(frame.type);});
    ctx.on('agent/assistant-stream',({frame})=>{
      if(frame.type!=='chunk')return;
      try {void scope.publish(async()=>{notificationWrites++;}).catch(error=>writeErrors.push(String(error)));}
      catch(error){writeErrors.push(String(error));}
    });
    ctx.on('session/event',(_session,event)=>{
      sequence.push(event.type);if(event.type==='assistant/message')capturesAtCommit=captures;
    });
    const agent=await scope.runOwned(()=>agents.ensure('thread'));
    await until(()=>buffer.chunksFor('thread').length===2);
    assert.equal(captures,2,'attachment and its opening snapshot suffice for retained stream delivery');
    assert.equal(agent.status,'running');
    assert.equal(buffer.chunksFor('thread')[1].chunk.text,'prefix');
    assert.equal(agent.session.lastEvent('assistant/message'),undefined);
    modelEvents.push([7,{type:'content_delta',index:0,delta:{type:'text',value:' tail'}}]);
    for(let i=0;i<70;i++)modelEvents.push([7,{type:'content_delta',index:0,delta:{type:'text',value:' '+i}}]);
    for(const reader of readers.values())reader.wake?.();
    await until(()=>buffer.chunksFor('thread').length===modelEvents.length);
    assert.equal(captures,2,'transient chunks do not recapture native state');
    assert.deepEqual(writeErrors,[],'independent notification writes must not consume a lifetime publication budget');
    for(const reader of readers.values())reader.reject?.(Error('injected read disconnect'));
    await until(()=>frames.some(frame=>frame.type==='end'&&frame.outcome.kind==='abandoned'));
    assert.deepEqual(buffer.chunksFor('thread'),[]);
    await until(()=>frames.filter(frame=>frame.type==='start').length===2&&buffer.chunksFor('thread').length===modelEvents.length);
    assert.equal(captures,3,'reconnection refreshes only its opening snapshot');
    assert.equal(releaseCount,1);
    const settled=[...modelEvents,[8,{type:'content_delta',index:0,delta:{type:'text',value:' final'}}],
      [9,{type:'content_finished',index:0}],[10,{type:'finished',reason:'stop'}]];
    add({type:'model_attempt_settled',effect_id:current,purpose:'conversation',attempt:{retain_context:true,events:settled}});
    add({type:'step_ended',turn_id:active,step_id:'step-'+active});
    add({type:'turn_terminal',turn_id:active,outcome:{status:'completed'}});active=null;wake();
    await until(()=>frames.some(frame=>frame.type==='end'&&frame.outcome.kind==='committed'));
    const end=frames.at(-1),event=agent.session.eventAt(end.outcome.seq);
    assert.equal(frameCaptures.at(-1),capturesAtCommit,'committed end reuses the view that published its assistant event');
    assert.equal(agent.status,'idle');
    assert.equal(event.type,'assistant/message');assert.equal(end.outcome.eventType,event.type);
    assert.ok(sequence.lastIndexOf('assistant/message')<sequence.lastIndexOf('end'));
    const second=frames.slice(frames.findLastIndex(frame=>frame.type==='start')).filter(frame=>frame.type==='chunk');
    assert.deepEqual(second.map(({time,chunk})=>({time,chunk})),llm.expandAssistantStream(event.data.stream));
    assert.deepEqual(second.map(frame=>frame.index),second.map((_,i)=>i));assert.equal(end.index,second.length);
    assert.deepEqual(buffer.chunksFor('thread'),[]);assert.equal(readers.size,0);
    active='turn-2';current='effect-2';modelEvents=modelEvents.slice(0,2);begin();wake();
    await until(()=>buffer.chunksFor('thread').length===2);
    assert.equal(agent.status,'running');
    await adapterOwner.dispose();
    assert.equal(frames.at(-1).outcome.kind,'abandoned');assert.deepEqual(buffer.chunksFor('thread'),[]);
    assert.equal(readers.size,0);assert.equal(durableWaiters.size,0);assert.equal(releaseCount,3);
    assert.equal(cancelCount,0,'an attached reader does not own native execution');
    assert.deepEqual(frames.map(frame=>frame.revision),frames.map((_,i)=>i+1));
    assert.deepEqual(writeErrors,[]);assert.equal(notificationWrites,frames.filter(frame=>frame.type==='chunk').length);
  });
