import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { applicationTools } from '../../src/tools/application-tools.mjs';
import { applicationSessions } from '../../src/application/sessions.mjs';
import { SessionFacade } from '../../src/session/session.mjs';
import { prepareRequestInputs, runtimeContextProjection } from '../../src/agent/request-input.mjs';

const root = process.env.RSI_DSH_MARKET_COHORT;
const selection = { provider: 'native', model: 'actual', reasoningEffort: 'high' };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-pre-step-'));
  const require = createRequire(join(root, 'package.json'));
  const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
  const ctx = new (await load('cordis')).Context(), agentApi = await load('dsh-agent');
  for (const name of ['dsh-session-projection', 'dsh-system-prompt']) await ctx.plugin((await load(name)).default);
  const tools = await load('dsh-tools'); await ctx.plugin(tools.default);
  await (await ctx.plugin(agentApi.AgentRegistry)).await();
  const api = Object.assign({}, await load('dsh-session'), await load('dsh-session/surface'), await load('dsh-util-values'));
  const session = new SessionFacade(ctx, api, { header: { version: 4, id: 'prepared', cwd: directory, createdAt: 1, isSeeded: false } });
  session.begin(); session.appendObserved('turn/start', { turn: 1 }, 1); session.end();
  const agent = { id: session.id, session }, world = (await load('dsh-scope')).createScope(ctx, agent); agent.ctx = world.ctx;
  const sessions = applicationSessions(() => { throw Error('unexpected native command'); });
  const key = randomUUID();
  const listener = await applicationTools(ctx, { load: name => import(pathToFileURL(require.resolve(name))), key,
    generation: randomUUID(), directory, sessions, resolveAgent: async id => { assert.equal(id, agent.id); return agent; } });
  t.after(async () => { await ctx.fiber.dispose(); await sessions.close(); await rm(directory, { recursive: true, force: true }); });
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${listener.port}/v1/${path}`, { method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const capture = (reserved = []) => post('capture', { view: randomUUID(), header: session.header, reserved, modelSelection: selection });
  const input = { turn_id: 'native-turn', step_id: 'native-step', fact_horizon: 5, claims: [4, 5].map((seq, i) => ({
    seq, timestamp_ms: seq, type: 'input_message_claimed', turn_id: 'native-turn', step_id: 'native-step',
    source: { type: 'human', attribution: { id: `message-${i}`, source: { kind: 'user' } } },
    content: [{ type: 'text', text: ['first', 'second'][i] }],
  })) };
  return { ctx, agent, session, world, post, capture, input, load, require, directory, agentApi, listener, key };
}

test('stopping awaits listeners on the captured Agent and propagates failures', { skip: !root }, async t => {
  const f=await fixture(t), {view}=await f.capture();
  const seen=[];
  f.world.ctx.on('agent/turn-stopping',async ({agent,turn,signal})=>{
    assert.equal(agent,f.agent);assert.equal(turn,1);assert.equal(signal.aborted,false);
    await Promise.resolve();seen.push('first');
  });
  f.world.ctx.on('agent/turn-stopping',()=>{seen.push('second');});
  assert.equal(await f.post('stopping',{view}),null);
  assert.deepEqual(seen,['first','second']);
  const second=await f.capture();
  f.world.ctx.on('agent/turn-stopping',()=>{throw Error('stop hook failed');});
  await assert.rejects(f.post('stopping',{view:second.view}),/stop hook failed/);
});

async function nativeCall(f,captured,command,callId=randomUUID()){
  const WS=f.require('ws'),socket=new WS(`ws://127.0.0.1:${f.listener.port}/v1/native`,{headers:{authorization:f.key}});
  await once(socket,'open');
  const read=async()=>JSON.parse((await once(socket,'message'))[0]);
  socket.send(JSON.stringify({view:captured.view,session:f.agent.id,call_id:callId,name:'bash',args:{command},output_schema:{type:'object'}}));
  return {socket,read};
}

