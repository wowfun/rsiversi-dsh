import assert from 'node:assert/strict';
import {test} from 'node:test';
import {requestBodies,resolveBody,INLINE_BODY_BYTES,BODY_FRAGMENT_BYTES} from '../../src/request-body.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {agentOperations} from '../../src/agent/extension/operations.mjs';

test('native sized input round trips without a frame-sized business ceiling',async()=>{
  const bodies=requestBodies(8*1024*1024),identity={request:'caller',session_id:'session',message_id:'message'};
  for(const text of ['small','界🚀\n\t"\\'.repeat(100_000),'x'.repeat(1024*1024)]) {
    const value={content:[{kind:'text',text}]};let descriptor;
    await bodies.send(value,identity,undefined,async body=>{
      descriptor=body;
      assert.deepEqual(await resolveBody(body,8*1024*1024,(token,offset)=>bodies.read({...identity,token,offset})),value);
    });
    if(descriptor.kind==='paged')assert.throws(()=>bodies.read({...identity,token:descriptor.token,offset:0}),/unavailable/);
  }
});

test('retained bodies enforce identity, two-body capacity and cancellation',async()=>{
  const bodies=requestBodies(4*1024*1024),identity={session_id:'s',operation_id:'one'},stop=new AbortController();
  const gate=Promise.withResolvers(),seen=[];
  const value={text:'x'.repeat(INLINE_BODY_BYTES)};
  const first=bodies.send(value,identity,stop.signal,async body=>{seen.push(body);return gate.promise;});
  const second=bodies.send(value,{...identity,operation_id:'two'},undefined,async body=>{seen.push(body);return gate.promise;});
  await assert.rejects(bodies.send(value,identity,undefined,()=>assert.fail()),/capacity/);
  await bodies.send({small:true},identity,undefined,body=>assert.equal(body.kind,'inline'));
  assert.throws(()=>bodies.read({...identity,operation_id:'wrong',token:seen[0].token,offset:0}),/unavailable/);
  stop.abort();assert.throws(()=>bodies.read({...identity,token:seen[0].token,offset:0}),{name:'AbortError'});
  gate.resolve();await Promise.all([first,second]);
  await bodies.send(value,identity,undefined,()=>null);
});

test('Application submission retains all native input fields through the actual adapter',async()=>{
  const content=[{kind:'text',text:'\n'.repeat(1024*1024)}],submitted=[];
  let sessions;
  sessions=applicationSessions(async(method,args)=>{
    assert.equal(method,'application.submit');
    const body=await resolveBody(args.body,8*1024*1024,(token,offset)=>sessions.readSubmission({request:args.request,session_id:args.session_id,message_id:args.message_id,token,offset}));
    submitted.push(body);
    return {session_id:args.session_id,message_id:args.message_id,accepted_control_seq:1};
  },{owner:'owner'});
  try {
    await sessions.runOwned(()=>sessions.submit('s',{message_id:'m',delivery:'next_turn',content,attribution:null}));
    assert.deepEqual(submitted,[{delivery:'next_turn',content,attribution:null}]);
  }finally{await sessions.close();}
});

test('Tool code executes only after complete argument reconstruction',async()=>{
  const bodies=requestBodies(4*1024*1024),identity={session_id:'s',operation_id:'op'},calls=[];
  const args={text:'界'.repeat(1024*1024)};
  const bridge={...agentOperations({request:async(method,payload)=>{assert.equal(method,'agent.request-body.read');return bodies.read(payload);}}),
    async tool(session,operation,name,value){calls.push({session,operation,name,value});return {token:'a'.repeat(64),payload:{inputs:[],expectedRevision:0,suffix:[],checkpoint:null,result:{value:null,content:[],isError:false,contexts:[]}}};},
    retainToolResult(_session,_operation,_token,result){return {kind:'inline',value:result};},
    async abandon(){assert.fail('argument rejection must not abandon an operation that never executed');}};
  await bodies.send(args,identity,undefined,async body=>{
    assert.equal((await bridge.agentTool({...identity,name:'read',arguments:body})).kind,'staged');
  });
  assert.deepEqual(calls,[{session:'s',operation:'op',name:'read',value:args}]);
  const refused=await bridge.agentTool({...identity,name:'read',arguments:{kind:'paged',token:'b'.repeat(32),bytes:4*1024*1024+1}});
  assert.equal(refused.kind,'rejected');assert.equal(calls.length,1);
});

test('malformed and oversized body descriptors fail before any read',async()=>{
  for(const bytes of [-1,0,INLINE_BODY_BYTES,8*1024*1024+1]) {
    await assert.rejects(resolveBody({kind:'paged',bytes,token:'a'.repeat(32)},8*1024*1024,()=>assert.fail()),/Invalid request body/);
  }
  await assert.rejects(resolveBody({kind:'paged',bytes:INLINE_BODY_BYTES+1,token:'a'.repeat(32)},8*1024*1024,()=>({offset:1,data:'eA=='})),/fragment/);
  const oversized=Buffer.alloc(BODY_FRAGMENT_BYTES+1).toString('base64');
  await assert.rejects(resolveBody({kind:'paged',bytes:2*BODY_FRAGMENT_BYTES,token:'a'.repeat(32)},8*1024*1024,()=>({offset:0,data:oversized})),/fragment/);
});

test('Application body accepts its exact 8MiB JSON limit and rejects the next byte before dispatch',async()=>{
  const maximum=8*1024*1024,bodies=requestBodies(maximum),identity={request:'r',session_id:'s',message_id:'m'};
  const value={text:'x'.repeat(maximum-11)};
  assert.equal(Buffer.byteLength(JSON.stringify(value)),maximum);
  await bodies.send(value,identity,undefined,async body=>{
    assert.equal(body.bytes,maximum);
    let reads=0;
    assert.deepEqual(await resolveBody(body,maximum,(token,offset)=>{
      reads++;const part=bodies.read({...identity,token,offset});
      assert.ok(Buffer.byteLength(part.data,'base64')<=BODY_FRAGMENT_BYTES);
      return part;
    }),value);
    assert.equal(reads,maximum/BODY_FRAGMENT_BYTES);
  });
  await assert.rejects(bodies.send({text:value.text+'x'},identity,undefined,()=>assert.fail('oversize body dispatched')),/limit/);
});
