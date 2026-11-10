import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadCohort} from '../../../rsi-dsh-cordis/src/runtime/cohort.mjs';
import {modelProjection} from '../../src/history/model-history.mjs';

const root=process.env.RSI_DSH_COHORT;
test('model block closure does not assemble unrelated blocks and preserves out-of-order closes',{skip:!root},async()=>{
  const llm=await (await loadCohort(root)).import('@deepseek-ai/dsh-llm');
  let scans=0;
  class Counted extends llm.BlockAssembler {blocks(){scans++;return super.blocks();}}
  const chunks=[],projection=modelProjection({...llm,BlockAssembler:Counted},100,item=>chunks.push(item));
  const expected=[];let time=0;
  for(let index=0;index<64;index++){
    const tool=index%3===2,type=tool?'tool_call':index%3===1?'reasoning':'text';
    projection.accept(++time,{type:'content_started',index,content:tool?{type,kind:'function',id:'call-'+index,name:'read'}:{type}});
    const value=tool?' {"path":"file-'+index+'"}':'文本🙂 '+index;
    projection.accept(++time,{type:'content_delta',index,delta:{type:tool?'tool_arguments':type,value}});
    expected.push(tool?{type:'tool-call',id:'call-'+index,name:'read',arguments:value}:{type,text:value});
  }
  for(let index=63;index>=0;index--)projection.accept(++time,{type:'content_finished',index});
  assert.equal(scans,0,'closing one block must not scan or materialize the other blocks');
  projection.accept(++time,{type:'usage',usage:{input_tokens:3,output_tokens:5}});
  projection.accept(++time,{type:'finished',reason:'tool_calls',replay:null});
  const stream=projection.stream.snapshot(),assembled=llm.assembleAssistantStream(stream,new Counted());
  const blocks=assembled.blocks();assert.deepEqual(blocks,expected);assert.equal(scans,1);
  assert.deepEqual(assembled.usage,{inputTokens:3,outputTokens:5,totalTokens:8});
  assert.deepEqual(llm.expandAssistantStream(stream),chunks);
  assert.deepEqual(chunks.filter(({chunk})=>chunk.type==='block-end').map(({chunk})=>chunk.index),Array.from({length:64},(_,i)=>63-i));
  for(const {chunk} of chunks.filter(({chunk})=>chunk.type==='block-end'))assert.equal(chunk.block,blocks[chunk.index]);
});

test('incomplete text survives interruption without fabricated closes and truncation drops tool calls',{skip:!root},async()=>{
  const llm=await (await loadCohort(root)).import('@deepseek-ai/dsh-llm');
  for(const terminal of [{type:'failed',error:{kind:'transport',safe_summary:'Disconnected'},replay:null},
    {type:'finished',reason:'max_tokens',replay:null}]){
    const projection=modelProjection(llm,100);let time=0;
    const accept=event=>projection.accept(++time,event);
    accept({type:'content_started',index:0,content:{type:'reasoning'}});
    accept({type:'content_delta',index:0,delta:{type:'reasoning',value:'thought'}});
    accept({type:'content_finished',index:0});
    accept({type:'content_started',index:1,content:{type:'text'}});
    accept({type:'content_delta',index:1,delta:{type:'text',value:'partial'}});
    accept({type:'content_started',index:2,content:{type:'tool_call',kind:'function',id:'call',name:'read'}});
    accept({type:'content_delta',index:2,delta:{type:'tool_arguments',value:'{"path":'}});
    accept(terminal);
    const stream=projection.stream.snapshot(),assembled=llm.assembleAssistantStream(stream);
    assert.deepEqual(assembled.interruptedBlocks(),[{type:'reasoning',text:'thought'},{type:'text',text:'partial'}]);
    assert.deepEqual(llm.expandAssistantStream(stream).filter(({chunk})=>chunk.type==='block-end').map(({chunk})=>chunk.index),[0]);
    if(terminal.type==='finished')assert.deepEqual(assembled.blocks(),assembled.interruptedBlocks());
    else assert.equal(assembled.finish.failure.message,'Disconnected');
  }
});
