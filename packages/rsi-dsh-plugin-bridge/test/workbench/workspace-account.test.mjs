import assert from 'node:assert/strict';
import {test} from 'node:test';
import {workspaceController} from '../../src/workbench/workspace-controller.mjs';

class RemoteError extends Error {
  constructor(code,message,data){super(message);Object.assign(this,{code,data});}
}
const workspaceId='a'.repeat(64);

test('Workspace deletion preserves the native absent result and failures',async()=>{
  const signal=new AbortController().signal,calls=[];
  let present=true,failure;
  const scope={async workspace(input,received){
    assert.equal(received,signal);calls.push(input);
    if(failure)throw failure;
    const deleted=present;present=false;return deleted;
  }};
  const Controller=workspaceController(class {},scope,RemoteError),controller=new Controller();
  assert.deepEqual(await controller.delete({workspaceId},signal),{deleted:true});
  assert.deepEqual(await controller.delete({workspaceId},signal),{deleted:false});
  assert.deepEqual(calls,[{type:'delete',id:workspaceId},{type:'delete',id:workspaceId}]);
  failure=Error('native outcome unknown');
  await assert.rejects(controller.delete({workspaceId},signal),error=>error===failure);
});
test('Workspace baseline uses native account order and moves return the updated projection',async()=>{
  const calls=[],rows=[{session:'newer',account_position:0,last_activity_ms:'2'},
    {session:'older',account_position:1,last_activity_ms:'999'}];
  const scope={drafts:async()=>[],workspaceChange:()=>new AbortController().signal,
    async workspace(input){
      calls.push(input);
      switch(input.type){
      case 'list':return {items:[{id:workspaceId,path:'/project',created:1}],order:[workspaceId],next:null};
      case 'membership':return {groups:[workspaceId],members:rows.map(row=>({...row,group:0}))};
      case 'insert_session_before':
        assert.equal(input.session,'older');assert.equal(input.before,'newer');
        rows[0].account_position=1;rows[1].account_position=0;return {status:'applied'};
      default:throw Error('unexpected operation');
      }
    }};
  const Controller=workspaceController(class {constructor(ctx){this.ctx=ctx;}},scope,RemoteError);
  const controller=new Controller({});
  const iterator=controller.follow(new AbortController().signal);
  assert.deepEqual((await iterator.next()).value.value.items[0].sessionIds,['newer','older']);
  await iterator.return();
  const result=await controller.insertSessionBefore({workspaceId,sessionId:'older',beforeSessionId:'newer'});
  assert.deepEqual(result.workspace.sessionIds,['older','newer']);
  assert.equal(result.workspace.updatedAt,new Date(999).toISOString());
  assert.equal(calls.filter(call=>call.type==='insert_session_before').length,1);
});
test('Workspace move errors retain DSH business identities',async()=>{
  let status='unknown',calls=0;
  const scope={workspace:async()=>{calls++;return {status};}};
  const Controller=workspaceController(class {},scope,RemoteError),controller=new Controller();
  await assert.rejects(controller.insertSessionBefore({workspaceId:'unknown',sessionId:'s'}),{code:'workspace/not-found'});
  assert.equal(calls,0);
  await assert.rejects(controller.insertSessionBefore({workspaceId,sessionId:'s'}),{code:'workspace/not-found'});
  status='invalid_member';
  const request={workspaceId,sessionId:'s',beforeSessionId:'other'};
  await assert.rejects(controller.insertSessionBefore(request),error=>{
    assert.equal(error.code,'workspace/move-invalid');assert.deepEqual(error.data,request);return true;
  });
});