test('the original approval service suspends native policy once and takes the exact human response',
  { skip:!root, timeout:15000 },async t=>{
    const f=await fixture(t);
    await (await f.ctx.plugin((await f.load('dsh-user-approval')).default,{})).await();
    f.world.ctx.on('tools/pre-execute',()=>({kind:'ask',reason:'Review native stdout'}));
    const captured=await f.capture(['bash']);
    f.session.begin();
    try{
      for(const allow of [true,false]){
        const {socket,read}=await nativeCall(f,captured,'print');
        assert.deepEqual(await read(),{state:'ask',reason:'Review native stdout'});
        socket.send(JSON.stringify({allow}));
        if(allow){
          assert.deepEqual(await read(),{state:'next'});
          socket.send(JSON.stringify({value:{ok:true},is_error:false,content:[]}));
          assert.deepEqual(await read(),{state:'unchanged'});
        }else{
          const denied=await read();
          assert.equal(denied.state,'denied');assert.match(denied.reason,/rejected/);
        }
        socket.close();
      }
      const {setApprovalPolicy}=await f.load('dsh-user-approval');
      setApprovalPolicy(f.session,'never');
      const {socket,read}=await nativeCall(f,captured,'print');
      const denied=await read();assert.equal(denied.state,'denied');assert.match(denied.reason,/rejected/);socket.close();
      const audit=f.session.snapshotEvents().filter(e=>e.type.startsWith('approval/'));
      assert.deepEqual(audit.filter(e=>e.type==='approval/asked').map(e=>e.data.id),
        audit.filter(e=>e.type==='approval/decided').map(e=>e.data.id));
      assert.deepEqual(audit.filter(e=>e.type==='approval/decided').map(e=>e.data.outcome),['allowed-once','rejected','rejected']);
    }finally{f.session.end();}
  });

test('a post-tool approval stays with its original answerers after the native body starts', {skip:!root,timeout:10000}, async t=>{
  const f=await fixture(t);
  await (await f.ctx.plugin((await f.load('dsh-user-approval')).default,{})).await();
  const answered=[];
  f.world.ctx.on('approval/request',request=>{answered.push(request.reason);return 'rejected';});
  f.world.ctx.on('tools/post-execute',async(exec,_result,next)=>{
    const outcome=await f.ctx.get('approval').request({agent:f.agent,toolName:exec.name,callId:exec.callId,reason:'Publish tool output',signal:exec.signal});
    assert.equal(outcome,'rejected');return next();
  });
  const captured=await f.capture(['bash']);
  f.session.begin();
  try{
    const {socket,read}=await nativeCall(f,captured,'print');
    try{
      assert.deepEqual(await read(),{state:'next'});
      socket.send(JSON.stringify({value:{ok:true},is_error:false,content:[]}));
      assert.deepEqual(await read(),{state:'unchanged'});
      assert.deepEqual(answered,['Publish tool output']);
    }finally{socket.close();}
  }finally{f.session.end();}
});

test('original Claude Code Mods surrounds one native Bash continuation in the captured scope',
  { skip: !root || !process.env.RSI_DSH_MODS_ENTRY, timeout:15000 }, async t => {
    const f=await fixture(t),mods=await import(pathToFileURL(process.env.RSI_DSH_MODS_ENTRY));
    f.ctx.provide('workingDirectory',{get:()=>f.directory,ensure:async()=>f.directory});
    await (await f.ctx.plugin(mods.default)).await();
    const seen=[];
    await (await f.world.ctx.plugin(mods.defineMod({name:'native-shell-proof',register(on){
      on('tool.call',async(_,event,next)=>{
        seen.push([event.tool,event.command]);
        if(event.command==='deny')return {deny:'blocked before native Bash'};
        const result=await next(event);
        if(event.command==='unchanged')return result;
        assert.match(JSON.stringify(result),/native stdout/);
        return {...result,result:'original mod rendered this text'};
      });
    }}))).await();
    const captured=await f.capture(['bash']),body={value:{stdout:'native stdout'},is_error:false,content:[{type:'text',text:'native stdout'}]};
    for(const command of ['deny','rewrite','unchanged']){
      const {socket,read}=await nativeCall(f,captured,command);
      let result=await read();
      if(command==='deny'){
        assert.equal(result.state,'denied');
        assert.match(result.reason,/blocked before native Bash/);
      }else{
        assert.deepEqual(result,{state:'next'});
        socket.send(JSON.stringify(body));
        result=await read();
        if(command==='unchanged')assert.deepEqual(result,{state:'unchanged'});
        else{
          assert.deepEqual(result,{state:'rendered',content:[{type:'text',text:'original mod rendered this text'}],additional_contexts:[]});
        }
      }
      socket.close();
    }
    assert.deepEqual(seen,[['Bash','deny'],['Bash','rewrite'],['Bash','unchanged']]);
  });

