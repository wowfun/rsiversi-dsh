import assert from 'node:assert/strict';
import {test} from 'node:test';
import {catalogEvidence} from '../../../../fixtures/session-search/native-evidence.mjs';

const base=1_800_000_000_000;
const timeText=sample=>'Current time sampled before this model request: '+new Date(sample).toISOString()+' (UTC).';
const system=text=>({role:'system',content:[{type:'text',content:{text}}]});
const context=text=>({role:'developer',content:[{type:'text',content:{text}}]});
function fixture(samples){
  const facts=[{type:'step_prepared',prompt:{mode:'assembled',sections:[{producer:'rsi.available-agents',text:'Available subagents: none'}]}}];
  const visible=[];
  for(const sample of samples){
    const text=timeText(sample);
    facts.push({type:'input_message_claimed',timestamp_ms:sample,source:{type:'plugin_context',contribution_id:'rsi.time-context'},content:[{type:'text',text}]});
    visible.push(context(text));
    facts.push({type:'model_intent',evidence:{system:{kind:'inline',text:JSON.stringify([system('Available subagents: none'),...visible])}}});
  }
  facts.forEach((fact,i)=>{fact.seq=i+1;});return facts;
}

test('fixed-catalog acceptance permits backward time and the exact refresh boundary',()=>{
  for(const [samples,expected] of [[[base],{inputs:1,rollbacks:0,intervals:0}],
    [[base,base-18],{inputs:2,rollbacks:1,intervals:0}],
    [[base,base+600_000],{inputs:2,rollbacks:0,intervals:1}]]){
    assert.deepEqual(catalogEvidence(fixture(samples)).timeContext,expected);
  }
});

test('native time refresh uses the previous Fact timestamp and resolves reference evidence',()=>{
  const facts=fixture([base,base+5]);facts[1].timestamp_ms=base+10;
  facts.push({seq:facts.length+1,type:'model_intent',evidence:{system:{kind:'reference',seq:facts.at(-1).seq,section:'system'}}});
  const result=catalogEvidence(facts);
  assert.deepEqual(result.timeContext,{inputs:2,rollbacks:1,intervals:0});
  assert.equal(result.inlineRequests,2);assert.equal(result.requests.length,3);
});

test('acceptance still rejects redundant time inputs, lost context and changed catalog',()=>{
  assert.throws(()=>catalogEvidence(fixture([base,base+1])),/refresh interval/);
  for(const kind of ['duplicate','missing','catalog']){
    const facts=fixture([base,base-18]),row=facts.at(-1),messages=JSON.parse(row.evidence.system.text);
    if(kind==='duplicate')messages.push(messages.at(-1));
    if(kind==='missing')messages.splice(1,1);
    if(kind==='catalog')messages[0]=system('Available subagents: changed');
    row.evidence.system.text=JSON.stringify(messages);
    assert.throws(()=>catalogEvidence(facts),kind==='catalog'?/catalog/:/time context/);
  }
});
