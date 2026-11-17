import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sessionMirrors} from '../../src/agent/extension/session-mirrors.mjs';
import {stagedMutations} from '../../src/agent/extension/mutations.mjs';
import {TOOL_RESULT_BYTES} from '../../src/agent/extension/settlement.mjs';

test('one mirror budget admits Tool output before execution and releases it at receipt or abandonment',async()=>{
  const limit=256*1024*1024, lifetime=new AbortController();
  const session={encodedBytes:limit-TOOL_RESULT_BYTES+1,seq:0,begin(){},end(){},snapshotEvents(){return []}};
  const record={session,canonical:{revision:0,pendingIntent:null},mapping:{},lane:{async acquire(){return ()=>{}}},
    executing:new Set(),receipts:new Map(),epoch:0};
  const records=new Map([['s',record]]),ctx={sessionProjections:{snapshot(){return {}}}},intents={capture(){return null}};
  const mirrors=sessionMirrors({ctx,records,intents,signal:lifetime.signal});
  const mutations=stagedMutations({records,get:()=>record,restore(){},intents,ctx,lifetime:lifetime.signal,reserveOutput:mirrors.reserveOutput});
  let effects=0;
  const invoke=async(r,operation)=>{mutations.reserveToolOutput(r,operation);effects++;return {}};
  await assert.rejects(mutations.stage('s','refused',invoke),/output capacity/);
  assert.equal(effects,0);
  session.encodedBytes=0;
  const staged=await mutations.stage('s','first',invoke);
  assert.equal(effects,1);
  const other=mirrors.reserveOutput();
  other.resize(limit-TOOL_RESULT_BYTES);
  assert.throws(()=>other.resize(limit-TOOL_RESULT_BYTES+1),/output capacity/);
  await mutations.receipts.receipt('s','first',staged.token,'committed',1);
  other.resize(limit);
  assert.throws(()=>mirrors.protocol.forks.begin({operation_id:'fork',session_id:'s',created_at:0,count:0,checkpoint:{},after_seq:0,through_seq:0,include_inherited:true}),/mirror capacity/);
  other.release();
  const next=await mutations.stage('s','second',invoke);
  await mutations.receipts.abandon('s','second');
  assert.throws(()=>mutations.receipts.readOperationBody({session_id:'s',operation_id:'second',token:next.token,part:'result'}),/identity/);
  other.resize(limit);other.release();
  assert.equal(effects,2);
});

test('active output reservations are visible to concurrent load admission',()=>{
  const mirrors=sessionMirrors({ctx:{},records:new Map(),signal:new AbortController().signal});
  const reservation=mirrors.reserveOutput();reservation.resize(256*1024*1024);
  const input={session_id:'load',created_at:0,revision:0,count:1,reload:true};
  mirrors.protocol.beginAgentLoad(input);
  assert.throws(()=>mirrors.protocol.appendAgentLoad({session_id:'load',offset:0,events:[{}]}),/capacity/);
  reservation.release();
  mirrors.protocol.appendAgentLoad({session_id:'load',offset:0,events:[{}]});
  mirrors.protocol.abortAgentLoad({session_id:'load'});
});
