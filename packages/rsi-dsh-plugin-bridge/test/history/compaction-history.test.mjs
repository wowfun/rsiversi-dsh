import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadCohort} from '../../../rsi-dsh-cordis/src/runtime/cohort.mjs';
import {SessionFacade} from '../../src/session/session.mjs';
import {factObserver, restoreMapping} from '../../src/history/history.mjs';
import {compactionLanguage,pluginCheckpoint} from '../../src/history/compaction-history.mjs';

const root = process.env.RSI_DSH_COHORT;
test('plugin replay resolves native coordinates without reading the unselected tail', {skip:!root}, async () => {
  const cohort = await loadCohort(root);
  const api = {...await cohort.import('@deepseek-ai/dsh-session'), ...await cohort.subpath('@deepseek-ai/dsh-session','surface'),
    ...await cohort.import('@deepseek-ai/dsh-util-values')};
  const llm = compactionLanguage(await cohort.import('@deepseek-ai/dsh-llm'), (name,path) => cohort.subpath(name,path));
  let managers = 0;
  api.SurfaceManager = class extends api.SurfaceManager {
    constructor(...args) { super(...args); managers++; }
  };
  const session = new SessionFacade({},api,{header:{version:4,id:'region-tail',createdAt:1,isSeeded:false}},false);
  session.begin();
  const add = (type,data) => session.adoptObserved({seq:session.seq,time:1,type,data,surfaceOp:'append'});
  const content = [{type:'text',text:'message'}];
  add('system/message',{turn:0,step:0,message:{id:'system',role:'system',source:{kind:'system-prompt'},content}});
  add('user/message',{id:'kept',role:'user',source:{kind:'user'},content});
  add('tool/result',{turn:1,step:1,rsi:{syntheticToolResult:true},message:{
    id:'synthetic',role:'tool',toolCallId:'call',source:{kind:'tool',callId:'call'},content,isError:true}});
  const selected = add('user/message',{id:'selected',role:'user',source:{kind:'user'},content});
  for(let i=0;i<128;i++)add('user/message',{id:'tail-'+i,role:'user',source:{kind:'user'},content});
  session.end();
  const before = [...session.surface.nodes];
  const batch = session.branch();
  batch.begin();
  const priorManagers = managers;
  let tailReads = 0;
  const observed = new Proxy(batch,{get(target,key){
    if(key==='eventAt')return seq=>{
      if(seq>selected.seq && seq<before.length)tailReads++;
      return target.eventAt(seq);
    };
    const value=Reflect.get(target,key,target);
    return typeof value==='function'?value.bind(target):value;
  }});
  await pluginCheckpoint(observed,{turn:1},{effect_id:'region',timestamp_ms:2,checkpoint:{
    start:1,end:1,plugin:'template',message:{role:'user',content:[{type:'text',content:{text:'message'}}]},
    presentation:{shadowedTokenCount:9}
  }},llm);
  batch.end();
  assert.equal(managers,priorManagers,'a checkpoint at the committed cut can reuse the existing surface');
  assert.deepEqual(session.surface.nodes,before);
  const previous = session.branch();
  const projected = [...batch.surfaceNodes];
  assert.notDeepEqual(projected,before);
  session.prepareBranch(batch)();
  assert.deepEqual(session.surface.nodes,projected);
  assert.deepEqual(previous.surfaceNodes,before);
  assert.deepEqual(session.lastEvent('compaction/summary').data.shadowedSeqs,[selected.seq]);
  assert.deepEqual(session.lastEvent('compaction/summary').data.summary,content);
  assert.deepEqual(session.lastEvent('user/message').data.content,content);
  assert.deepEqual(session.surface.nodes.slice(4),before.slice(4));
  assert.equal(tailReads,0);
});
test('native install retains protected gaps, completed command links and cold projection', {skip:!root}, async () => {
  const cohort = await loadCohort(root);
  const api = {...await cohort.import('@deepseek-ai/dsh-session'), ...await cohort.subpath('@deepseek-ai/dsh-session','surface'),
    ...await cohort.import('@deepseek-ai/dsh-util-values')};
  const llm = compactionLanguage(await cohort.import('@deepseek-ai/dsh-llm'), (name,path) => cohort.subpath(name,path));
  const header = {version:4,id:'native-compact',createdAt:1,isSeeded:false};
  let session = new SessionFacade({},api,{header},false);
  session.begin();
  const add = (type,data,extra) => session.adoptObserved({type,data,seq:session.seq,time:1,...extra});
  add('turn/start',{turn:1,rsi:{session:header.id,turn:'t',fact:1}});
  for (const id of ['leading','old','protected','old-again','recent']) {
    add('user/message',{id,role:'user',source:{kind:'user'},content:[{type:'text',text:id}]},{surfaceOp:'append'});
  }
  add('turn/end',{turn:1,reason:{kind:'completed'}});
  session.end();
  let mapping = restoreMapping();
  const facts = new Map();
  const read = seq => facts.get(seq);
  const replay = async (id, stage, content={}) => {
    const seq = facts.size + 1;
    const fact = {type:'manual_compaction',seq,timestamp_ms:seq,effect_id:id,command_id:'command-'+id,event:{stage,...content}};
    facts.set(seq, fact);
    session.begin();
    try {await factObserver(session,mapping,read,llm)(fact);mapping.factCursor=seq;}
    finally {session.end();}
    mapping = restoreMapping(JSON.parse(JSON.stringify(mapping)));
    session = new SessionFacade({},api,{header,events:session.snapshotEvents()},false);
  };
  const plan = (selections,prior=null) => ({selections:selections.map(first=>({session:header.id,turn:'t',first,count:1})),
    prior,trigger:{kind:'manual'},maximum_output_tokens:100});
  const prepare = (effect,selections,prior) => replay(effect,'prepared',{plan:plan(selections,prior),
    snapshot:{deployment_id:'provider',model:'model'}});
  const settle = effect => replay(effect,'settled',{attempt:{retain_context:true,events:[
    [0,{type:'content_started',index:0,content:{type:'text'}}],
    [1,{type:'content_delta',index:0,delta:{type:'text',value:effect}}],
    [2,{type:'content_finished',index:0}],[3,{type:'finished',reason:'stop',replay:null}]]}});
  const ids = () => session.deriveMessages().map(message=>message.id);
  await prepare('first',[1,3]);
  await replay('first','started');
  await settle('first');
  assert.deepEqual(ids(),['leading','old','protected','old-again','recent']);
  await replay('first','installed');
  assert.deepEqual(ids(),['rsi:checkpoint:head:first','leading','protected','recent']);
  const summary = session.lastEvent('compaction/summary');
  assert.deepEqual(summary.data.shadowedSeqs.map(seq=>session.eventAt(seq).data.id),['old','old-again']);
  assert.equal(summary.data.sourceCommandId,'command-first');
  assert.deepEqual(session.snapshotEvents().filter(e=>e.surfaceOp==='append').map(e=>e.data.id),
    ['leading','old','protected','old-again','recent']);
  await prepare('second',[1],{effect:'first'});
  await replay('second','started');
  await settle('second');
  await replay('second','installed');
  assert.deepEqual(ids(),['rsi:checkpoint:head:second','leading','recent']);
  assert.equal(mapping.compaction,undefined);
});
