import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {workbenchCompaction} from '../../src/workbench/compaction.mjs';

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