test('a native execution source does not replace the same-name plugin in the public registry',
  {skip:!root,timeout:15000},async t=>{
    const f=await fixture(t),tools=await f.load('dsh-tools');
    let pluginCalls=0;
    const plugin=tools.defineTool({name:'bash',description:'plugin Bash',parameters:{},
      output:{schema:{type:'string'},render:(_,text)=>[{type:'text',text}]},
      async execute(){pluginCalls++;return 'plugin';}});
    f.ctx.tools.register(plugin);
    const observed=[];
    f.world.ctx.on('tools/pre-execute',(exec,next)=>{
      observed.push(f.ctx.tools.get(exec.name,exec.agent)===plugin,
        f.ctx.tools.executable(exec.name,exec.agent,exec.toolSet)===plugin);
      return next();
    });
    const {socket,read}=await nativeCall(f,await f.capture(['bash']),'native');
    socket.on('error',()=>{});t.after(()=>socket.close());
    assert.deepEqual(await read(),{state:'next'});
    socket.send(JSON.stringify({value:{native:true},is_error:false,content:[]}));
    assert.deepEqual(await read(),{state:'unchanged'});
    assert.deepEqual(observed,[true,true]);assert.equal(pluginCalls,0);
  });

test('a post-execute correction survives native policy refusal before the body starts',
  {skip:!root},async t=>{
    const f=await fixture(t);
    const correction={id:'refusal',role:'user',source:{kind:'plugin',id:'review'},
      content:[{type:'text',text:'Use the read-only tool instead.'}]};
    f.world.ctx.on('tools/pre-execute',()=>({kind:'deny',reason:'operation withheld'}));
    f.world.ctx.on('tools/post-execute',()=>({kind:'accept',additionalContexts:[correction]}));
    const {socket,read}=await nativeCall(f,await f.capture(['bash']),'declined');
    try {
      const reply=await read();
      assert.equal(reply.state,'denied');assert.match(reply.reason,/operation withheld/);
      assert.deepEqual(reply.additional_contexts,[{id:correction.id,source:correction.source,text:[correction.content[0].text]}]);
    } finally {socket.close();}
  });

test('overlapping native bodies keep separate continuations, including a native failure with its original blocks',
  {skip:!root,timeout:15000},async t=>{
    const f=await fixture(t),captured=await f.capture(['bash']);
    const left=await nativeCall(f,captured,'left'),first=await left.read();
    assert.deepEqual(first,{state:'next'});
    const right=await nativeCall(f,captured,'right'),second=await right.read();
    assert.deepEqual(second,{state:'next'});
    assert.equal(f.ctx.tools.get('bash',f.agent),undefined);
    right.socket.send(JSON.stringify({value:{errno:5},is_error:true,content:[
      {type:'text',text:'native error'},{type:'text',text:'native stderr'}]}));
    assert.deepEqual(await right.read(),{state:'unchanged'});
    left.socket.send(JSON.stringify({value:{done:true},is_error:false,content:[{type:'text',text:'left complete'}]}));
    assert.deepEqual(await left.read(),{state:'unchanged'});
    right.socket.close();left.socket.close();
  });

