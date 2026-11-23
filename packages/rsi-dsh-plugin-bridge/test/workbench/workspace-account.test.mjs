import assert from 'node:assert/strict';
import {test} from 'node:test';
import {workspaceController} from '../../src/workbench/workspace-controller.mjs';

class RemoteError extends Error {
  constructor(code,message,data){super(message);Object.assign(this,{code,data});}
}
const workspaceId='a'.repeat(64);

test('creating a new workspace returns its committed empty account without reading other accounts', async () => {
  const signal = new AbortController().signal;
  const record = {id:workspaceId, path:'/work/new', title:null, created:1234};
  const calls = [];
  const scope = {async workspace(input, received) {
    calls.push(input);
    assert.equal(received, signal);
    if (input.type === 'create') return {record, created:true};
    throw Error('unrelated account unavailable');
  }};
  const Controller = workspaceController(class {}, scope, RemoteError);
  const result = await new Controller().create({path:record.path}, signal);
  const time = new Date(record.created).toISOString();
  assert.deepEqual(result, {created:true, workspace:{workspaceId, path:record.path,
    title:'new', createdAt:time, updatedAt:time, sessionIds:[]}});
  assert.deepEqual(calls, [{type:'create', path:record.path}]);
});

test('reusing a registered drive root keeps its title and current members', async () => {
  const record = {id:workspaceId, path:'C:\\', created:1};
  const scope = {
    drafts: async () => [],
    async workspace(input) {
      switch (input.type) {
      case 'create': return {record, created:false};
      case 'list': return {items:[record], order:[workspaceId]};
      case 'membership': return {groups:[workspaceId], members:[
        {session:'existing', group:0, account_position:0, last_activity_ms:'4'},
      ]};
      default: throw Error('unexpected operation');
      }
    },
  };
  const Controller = workspaceController(class {}, scope, RemoteError);
  const result = await new Controller().create({path:record.path}, new AbortController().signal);
  assert.equal(result.created, false);
  assert.equal(result.workspace.title, record.path);
  assert.deepEqual(result.workspace.sessionIds, ['existing']);
});

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

test('workspace feeds preserve detached pins and exclude promoted drafts without rewriting native rows',async()=>{
  const other='b'.repeat(64);
  const members=Object.freeze([
    {group:0,session:'a',account_position:1,last_activity_ms:'3'},
    {group:1,session:'detached',account_position:0,last_activity_ms:'20',pinned:true},
    {group:0,session:'z',account_position:0,last_activity_ms:'4'},
  ]);
  const scope={workspaceChange:()=>new AbortController().signal,
    drafts:async()=>[{id:'detached',workspace:other,updatedAt:1},{id:'private',workspace:workspaceId,updatedAt:6}],
    workspace:async input=>input.type==='list'
      ? {items:[{id:workspaceId,path:'/one',created:1},{id:other,path:'/two',created:1}],order:[workspaceId,other]}
      : {groups:[workspaceId,null],members}};
  const Controller=workspaceController(class {},scope,RemoteError);
  const frames=new Controller().follow(new AbortController().signal);
  const {value:{value}}=await frames.next();
  assert.deepEqual(value.items.map(row=>row.sessionIds),[['private','z','a'],[]]);
  assert.deepEqual(value.pinnedSessionIds,['detached']);
  await frames.return();
});

test('a draft published between the two workspace reads keeps its durable position', async () => {
  let published = false;
  const old = {session:'older', group:0, account_position:0, last_activity_ms:'2'};
  const scope = {
    workspaceChange: () => new AbortController().signal,
    async drafts() {
      const rows = published ? [] : [{id:'promoting', workspace:workspaceId, updatedAt:3}];
      published = true;
      return rows;
    },
    async workspace({type}) {
      if (type === 'list') return {items:[{id:workspaceId,path:'/project',created:1}], order:[workspaceId]};
      const members = published ? [old,{session:'promoting',group:0,account_position:1,last_activity_ms:'3'}] : [old];
      published = true;
      return {groups:[workspaceId], members};
    },
  };
  const Controller = workspaceController(class {}, scope, RemoteError);
  const feed = new Controller().follow(new AbortController().signal);
  try {
    assert.deepEqual((await feed.next()).value.value.items[0].sessionIds, ['older','promoting']);
  } finally {
    await feed.return();
  }
});
