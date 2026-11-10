import assert from 'node:assert/strict';

const timePrefix='Current time sampled before this model request: ';
const context=text=>({role:'developer',content:[{type:'text',content:{text}}]});
const isTime=message=>message.role==='developer'&&message.content?.length===1&&
  message.content[0].type==='text'&&message.content[0].content?.text?.startsWith(timePrefix);

/** Evidence for a fixed catalog and straight-line native search fixture. */
export function catalogEvidence(facts,{refreshIntervalMs=600_000}={}) {
  const historical=facts.filter(row=>row.type==='input_message_claimed'&&
    (row.source?.source==='available-agents'||row.source?.contribution_id==='rsi.available-agents'));
  assert.equal(historical.length,0,'Current catalog must not append historical context');
  const prepared=facts.filter(row=>row.type==='step_prepared');
  assert.ok(prepared.length);
  const bySeq=new Map(facts.map(row=>[row.seq,row])),requests=[],times=[];
  const timeContext={inputs:0,rollbacks:0,intervals:0};
  let current={mode:"append_to_header",sections:[]},previousTime,baseline;
  for(const row of facts){
    if(row.type==='step_started'||row.type==='step_ended')current={mode:"append_to_header",sections:[]};
    if(row.type==='step_prepared'){
      if(row.prompt!==undefined){assert.notDeepEqual(current,row.prompt,'Do not persist an unchanged prompt');current=row.prompt;}
      assert.equal(current.sections.filter(entry=>entry.producer==='rsi.available-agents').length,1);
    }
    if(row.type==='input_message_claimed'&&row.source?.contribution_id==='rsi.time-context'){
      assert.equal(row.content.length,1);assert.equal(row.content[0].type,'text');
      const text=row.content[0].text,match=/^Current time sampled before this model request: (.+) \(UTC\)\.$/.exec(text);
      assert.ok(match,'Recognized native time context');
      const sample=Date.parse(match[1]);assert.ok(Number.isFinite(sample));
      if(previousTime!==undefined){
        if(sample<previousTime)timeContext.rollbacks++;
        else {assert.ok(sample-previousTime>=refreshIntervalMs,'Time input repeated within its refresh interval');timeContext.intervals++;}
      }
      previousTime=row.timestamp_ms;timeContext.inputs++;times.push(context(text));
    }
    if(row.type!=='model_intent')continue;
    const part=row.evidence.system;
    const text=part.kind==='inline'?part.text:bySeq.get(part.seq).evidence[part.section].text;
    const copies=(text.match(/Available subagents/g)??[]).length;
    assert.equal(copies,1,'Only the current catalog belongs in system evidence');
    const messages=JSON.parse(text),visibleTimes=messages.filter(isTime),stable=messages.filter(message=>!isTime(message));
    assert.deepEqual(visibleTimes,times,'Request time context must contain each entered sample exactly once in order');
    if(baseline===undefined)baseline=stable;
    else assert.deepEqual(stable,baseline,'Unchanged catalog and other instructions must remain stable');
    requests.push({seq:row.seq,kind:part.kind,inlineBytes:Buffer.byteLength(part.text??''),resolvedBytes:Buffer.byteLength(text),copies});
  }
  assert.ok(requests.length);assert.ok(timeContext.inputs,'The native fixture must exercise time context');
  return {historicalInputs:historical.length,prepared:prepared.length,
    modelRequests:requests.length,inlineRequests:requests.filter(row=>row.kind==='inline').length,
    inlineBytes:requests.reduce((sum,row)=>sum+row.inlineBytes,0),timeContext,requests};
}
