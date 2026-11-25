import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hostHomePicker,workspaceController} from '../../src/workbench/workspace-controller.mjs';

class RemoteError extends Error {
  constructor(code,message,data){super(message);Object.assign(this,{code,data});}
}
const workspaceId='a'.repeat(64);

test('the picker uses the operator home and retains the upstream listing, creation and cancellation',async()=>{
  const requests=[],signal=new AbortController().signal;
  const directory={entries:[],crumbs:[],truncated:false,home:'/package-cache'};
  const createDirectory=()=>{};
  class Browse {
    capability(){return {kind:'browse',createDirectory,list:async(path,received)=>{
      requests.push({path,received});return {...directory,path};
    }};}
  }
  const Picker=hostHomePicker(Browse,'/operator');
  const picker=new Picker().capability();
  assert.equal(picker.createDirectory,createDirectory);
  for(const path of [undefined,'/mounted/share']){
    const listing=await picker.list(path,signal);
    assert.deepEqual(listing,{...directory,path:path??'/operator',home:'/operator'});
    assert.equal(listing.entries,directory.entries);
  }
  assert.deepEqual(requests,[{path:'/operator',received:signal},{path:'/mounted/share',received:signal}]);
});

test('workspace commands trim names and expose only confirmed native rejections as domain errors',async()=>{
  const calls=[];
  let receipt={id:workspaceId,path:'/work',title:'Project',created:1};
  const Controller=workspaceController(class {},{async workspace(input){
    calls.push(input);
    if(receipt instanceof Error)throw receipt;
    return receipt;
  }},RemoteError);
  const controller=new Controller();
  const rename=(title,id=workspaceId)=>controller.rename({workspaceId:id,title});
  await assert.rejects(rename('  ','missing'),{code:'gateway/bad-request'});
  await assert.rejects(rename('Title','missing'),{code:'workspace/not-found',data:{workspaceId:'missing'}});
  assert.deepEqual(calls,[]);
  assert.equal((await rename(' Project  ')).workspace.title,'Project');
  assert.deepEqual(calls,[{type:'rename',id:workspaceId,title:'Project'}]);
  receipt={status:'unknown'};
  await assert.rejects(rename('Title'),{code:'workspace/not-found',data:{workspaceId}});
  receipt={status:'name_conflict'};
  await assert.rejects(rename(' Taken '),{code:'workspace/name-conflict',data:{name:'Taken'}});
  receipt={status:'invalid_title',message:'workspace name exceeds the byte bound'};
  await assert.rejects(rename('x'.repeat(257)),{code:'gateway/bad-request',data:{}});
  receipt={status:'invalid_path',message:'missing directory'};
  await assert.rejects(controller.create({path:'/absent'}),{code:'workspace/invalid-path',data:{path:'/absent'}});
  receipt=Error('commit outcome unknown');
  await assert.rejects(controller.create({path:'/work'}),error=>error===receipt);
  await assert.rejects(rename('Title'),error=>error===receipt);
});

test('creating a new workspace returns its committed empty account without reading other accounts', async () => {
  const signal = new AbortController().signal;
  const record = {id:workspaceId, path:'/work/new', title:'new', created:1234};
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
  const record = {id:workspaceId, path:'C:\\', title:'C:\\', created:1, updated:4, sessions:['existing']};
  const scope = {
    drafts: async () => [],
    async workspace(input) {
      switch (input.type) {
      case 'create': return {record, created:false};
      default: throw Error('unexpected operation');
      }
    },
  };
  const Controller = workspaceController(class {}, scope, RemoteError);
  const result = await new Controller().create({path:record.path}, new AbortController().signal);
  assert.equal(result.created, false);
  assert.equal(result.workspace.title, record.path);
  assert.deepEqual(result.workspace.sessionIds, ['existing']);
  assert.equal(result.workspace.updatedAt, new Date(4).toISOString());
});

