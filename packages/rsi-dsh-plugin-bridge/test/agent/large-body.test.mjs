import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {createBridge} from '../../src/index.mjs';
import {loadCohort} from '../../../rsi-dsh-cordis/src/runtime/cohort.mjs';
import {requestBodies,resolveBody} from '../../src/request-body.mjs';
const cohortRoot=process.env.RSI_DSH_COHORT;
test('original Tool execution publishes a native-sized argument history through staged event pages',{skip:!cohortRoot},async()=>{
const original=await loadCohort(cohortRoot),tools=await original.import('@deepseek-ai/dsh-tools');
let executions=0;
const plugin={name:'body-probe',inject:['tools'],apply(ctx){ctx.effect(()=>ctx.tools.register(tools.defineTool({name:'body_probe',description:'Echo original tool input',parameters:{text:{type:'string'}},output:{schema:{type:'string'},render:(_,text)=>[{type:'text',text}]},execute(args){executions++;return args.text;}})));}};
const args={text:'界'.repeat(1024*1024)};
const bodies=requestBodies(4*1024*1024);
const inline=value=>{const text=JSON.stringify(value);return {kind:'inline',text,sha256:createHash('sha256').update(text).digest('hex')}};
const evidence={availability:'available',configuration:inline({prepared:{deployment:'fixture',model:'test',language_settings:{}},settings:{stop:[]},response_format:{type:'text'},extensions:[]}),tools:inline({definitions:[],hosted:[],choice:{type:'auto'}}),system:inline([])};
const facts=[{type:'turn_accepted',turn_id:'turn',text:'test'},{type:'step_started',turn_id:'turn',step_id:'step'},
 {type:'model_intent',effect_id:'model',purpose:{kind:'conversation'},snapshot:{deployment_id:'fixture',model:'test',language_settings:{}},evidence},{type:'model_started',effect_id:'model'},
 {type:'model_attempt_settled',effect_id:'model',purpose:'conversation',attempt:{retain_context:true,events:[[0,{type:'content_started',index:0,content:{type:'tool_call',id:'call',name:'body_probe',kind:'function'}}],[1,{type:'content_delta',index:0,delta:{type:'tool_arguments',value:JSON.stringify(args)}}],[2,{type:'content_finished',index:0}],[3,{type:'finished',reason:'tool_calls',replay:null}]]}},
 {type:'tool_intent',effect_id:'effect',origin:{kind:'model',effect_id:'model'},identity:{call_id:'call'},name:'body_probe',arguments:args},
 {type:'tool_started',effect_id:'effect',identity:{call_id:'call'}}].map((f,i)=>({...f,seq:i+1,timestamp_ms:i+1}));
const bridge=await createBridge({cohortRoot,configuration:{format:1,plugins:['fixture']},cohortLoader:async()=>({...original,import:name=>name==='fixture'?Promise.resolve(plugin):original.import(name)}),request:async(method,p)=>{
 if(method==='agent.request-body.read')return bodies.read(p);
 if(method!=='agent.history.read')throw Error(method);
 const all=Buffer.from(JSON.stringify([facts[p.after_seq]]));let end=Math.min(all.length,p.offset+128*1024);while(end<all.length&&(all[end]&0xc0)===0x80)end--;
 return {through_seq:p.after_seq+1,offset:p.offset,next_offset:end,total_bytes:all.length,json:all.subarray(p.offset,end).toString('utf8')};
}});
try{await bridge.load({header:{version:4,id:'s',createdAt:0,isSeeded:false},events:[],revision:0});const result=await bodies.send(args,{session_id:'s',operation_id:'effect'},undefined,body=>bridge.agentTool({session_id:'s',operation_id:'effect',name:'body_probe',arguments:body,fact_horizon:facts.length}));assert.equal(result.kind,'staged',result.diagnostic);assert.equal(executions,1);
const output=await resolveBody(result.result,17*1024*1024,(_,body_offset)=>bridge.readOperationBody({session_id:'s',operation_id:'effect',token:result.token,part:'result',body_offset}));
assert.equal(result.result.kind,'paged');assert.equal(output.value,args.text);
assert.ok(result.events.count>0);
const events=[];
while(events.length<result.events.count){const identity={session_id:'s',operation_id:'effect',token:result.token,part:'events',offset:events.length};
 const body=bridge.readOperationBody(identity);events.push(...await resolveBody(body,64*1024*1024,(_,body_offset)=>bridge.readOperationBody({...identity,body_offset})));}
assert.ok(events.some(event=>event.type==='tool/call'&&event.data.arguments===JSON.stringify(args)));
const replay=await resolveBody(result.result,17*1024*1024,(_,body_offset)=>bridge.readOperationBody({session_id:'s',operation_id:'effect',token:result.token,part:'result',body_offset}));
assert.deepEqual(replay,output);assert.equal(executions,1);
await bridge.receipt('s','effect',result.token,'committed',1);
assert.equal(executions,1);assert.deepEqual(bridge.canonical('s').events,events);
assert.throws(()=>bridge.readOperationBody({session_id:'s',operation_id:'effect',token:result.token,part:'events',offset:0}),/identity/);
}finally{await bridge.close();}

});