test('same captured Fiber prepares input once with its original selection and assembly, even with no Tools', { skip: !root }, async t => {
  const f = await fixture(t); let assemblies = 0, hooks = 0;
  await f.world.ctx.plugin({ inject: ['systemPrompt'], apply(ctx) {
    ctx.systemPrompt.context({ name: 'state', order: 1, text(context) {
      assemblies++; assert.equal(context.agent, f.agent); assert.deepEqual(context.modelSelection, selection); return 'RUNTIME_VALUE';
    } });
    ctx.on('agent/pre-step', async (event, next) => {
      hooks++; assert.equal(event.agent, f.agent); assert.deepEqual(event.modelSelection, selection);
      assert.equal(event.turn, 1); assert.equal(event.step, 1);
      const result = await next();
      return { kind: 'enter', messages: [result.messages[1], { ...result.messages[0], content: [] }, ...result.messages.slice(2)] };
    });
  } });
  const capture = await f.capture(); assert.deepEqual(capture.tools, []);
  const request = { view: capture.view, session: f.agent.id, input: f.input };
  const [first, second] = await Promise.all([f.post('prepare', request), f.post('prepare', request)]);
  assert.deepEqual(second, first); assert.equal(hooks, 1); assert.equal(assemblies, 1);
  assert.deepEqual(first.messages.slice(0, 2).map(row => [row.kind, row.claim.fact_seq]), [['claimed', 5], ['replacement', 4]]);
  assert.deepEqual(first.messages[1].message.content, []);
  assert.equal(first.messages[2].kind, 'added');
  assert.deepEqual(first.messages[2].message.attribution.source, { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'state', text: 'RUNTIME_VALUE' }] });
  assert.ok(!f.session.snapshotEvents().some(event => event.type === 'user/message'), 'preparing a reply is not a Session commit');
});

test('the original pre-step hook can reorder and replace file references without file bytes or paths', {skip:!root},async t=>{
  const f=await fixture(t),file={id:'a'.repeat(64),name:'source.txt',bytes:8_000_000_000};
  f.input.claims[0].content=[{type:'file',file}];
  f.world.ctx.on('agent/pre-step',async({messages},next)=>{
    assert.deepEqual(messages[0].content,[{type:'file',attachment:{attachmentId:'sha256:'+file.id,name:file.name,bytes:file.bytes}}]);
    const result=await next();
    result.messages[0].content[0].attachment.name='replacement.txt';
    return {kind:'enter',messages:[result.messages[1],result.messages[0]]};
  });
  const captured=await f.capture(),result=await f.post('prepare',{view:captured.view,session:f.agent.id,input:f.input});
  assert.deepEqual(result.messages[0],{kind:'claimed',claim:{fact_seq:5,ordinal:0}});
  assert.deepEqual(result.messages[1].message.content,[{type:'file',file:{...file,name:'replacement.txt'}}]);
  assert.equal(f.input.claims[0].content[0].file.name,'source.txt');
  assert.ok(Buffer.byteLength(JSON.stringify(result))<1024);
});

test('original Claude Code Mods rewrites and rejects through the application HTTP preparation endpoint',
  { skip: !root || !process.env.RSI_DSH_MODS_ENTRY }, async t => {
    const f = await fixture(t); const mods = await import(pathToFileURL(process.env.RSI_DSH_MODS_ENTRY));
    f.ctx.provide('workingDirectory', { get: () => f.directory, ensure: async () => f.directory });
    await (await f.ctx.plugin(mods.default)).await();
    let reject = false, calls = 0;
    await (await f.ctx.plugin(mods.defineMod({ name: 'application-input-proof', register(on) {
      on('prompt.submit', async (_, event) => {
        calls++; assert.equal(event.text, 'firstsecond');
        return reject ? { drop: 'original rejection' } : { text: 'original Mods replacement' };
      });
    } }))).await();
    for (const rejected of [false, true]) {
      reject = rejected; const capture = await f.capture();
      const result = await f.post('prepare', { view: capture.view, session: f.agent.id, input: f.input });
      if (reject) assert.deepEqual(result, { kind: 'reject' });
      else {
        assert.equal(result.kind, 'enter'); assert.equal(result.messages.length, 2);
        assert.deepEqual(result.messages.map(row => [row.kind, row.claim.fact_seq, row.message.content]), [
          ['replacement', 4, [{ type: 'text', text: 'original Mods replacement' }]], ['replacement', 5, []],
        ]);
      }
    }
    assert.equal(calls, 2);
  });