test('Workspace deletion identifies missing and retired registrations and preserves Host failures',async()=>{
  const signal=new AbortController().signal,calls=[];
  let present=true,failure;
  const scope={async workspace(input,received){
    assert.equal(received,signal);calls.push(input);
    if(failure)throw failure;
    const deleted=present;present=false;return deleted;
  }};
  const Controller=workspaceController(class {},scope,RemoteError),controller=new Controller();
  assert.deepEqual(await controller.delete({workspaceId},signal),{deleted:true});
  for (const id of [workspaceId, 'unknown-workspace']) {
    await assert.rejects(controller.delete({workspaceId:id},signal), error => {
      assert.equal(error.code,'workspace/not-found');
      assert.equal(error.message,`Workspace "${id}" not found`);
      assert.deepEqual(error.data,{workspaceId:id});
      return true;
    });
  }
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
      case 'list':return {items:[{id:workspaceId,path:'/project',title:'project',created:1}],order:[workspaceId],next:null};
      case 'membership':return {members:rows.map(row=>({...row,workspace:workspaceId})),next:null};
      case 'insert_session_before':
        assert.equal(input.session,'older');assert.equal(input.before,'newer');
        rows[0].account_position=1;rows[1].account_position=0;
        return {status:'applied',record:{id:workspaceId,path:'/project',title:'project',created:1,updated:999,sessions:['older','newer']}};
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
test('Workspace followers send changed rows, order and navigation sets and can restore withdrawn visibility',async()=>{
  let changed=new AbortController(),allowed=true;
  const records=[{id:'one',path:'/one',title:'One',created:1}],members=[];
  const scope={workspaceChange:()=>changed.signal,drafts:async()=>[],observeOwned:run=>run(),
    async workspace({type}){return type==='list'?{items:records,order:records.map(row=>row.id)}:{members};}};
  const Controller=workspaceController(class {constructor(ctx){this.ctx=ctx;}},scope,RemoteError);
  const stop=new AbortController();
  const owner=new Controller({}).follow(stop.signal);
  const reader=new Controller({invocation:{peer:{principal:{kind:'reader'}}},remoteAccess:{
    allows:({kind,id})=>kind==='session'?id==='visible':id==='one'&&allowed,
  }}).follow(stop.signal);
  const change=()=>{const last=changed;changed=new AbortController();last.abort();};
  const next=async feed=>(await feed.next()).value;
  try {
    assert.equal((await next(owner)).type,'baseline');
    assert.equal((await next(reader)).type,'baseline');
    records.unshift({id:'two',path:'/two',title:'Two',created:2});change();
    const added=await next(owner);assert.equal(added.type,'upsert');assert.equal(added.workspace.workspaceId,'two');
    assert.deepEqual(await next(owner),{type:'order',workspaceIds:['two','one']});
    const readerRename=next(reader);
    records[1]={...records[1],title:'First'};change();
    for(const frame of [await next(owner),await readerRename]){
      assert.equal(frame.type,'upsert');assert.equal(frame.workspace.title,'First');
    }
    members.push({session:'hidden',workspace:'one',account_position:1,archived:true,last_activity_ms:'1'},
      {session:'visible',workspace:'one',account_position:0,pinned:true,last_activity_ms:'2'});change();
    assert.deepEqual((await next(owner)).workspace.sessionIds,['visible','hidden']);
    assert.deepEqual(await next(owner),{type:'archived',archivedSessionIds:['hidden']});
    assert.deepEqual(await next(owner),{type:'pinned',pinnedSessionIds:['visible']});
    const filtered=await next(reader);assert.equal(filtered.type,'replace');
    assert.deepEqual(filtered.value.items.map(row=>row.workspaceId),['one']);
    assert.deepEqual(filtered.value.items[0].sessionIds,['visible']);
    assert.deepEqual(filtered.value.archivedSessionIds,[]);assert.deepEqual(filtered.value.pinnedSessionIds,['visible']);
    allowed=false;change();const revoked=await next(reader);
    assert.equal(revoked.type,'replace');assert.deepEqual(revoked.value.items,[]);
    allowed=true;change();const restored=await next(reader);
    assert.equal(restored.type,'replace');assert.deepEqual(restored.value.items.map(row=>row.workspaceId),['one']);
    records.shift();change();const removed=await next(owner);
    assert.equal(removed.type,'replace');assert.deepEqual(removed.value.items.map(row=>row.workspaceId),['one']);
  }finally{stop.abort();await Promise.all([reader.return(),owner.return()]);}
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
    {workspace:workspaceId,session:'a',account_position:1,last_activity_ms:'3'},
    {session:'detached',last_activity_ms:'20',pinned:true},
    {workspace:workspaceId,session:'z',account_position:0,last_activity_ms:'4'},
  ]);
  const scope={workspaceChange:()=>new AbortController().signal,
    drafts:async()=>[{id:'detached',workspace:other,updatedAt:1},{id:'private',workspace:workspaceId,updatedAt:6}],
    workspace:async input=>input.type==='list'
      ? {items:[{id:workspaceId,path:'/one',title:'one',created:1},{id:other,path:'/two',title:'two',created:1}],order:[workspaceId,other]}
      : {members,next:null}};
  const Controller=workspaceController(class {},scope,RemoteError);
  const frames=new Controller().follow(new AbortController().signal);
  const {value:{value}}=await frames.next();
  assert.deepEqual(value.items.map(row=>row.sessionIds),[['private','z','a'],[]]);
  assert.deepEqual(value.pinnedSessionIds,['detached']);
  await frames.return();
});

test('a draft published between the two workspace reads keeps its durable position', async () => {
  let published = false;
  const old = {session:'older', workspace:workspaceId, account_position:0, last_activity_ms:'2'};
  const scope = {
    workspaceChange: () => new AbortController().signal,
    async drafts() {
      const rows = published ? [] : [{id:'promoting', workspace:workspaceId, updatedAt:3}];
      published = true;
      return rows;
    },
    async workspace({type}) {
      if (type === 'list') return {items:[{id:workspaceId,path:'/project',title:'project',created:1}], order:[workspaceId]};
      const members = published ? [old,{session:'promoting',workspace:workspaceId,account_position:1,last_activity_ms:'3'}] : [old];
      published = true;
      return {members,next:null};
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

test('an empty workspace feed publishes detached navigation even when drafts are unavailable', async () => {
  let change = new AbortController();
  const rows = [];
  const scope = {
    workspaceChange: () => change.signal,
    async workspace({type}) {
      if (type === 'list') return {items:rows, order:rows.map(row => row.id), next:null};
      return {members:[{session:'archived', archived:true}, {session:'pinned', pinned:true}], next:null};
    },
    async drafts() {
      assert.ok(rows.length, 'empty workspace list requested private drafts');
      return [{id:'draft', workspace:workspaceId}];
    },
  };
  const Controller = workspaceController(class {}, scope, RemoteError);
  const feed = new Controller().follow(new AbortController().signal);
  try {
    assert.deepEqual((await feed.next()).value, {type:'baseline', value:{
      items:[], archivedSessionIds:['archived'], pinnedSessionIds:['pinned'],
    }});
    rows.push({id:workspaceId, path:'/project', title:'Project', created:1});
    const previous = change;
    change = new AbortController();
    previous.abort();
    const next = (await feed.next()).value;
    assert.equal(next.type, 'upsert');
    assert.deepEqual(next.workspace.sessionIds, ['draft']);
  } finally {
    await feed.return();
  }
});
