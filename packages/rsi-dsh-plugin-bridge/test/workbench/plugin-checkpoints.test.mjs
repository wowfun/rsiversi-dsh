import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {bindCheckpointSession, captureCheckpointAppend, installCheckpointEngine} from '../../src/workbench/plugin-checkpoints.mjs';
import {compactionLanguage,pluginCheckpoint} from '../../src/history/compaction-history.mjs';
import {SessionProjectionJournal} from '../../src/session/session-projection-journal.mjs';
import {readJournalDocument} from '../../src/session/journal-document.mjs';
import {modelObservationCorrelations} from '../../src/session/model-intents.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';

test('an unmodified basic-engine subclass installs its own framed checkpoint without a model',
  {skip:!process.env.RSI_DSH_MARKET_COHORT},async t=>{
    const require = createRequire(join(process.env.RSI_DSH_MARKET_COHORT,'package.json'));
    const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
    const hook = installCheckpointEngine(require.resolve('@deepseek-ai/dsh-compaction-basic'));
    t.after(()=>hook.deregister());
    const {Context} = await load('cordis');
    const ctx = new Context();
    t.after(()=>ctx.fiber.dispose());
    ctx.baseUrl=import.meta.url;
    await ctx.plugin((await load('cordis-plugin-loader')).default);
    await ctx.plugin((await load('dsh-session')).default);
    await ctx.plugin((await load('dsh-llm')).default);
    new (await load('dsh-session-projection')).default(ctx);
    new (await load('dsh-token-meter')).default(ctx);
    const sdk = await load('dsh-compaction-basic');
    assert.equal(sdk.BasicCompactionEngine,sdk.default);
    assert.equal(require('@deepseek-ai/dsh-compaction-basic').default,sdk.default);
    const llm = compactionLanguage(await load('dsh-llm'),(name,path)=>load(name.slice('@deepseek-ai/'.length)+'/'+path));
    const {Session} = await load('dsh-session');
    let runs=0, rejectSummary=true, pending;
    class Template extends sdk.BasicCompactionEngine {
      async summarize(input) {
        assert.match(JSON.stringify(input.messages), /old text/);
        assert.equal(session.lastEvent('compaction/start').seq,session.seq-1);
        if(rejectSummary)throw Error('template unavailable');
        if(pending){pending.entered.resolve();await pending.release.promise;}
        runs++;
        return {provider:'template',model:'offline',summary:[{type:'text',text:'ORCHID'}]};
      }
    }
    let engine;
    const consumer={inject:['compaction'],apply(ctx){engine=ctx.get('compaction');}};
    ctx.loader.internal={import(name) {
      if(name==='dsh-template-checkpoint')return Template;
      assert.equal(name,'dsh-checkpoint-consumer');return consumer;
    }};
    const entry=await ctx.loader.create({name:'dsh-template-checkpoint',config:{auto:false}});
    await ctx.loader.create({name:'dsh-checkpoint-consumer'});
    await ctx.loader.await();
    assert.ok(engine);
    const raw = Session.create('template-session');
    raw.append('turn/start',{turn:1});
    const source = raw.append('user/message',llm.createUserMessage({content:[{type:'text',text:'old text '.repeat(1000)}],
      source:{kind:'user'}}),{surfaceOp:'append'});
    const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
    const seed={header:raw.header};
    const journal=new SessionProjectionJournal(ctx,api,seed);
    journal.merge(raw.snapshotEvents());
    const session = new Proxy(journal.session,{get(target,key) {
      if(key==='append')return (type,data,opts={})=>captureCheckpointAppend(session,type,data,opts);
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    }});
    const observed=new Proxy(raw,{get(target,key){
      if(key==='adoptObserved')return ({type,data,surfaceOp,sourceEventSeqs})=>target.append(type,data,{surfaceOp,sourceEventSeqs});
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    }});
    let fact, rejectCommit=true;
    const scope=applicationSessions(async(method,{session_id:id,request,operation:op})=>{
      assert.equal(method,'application.command');
      assert.equal(id,raw.id);
      if(request==='guest'){assert.equal(op.type,'check_checkpoint_owner');return false;}
      assert.equal(request,'enabled-plugin');
      assert.equal(op.type,'install_plugin_checkpoint');
      assert.equal(op.checkpoint.plugin,'dsh-template-checkpoint');
      if(rejectCommit)return {rejected:'conversation changed'};
      fact={type:'plugin_context_compacted',turn_id:op.turn,effect_id:op.effect,checkpoint:op.checkpoint,timestamp_ms:17};
      return null;
    },{owner:'enabled-plugin'});
    t.after(()=>scope.close());
    bindCheckpointSession(session,{region:()=>({turn_id:'open',through_seq:2,start:0,end:0}),
      lifecycle:(type,data)=>journal.accept(type+':'+data.compactionId,type,data),
      scope,
      async refresh(){
        await pluginCheckpoint(observed,{turn:1},fact,llm);
        const events=raw.snapshotEvents();
        journal.merge(events, modelObservationCorrelations(journal,{},events,new Map()));
      }});
    const agent={id:raw.id,options:{},session};
    const guest=await scope.prepare({url:'/',headers:{'x-rsi-upstream-request':'guest'}});
    await assert.rejects(guest(()=>engine.compactRegion(source.seq,source.seq,agent)),/Host owner required/);
    assert.equal(session.seq,raw.seq);
    await assert.rejects(engine.compactRegion(source.seq,source.seq,agent),/template unavailable/);
    assert.match(JSON.stringify(session.lastEvent('compaction/end').data.error),/template unavailable/);
    assert.equal(fact,undefined);
    rejectSummary=false;
    await assert.rejects(engine.compactRegion(source.seq,source.seq,agent),/conversation changed/);
    assert.equal(session.lastEvent('compaction/end').data.error,'conversation changed');
    assert.equal(fact,undefined);
    rejectCommit=false;
    pending={entered:Promise.withResolvers(),release:Promise.withResolvers()};
    const inflight=engine.compactRegion(source.seq,source.seq,agent);
    await pending.entered.promise;
    await ctx.loader.update(entry,{disabled:true});
    await ctx.loader.await();
    pending.release.resolve();pending=undefined;
    await assert.rejects(inflight);
    assert.ok(session.lastEvent('compaction/end').data.error);
    assert.equal(fact,undefined,'unloaded provider cannot submit a late summary');
    await ctx.loader.update(entry,{disabled:false});
    await ctx.loader.await();
    const result=await engine.compactRegion(source.seq,source.seq,agent);
    assert.equal(runs,3);
    assert.deepEqual(result.summary,[{type:'text',text:'ORCHID'}]);
    assert.deepEqual(result.shadowedSeqs,[source.seq]);
    assert.equal(session.eventAt(result.summarySeq).data.rsi.plugin,'dsh-template-checkpoint');
    assert.equal(session.eventAt(result.summarySeq).data.model,'offline');
    assert.match(session.eventAt(source.seq).data.content[0].text,/old text/);
    assert.deepEqual(session.eventAt(session.surface.nodes[0]).data.content,fact.checkpoint.message.content);
    assert.equal(session.snapshotEvents().filter(e=>e.type==='compaction/start').length,4);
    const cold=new SessionProjectionJournal(ctx,api,seed,{restore:readJournalDocument(journal.encode()),native:raw.snapshotEvents()});
    assert.deepEqual(cold.session.snapshotEvents(),session.snapshotEvents());
    assert.equal(fact.checkpoint.message.role,'user');
    assert.deepEqual(fact.checkpoint.message.content.map(b=>b.text).slice(1,-1),['ORCHID']);
    const beforeRemoval=session.seq;
    ctx.loader.remove(entry);
    await ctx.loader.await();
    assert.equal(ctx.get('compaction'),undefined);
    await assert.rejects(engine.compactRegion(session.surface.nodes[0],session.surface.nodes[0],agent));
    assert.equal(session.seq,beforeRemoval,'a retired engine cannot start another compaction');
  });