test('application edits the previous preset list and preserves its claim and new native guidance', {skip: !root}, async t => {
  const f = await fixture(t), capture = await f.capture();
  f.ctx.on('agent/pre-step', async ({ messages }, next) => {
    assert.deepEqual(messages.map(message=>message.id), ['preset']);
    const decision = await next();
    decision.messages[0].content[0].text = 'changed again';
    return decision;
  });
  const previous = {kind:'enter',messages:[{kind:'replacement',claim:{fact_seq:4,ordinal:0},
    message:{role:'user',attribution:{id:'preset',source:{kind:'user'}},content:[{type:'text',text:'preset edit'}]}}]};
  const input = {...f.input,previous,trailing_facts:1,contributed:[{type:'input_message_claimed',
    source:{type:'plugin_context',contribution_id:'native-a'},content:[{type:'text',text:'new context'}]}]};
  const result = await f.post('prepare',{view:capture.view,session:f.agent.id,input});
  assert.equal(result.messages[0].kind,'replacement');
  assert.deepEqual(result.messages[0].claim,{fact_seq:4,ordinal:0});
  assert.equal(result.messages[0].message.content[0].text,'changed again');
  assert.deepEqual(result.messages[1],{kind:'claimed',claim:{preceding:2,ordinal:0}});
});

test('preparation admits the combined native input budgets beyond the ordinary Tool envelope', { skip: !root }, async t => {
  const f = await fixture(t), content = [{ type: 'text', text: 'x'.repeat(1024 * 1024 - 1024) }];
  f.input.claims = Array.from({ length: 34 }, (_, i) => ({ ...f.input.claims[0], seq: i + 1,
    source: i < 31 ? { type: 'human', message_id: `human-${i}` } : { type: 'agent_instructions' }, content }));
  f.input.fact_horizon = 34;
  const capture = await f.capture(), request = { view: capture.view, session: f.agent.id, input: f.input };
  assert.ok(Buffer.byteLength(JSON.stringify(request)) > 32 * 1024 * 1024);
  const result = await f.post('prepare', request);
  assert.equal(result.messages.length, 34);
  assert.ok(result.messages.every(row => row.kind === 'claimed'));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
  const second = await f.capture();
  const previous = { kind: 'enter', messages: [...result.messages, ...Array.from({ length: 32 }, (_, i) => ({
    kind: 'added', message: { role: 'user', attribution: { id: `preset-${i}`, source: { kind: 'preset' } }, content },
  }))] };
  const mixed = { view: second.view, session: f.agent.id, input: { ...f.input, previous } };
  assert.ok(Buffer.byteLength(JSON.stringify(previous)) < 32 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(mixed)) > 65 * 1024 * 1024);
  f.ctx.on('agent/pre-step', ({ messages }) => {
    assert.equal(messages.at(-1).id, 'preset-31');
    return { kind: 'enter', messages: [messages[0]] };
  });
  assert.deepEqual(await f.post('prepare', mixed), { kind: 'enter', messages: [result.messages[0], ...result.messages.slice(-3)] });
});

test('prepared user order preserves native guidance slots and ambiguous IDs grant no claim provenance', async () => {
  const claim = (seq, type, id, text) => ({ seq, type: 'input_message_claimed', source: type === 'human'
    ? { type, attribution: { id, source: { kind: 'user' } } } : { type }, content: [{ type: 'text', text }] });
  const input = { claims: [claim(1, 'human', 'same', 'one'), claim(2, 'agent_instructions', 'guide', 'guide'), claim(3, 'human', 'same', 'two')] };
  const decision = await prepareRequestInputs({ ctx: {}, agent: { id: 'native', session: {} }, input, signal: new AbortController().signal }, {
    agentEvents: () => ({ waterfall: async (_, event) => ({ kind: 'enter', messages: [
      { ...event.messages[1], content: [{ type: 'text', text: 'replacement with ambiguous identity' }] }, event.messages[0],
    ] }) }),
  });
  assert.deepEqual(decision.messages.map(row => row.kind), ['added', 'claimed', 'claimed']);
  assert.deepEqual(decision.messages.slice(1).map(row => row.claim.fact_seq), [2, 1]);
  const dropped = await prepareRequestInputs({ ctx: {}, agent: { id: 'native', session: {} }, input, signal: new AbortController().signal }, {
    agentEvents: () => ({ waterfall: async () => ({ kind: 'enter', messages: [] }) }),
  });
  assert.deepEqual(dropped, { kind: 'enter', messages: [] }, 'native guidance cannot keep a removed waking input running');
});

