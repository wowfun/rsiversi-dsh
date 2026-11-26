import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {retainedRegion,workbenchCompaction} from '../../src/workbench/compaction.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';

const root = process.env.RSI_DSH_MARKET_COHORT;
test('released compact command reports native idle outcomes and links its own installed summary', {skip:!root}, async t => {
  const require = createRequire(join(root,'package.json'));
  const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx = new (await load('cordis')).Context();
  t.after(()=>ctx.fiber.dispose());
  await ctx.plugin((await load('dsh-session-projection')).default);
  await ctx.plugin((await load('dsh-commands')).default);
  const {CompactionEngine,ManualCompactionError} = await load('dsh-compaction');
  const session = (await load('dsh-session')).Session.create('native-idle-command');
  const agent = {id:session.id,session,status:'idle',options:{},reserveTurnAdmission:()=>()=>{}};
  let outcome='no_change', operation, refreshes=0;
  const Runtime = workbenchCompaction(CompactionEngine,ManualCompactionError,{
    withCaller:(run,signal)=>run(signal),
    async command(id,input) {assert.equal(id,agent.id);operation=input;return outcome;},
  },async id=>{
    assert.equal(id,agent.id); refreshes++;
    const identity={compactionId:'native-effect',sourceCommandId:operation.request_id};
    session.append('compaction/start',{...identity,turn:null});
    session.append('compaction/summary',{...identity,summary:[{type:'text',text:'installed'}],
      shadowedRange:{start:0,end:0},shadowedSeqs:[0],shadowedTokenCount:27,provider:'fixture',model:'model'});
    session.append('compaction/end',{...identity,turn:null});
  });
  await ctx.plugin(Runtime);
  const fiber=await ctx.plugin(await load('dsh-command-compact'));
  const run=()=>ctx.commands.execute(agent,'/compact',[],new AbortController().signal);
  assert.equal((await run()).result.text,'No compactable history yet.');
  outcome='busy';
  assert.match((await run()).result.text,/not idle/);
  assert.equal(refreshes,0);
  outcome='compacted';
  const {commandId,result}=await run();
  assert.deepEqual(operation,{type:'compact',request_id:commandId});
  assert.equal(result.text,'Compacted 1 history items (~27 tokens).');
  assert.equal(session.eventAt(result.sourceEventSeq).data.sourceCommandId,commandId);
  assert.equal(refreshes,1);
  await fiber.dispose();
  assert.equal(await run(),undefined);
});

test('a plugin selects retained application sequences in surface order and receives the installed native effect',
  {skip:!root}, async t => {
  const require = createRequire(join(root,'package.json'));
  const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx = new (await load('cordis')).Context();
  t.after(()=>ctx.fiber.dispose());
  await ctx.plugin((await load('dsh-session-projection')).default);
  const {CompactionEngine,ManualCompactionError} = await load('dsh-compaction');
  const {Session} = await load('dsh-session');
  const session = Session.create('selected-region');
  const native = Session.create('selected-region');
  const append = (target,id) => target.append('user/message',{id,role:'user',source:{kind:'user'},
    content:[{type:'text',text:id}]},{surfaceOp:'append'});
  session.append('turn/start',{turn:1});
  native.append('turn/start',{turn:1});
  const a = append(session,'a'), b = append(session,'b');
  const old = append(native,'a');
  append(native,'b');
  // An application-only log event has no native sequence. A replaced node
  // has a newer seq than the message following it on the surface.
  session.append('feedback/record',{text:'log only'});
  const newer = session.append('user/message',{...a.data,id:'replacement'},
    {surfaceOp:{op:'replace',startSeq:a.seq,endSeq:a.seq},sourceEventSeqs:[a.seq]});
  const replaced = native.append('user/message',newer.data,
    {surfaceOp:{op:'replace',startSeq:old.seq,endSeq:old.seq},sourceEventSeqs:[old.seq]});
  const owner = {source:{current:{session:native,mapping:{factCursor:17,turnId:'native-turn'}}},
    journal:{sourceAt:seq=>seq===replaced.seq?newer:session.eventAt(seq)}};
  const agent = {id:session.id,session,options:{},status:'running'};
  let calls=0;
  const scope=applicationSessions(async(method,{request,session_id,operation})=>{
      assert.equal(method,'application.command');
      if(request==='paired')throw Error('Host owner required');
      assert.equal(request,'plugin-owner');
      calls++;
      assert.equal(session_id,session.id);
      assert.deepEqual(operation,{type:'compact_region',region:{turn_id:'native-turn',through_seq:17,start:0,end:1}});
      return 'native-region';
  },{owner:'plugin-owner'});
  t.after(()=>scope.close());
  const Runtime = workbenchCompaction(CompactionEngine,ManualCompactionError,scope,async () => {
    const identity = {compactionId:'native-region'};
    session.append('compaction/start',{...identity,turn:1});
    session.append('compaction/summary',{...identity,summary:[{type:'text',text:'ab'}],
      shadowedRange:{start:newer.seq,end:b.seq},shadowedSeqs:[newer.seq,b.seq],shadowedTokenCount:24,provider:'p',model:'m'});
    session.append('compaction/end',{...identity,turn:1});
  },(_agent,start,end)=>retainedRegion(owner,start,end));
  await ctx.plugin(Runtime);
  const compact=(start,end)=>ctx.compaction.compactRegion(start,end,agent);
  await assert.rejects(compact(b.seq,newer.seq),/ordered endpoints/);
  await assert.rejects(compact(a.seq,b.seq),/ordered endpoints/);
  assert.equal(calls,0);
  const browser=await scope.prepare({url:'/',headers:{'x-rsi-upstream-request':'paired'}});
  await assert.rejects(browser(()=>compact(newer.seq,b.seq)),/Host owner required/);
  assert.equal(calls,0);
  const result=await compact(newer.seq,b.seq);
  assert.equal(calls,1);
  assert.equal(result.compactionId,'native-region');
  assert.equal(session.eventAt(result.summarySeq).type,'compaction/summary');
  assert.equal(session.eventAt(result.endSeq).data.compactionId,result.compactionId);
  assert.deepEqual(result.shadowedSeqs,[newer.seq,b.seq]);
  assert.equal(Object.hasOwn(result,'sourceCommandId'),false);
  owner.source.current.mapping.turnId=null;
  await assert.rejects(compact(newer.seq,b.seq),/open Turn/);
});
