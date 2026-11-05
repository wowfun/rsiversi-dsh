import {nativeTool} from '../fixtures/native-tool.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridge } from '../../src/index.mjs';
import { loadCohort } from '../../../rsi-dsh-cordis/src/runtime/cohort.mjs';
import { toolPipeline } from '../../src/tools/tool-pipeline.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const cohortRoot = process.env.RSI_DSH_MARKET_COHORT;
test('published time-context recognizes its committed input after a process restart', {skip: !cohortRoot}, async t => {
  const facts = [];
  function add(type, fields) {
    facts.push({seq:facts.length + 1, timestamp_ms:Date.now(), type, turn_id:'turn', ...fields});
  }
  add('turn_accepted', {text:'A human message'});
  add('step_started', {step_id:'one'});
  const options = {cohortRoot, configuration:{format:1, plugins:['@deepseek-ai/dsh-time-context']},
    request:async (method, {after_seq, offset}) => {
      assert.equal(method,'agent.history.read');
      assert.equal(offset,0);
      const fact = facts[after_seq];
      const json = JSON.stringify([fact]);
      const bytes = Buffer.byteLength(json);
      return {through_seq:fact.seq, offset, next_offset:bytes, total_bytes:bytes, json};
    }};
  let bridge = await createBridge(options);
  t.after(() => bridge.close());
  const prepare = (step_id) => bridge.agentBeforeStep({model_selection: {model:{deployment:'fixture',model:'test'}}, session_id:'time', operation_id:step_id, turn_id:'turn',
    step_id, tools:[], fact_horizon:facts.length});
  await bridge.load({header:{version:4,id:'time',createdAt:1,isSeeded:false},events:[],revision:0});
  const first = await prepare('one');
  assert.equal(first.kind,'staged',first.diagnostic);
  assert.deepEqual(first.decision.messages[0],{kind:'claimed',claim:{fact_seq:1,ordinal:0}});
  const addedText = decision => decision.messages.filter(row=>row.kind==='added')
    .flatMap(row=>row.message.content.map(block=>block.text));
  const injected = addedText(first.decision).find(text=>text.startsWith('Time sampled'));
  assert.ok(injected,JSON.stringify(first.decision));
  await bridge.receipt('time','one',first.token,'committed',1);
  const canonical = bridge.canonical('time');
  await bridge.close();
  bridge = await createBridge(options);
  await bridge.load(canonical);
  add('step_inputs_prepared',{step_id:'one',decision:first.decision});
  add('step_ended',{step_id:'one'});
  add('step_started',{step_id:'two'});
  const second = await prepare('two');
  assert.equal(second.kind,'staged',second.diagnostic);
  const echoes = second.events.filter(e => e.type==='user/message' && e.data.source.kind==='time-context');
  assert.equal(echoes.length,1);
  assert.equal(echoes[0].data.content[0].text,injected);
  assert.ok(!addedText(second.decision).some(text=>text.startsWith('Time sampled')), JSON.stringify(second.decision));
  assert.equal(echoes[0].time, facts.find(fact => fact.type === 'step_inputs_prepared').timestamp_ms);
  assert.deepEqual(second.checkpoint.mapping.pendingMessages,[]);
});

test('released timeout middleware owns the deadline on both native and bridged calls', {skip: !cohortRoot}, async () => {
  const cohort = await loadCohort(cohortRoot);
  const [cordis,tools,policy] = await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-tool-call-timeout-policy'].map(name => cohort.import(name)));
  for (const bridged of [false,true]) {
    const ctx = new cordis.Context();
    try {
      await ctx.plugin((await cohort.import('@deepseek-ai/dsh-session-projection')).default);
      await ctx.plugin((await cohort.import('@deepseek-ai/dsh-system-prompt')).default);
      await (await ctx.plugin(tools.default)).await();
      if(!bridged)await ctx.plugin(await cohort.import('@deepseek-ai/dsh-tool-executor-native'));
      await ctx.plugin(policy);
      let calls = 0;
      ctx.tools.register(tools.defineTool({name:'cooperative',description:'waits for its deadline',
        parameters:{},output:{schema:{type:'string'},render:(_,text)=>[{type:'text',text}]},timeoutMs:25, async execute(_,exec) {
          calls++;
          await sleep(5000,undefined,{signal:exec.signal}).catch(error => {
            if (error.name !== 'AbortError') throw error;
          });
          return 'settled';
        }}));
      const run = bridged ? toolPipeline(ctx,await cohort.subpath('@deepseek-ai/dsh-tools','pipeline'),tools) : input => nativeTool(ctx,input);
      const input = {agent:{id:'deadline'},name:'cooperative',arguments:{},callId:'call',signal:AbortSignal.timeout(5000)};
      const result = await run(input);
      assert.equal(result.error?.info.code,'TOOL_TIMEOUT',JSON.stringify(result));
      assert.equal(calls,1);
      assert.equal(input.signal.aborted,false);
    } finally {
      await ctx.fiber.dispose();
    }
  }
});