test('mutating a hook message cannot edit the captured source, image or text', async () => {
  const fact = { type: 'input_message_claimed', seq: 1,
    source: { type: 'human', attribution: { id: 'human', source: { kind: 'user', data: { owner: 'original' } } } },
    content: [{ type: 'text', text: 'original' }, { type: 'image', media: { id: 'a'.repeat(64), mime: 'image/png', bytes: 1024, width: 64, height: 32 } }] };
  const captured = structuredClone(fact);
  const result = await prepareRequestInputs({ agent: { id: 'native', session: {} },
    input: { claims: [fact] }, signal: new AbortController().signal }, {
    agentEvents: () => ({ waterfall: (_, { messages }) => {
      messages[0].source.data.owner = 'edited';
      messages[0].content[0].text = 'edited';
      messages[0].content[1].attachment.attachmentId = 'sha256:'+'b'.repeat(64);
      return { kind: 'enter', messages };
    } }),
  });
  assert.deepEqual(fact, captured);
  const edited = result.messages[0];
  assert.equal(edited.kind, 'replacement');
  assert.equal(edited.message.attribution.source.data.owner, 'edited');
  assert.equal(edited.message.content[0].text, 'edited');
  assert.equal(edited.message.content[1].media.id, 'b'.repeat(64));
});

test('runtime context follows only committed surface state and agrees with original DSH projection',
  { skip: !root || !process.env.RSI_DSH_RUNTIME_CONTEXT_SOURCE }, async t => {
    const f = await fixture(t), outfile = join(f.directory, 'original-context.mjs');
    const {build}=await import('esbuild');
    await build({ entryPoints: [process.env.RSI_DSH_RUNTIME_CONTEXT_SOURCE], outfile, bundle: true,
      platform: 'node', format: 'esm', target: 'es2022', nodePaths: [join(root, 'node_modules')], logLevel: 'silent',
      plugins: [{ name: 'published-contracts', setup(build) {
        build.onResolve({ filter: /^@deepseek-ai\// }, args => ({ path: pathToFileURL(f.require.resolve(args.path)).href, external: true }));
      } }] });
    const { RuntimeContextProjection } = await import(pathToFileURL(outfile));
    let listener;
    const original = new RuntimeContextProjection({ on(_, handler) { listener = handler; } }, f.session);
    const prompt = await f.load('dsh-system-prompt'), llm = await f.load('dsh-llm');
    const port = runtimeContextProjection({ ...prompt, ...llm });
    const project = value => {
      const assembly = { contexts: [{ name: 'proof', text: value }], variables: {} };
      const sections = prompt.renderContextSections(assembly);
      const expected = original.project(prompt.joinContextSections(sections), sections), actual = port(f.session, assembly);
      const normalized = message => message && { role: message.role, source: message.source, content: message.content };
      assert.deepEqual(normalized(actual), normalized(expected)); return actual;
    };
    assert.equal(project(''), undefined);
    const first = project('first'); assert.ok(project('first'), 'uncommitted preparation does not advance the baseline');
    f.session.begin(); const event = f.session.appendObserved('user/message', first, 2, { surfaceOp: 'append' }); f.session.end();
    listener(f.session, event); assert.equal(project('first'), undefined);
    const clear = project(''); assert.ok(clear.content[0].text.includes('no longer apply'));
    f.session.begin(); const cleared = f.session.appendObserved('user/message', clear, 3, { surfaceOp: 'append' }); f.session.end();
    listener(f.session, cleared); assert.equal(project(''), undefined);
    const restored = runtimeContextProjection({ ...prompt, ...llm });
    assert.equal(restored(f.session, { contexts: [], variables: {} }), undefined);
    assert.ok(project('second'));
  });
