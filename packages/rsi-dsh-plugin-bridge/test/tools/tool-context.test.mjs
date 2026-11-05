import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBridge} from '../../src/index.mjs';
import {loadCohort} from '../../../rsi-dsh-cordis/src/runtime/cohort.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('the original tool and pre-step hooks share one native message without re-emitting it',
  {skip:!root},async t=>{
    const original=await loadCohort(root),plugin='@test/tool-context';
    const guidance={role:'user',id:'hook-message',source:{kind:'tool-hook',hook:'PostToolUse'},
      content:[{type:'text',text:'first block'},{type:'text',text:'second block'}]};
    const seen=[];
    const cohort={...original,import:id=>id===plugin?{default(ctx){
      ctx.on('agent/pre-step',async(args,next)=>{seen.push(structuredClone(args.messages));return next();});
      ctx.on('tools/post-execute',async(_exec,_result,next)=>({...await next(),additionalContexts:[guidance]}));
    }}:original.import(id)};
    const facts=[];
    const add=(type,fields)=>facts.push({seq:facts.length+1,timestamp_ms:Date.now(),turn_id:'turn',type,...fields});
    const reads=[];
    const request=async(method,{session_id,operation_id,after_seq,through_seq,offset})=>{
      assert.equal(method,'agent.history.read');assert.equal(session_id,'parent');assert.ok(operation_id);
      assert.equal(offset,0);
      const page=facts.slice(after_seq,through_seq),json=JSON.stringify(page),bytes=Buffer.byteLength(json);
      reads.push([operation_id,after_seq,through_seq]);
      return {through_seq,offset,next_offset:bytes,total_bytes:bytes,json};
    };
    const open=()=>createBridge({request,cohortRoot:root,cohortLoader:async()=>cohort,configuration:{format:1,plugins:[plugin]}});
    let bridge=await open();t.after(()=>bridge.close());
    const header=id=>({version:4,id,createdAt:1,isSeeded:false});
    await bridge.load({header:header('parent'),events:[],revision:0});
    const tool=operation_id=>bridge.agentTool({session_id:'parent',operation_id,name:'todo_write',
      arguments:{todos:[{content:'research',status:'completed'}]}});
    const first=await tool('rejected-tool');
    assert.equal(first.kind,'staged',first.diagnostic);
    await bridge.receipt('parent','rejected-tool',first.token,'rejected',0);
    assert.equal(bridge.canonical('parent').revision,0);
    const call=await tool('effect');
    assert.equal(call.kind,'staged',call.diagnostic);
    assert.deepEqual(call.result.additional_contexts,[{id:guidance.id,source:guidance.source,text:['first block','second block']}]);
    assert.ok(!Object.hasOwn(call.checkpoint,'pendingContexts'));
    await bridge.receipt('parent','effect',call.token,'committed',1);
    await bridge.close();bridge=await open();
    await bridge.loadAgent({session_id:'parent',created_at:1,revision:1,events:call.events,checkpoint:call.checkpoint});
    const prepare=(operation_id,step_id)=>bridge.agentBeforeStep({session_id:'parent',operation_id,turn_id:'turn',
      step_id,fact_horizon:facts.length,tools:[],model_selection:{model:{deployment:'fixture',model:'test'}}});
    const check=async(id,stepId,expected,outcome,revision)=>{
      const step=await prepare(id,stepId);
      assert.equal(step.kind,'staged',step.diagnostic);
      assert.deepEqual(seen.at(-1),expected);
      assert.ok(!step.decision.messages.some(row=>row.message?.content.some(block=>block.text==='first block')));
      await bridge.receipt('parent',id,step.token,outcome,revision);
    };
    add('step_started',{step_id:'one'});
    const [message]=call.result.additional_contexts;
    add('input_message_claimed',{step_id:'one',source:{type:'plugin_context',contribution_id:'rsi.tools.context',
      tool:{session:'parent',effect:'effect',ordinal:0,message_id:message.id,source:message.source}},
      content:message.text.map(text=>({type:'text',text}))});
    await check('failed','one',[guidance],'rejected',1);
    await check('retry','one',[guidance],'committed',2);
    add('step_inputs_prepared',{step_id:'one',decision:{kind:'enter',messages:[{kind:'claimed',claim:{fact_seq:2,ordinal:0}}]}});
    add('step_ended',{step_id:'one'});
    add('step_started',{step_id:'two'});
    await check('next','two',[],'committed',3);
    assert.deepEqual(reads.filter(([id])=>id==='next'),[['next',2,5]],'three native facts use one process round trip');
    const batch=Array.from({length:90},(_,ordinal)=>({session:'parent',effect:'batch',ordinal,
      message:{...message,id:'context-'+ordinal}}));
    add('tool_contexts_claimed',{step_id:'two',messages:batch});
    await check('batch','two',batch.map(({message})=>({...guidance,id:message.id})),'committed',4);
  });
