import assert from 'node:assert/strict';
import {test} from 'node:test';
import {workbenchWorkspaceRegistry,workspaceView} from '../../src/workbench/workspace-registry.mjs';

test('Workspace metadata uses ordered published headers, keeps entity identity and reads no private drafts',async()=>{
  const row={id:'workspace',path:'/test',created:1};
  const archived={session:'detached',archived:true,partition_revision:'9'};
  const meta={id:'enrolled',createdAt:4,cwd:'/test',version:4,isSeeded:false};
  let members=[{session:'enrolled',workspace:row.id,account_position:5,last_activity_ms:'4',header:meta}],reads=0;
  const scope={
    observeOwned:op=>op(),workspace:async op=>{
      if(op.type==='list')return {order:[row.id],items:[row],next:null};
      assert.equal(op.headers,true);
      return op.after?{members,next:null}:{members:[archived],next:'more'};
    },
  };
  const model=workbenchWorkspaceRegistry(scope,header=>{reads++;return header;});
  await model.refresh();
  const service=model.service,workspace=service.get(row.id);
  assert.equal(service.list()[0],workspace);assert.deepEqual(workspace.getSessionHeaders(),[meta]);
  assert.deepEqual(workspace.sessionIds,['enrolled']);assert.deepEqual(service.archivedSessionIds,['detached']);
  model.record(workspaceView({...row,title:'Renamed',sessions:['private','enrolled']}));
  assert.equal(service.get(row.id),workspace);assert.equal(workspace.title,'Renamed');
  assert.deepEqual(workspace.sessionIds,['enrolled']);
  model.attach(row.id,{...meta,id:'new'});
  assert.deepEqual(workspace.sessionIds,['new','enrolled']);assert.equal(reads,1);
  await model.refresh();assert.equal(reads,1);
  members=[];await model.refresh();
  assert.deepEqual(workspace.sessionIds,[]);assert.equal(reads,1);
  model.remove(row.id);assert.equal(service.get(row.id),undefined);assert.deepEqual(service.list(),[]);
});

test('a directory read already in flight cannot overwrite a newer registration receipt',async()=>{
  const started=Promise.withResolvers(),release=Promise.withResolvers();
  const first={id:'first',path:'/first',created:1},second={id:'second',path:'/second',created:2};
  let scans=0;
  const scope={observeOwned:op=>op(),workspace:async op=>{
    if(op.type==='membership')return {members:[],next:null};
    const rows=++scans===1?[first]:[second,first];
    if(scans===1){started.resolve();await release.promise;}
    return {order:rows.map(row=>row.id),items:rows,next:null};
  }};
  const model=workbenchWorkspaceRegistry(scope);
  const read=model.refresh();await started.promise;
  model.record(workspaceView(second));const selected=model.service.get(second.id);release.resolve();
  await read;
  assert.deepEqual(model.service.list().map(row=>row.id),[second.id,first.id]);
  assert.equal(model.service.get(second.id),selected);
});
