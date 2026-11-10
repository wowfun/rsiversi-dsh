import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {workspaceController} from '../../src/workbench/workspace-controller.mjs';
import {catalogObserver,watchWorkbenchCatalog} from '../../src/workbench/catalog.mjs';

test('owner activity escapes the browser lifetime and drains ordered native receipts',async()=>{
  const seen=[],gate=Promise.withResolvers();let browser=true,settled=false;
  const scope=applicationSessions(async(method,args)=>{
    if(args.request==='browser'&&!browser)throw Error('browser retired');
    seen.push([args.request,args.operation?.type??method]);
    if(args.operation?.type==='execute')await gate.promise;
    return {id:args.session_id};
  },{owner:'application-owner'});
  let activity;
  const request=await scope.prepare({url:'/api/test',headers:{'x-rsi-upstream-request':'browser'}});
  await request(async()=>{
    await scope.authorize('session');
    activity=scope.runOwned(()=>{
      scope.stage(signal=>scope.command('session',{type:'execute'},signal));
      scope.stage(signal=>scope.command('session',{type:'status'},signal));
    }).then(()=>{settled=true;});
    await scope.authorize('session');
  });
  browser=false;
  await setImmediate();
  assert.equal(settled,false);
  gate.resolve();await activity;
  assert.deepEqual(seen.filter(([caller])=>caller==='browser'),[
    ['browser','application.session'],['browser','application.session']]);
  assert.deepEqual(seen.filter(([caller])=>caller==='application-owner'),[
    ['application-owner','execute'],['application-owner','status']]);
  assert.throws(()=>scope.authorize('session'),/active native request/);
  await scope.close();
});

test('failed writes skip successors, retired activities reject detached continuations and close drains',async()=>{
  const seen=[],entered=Promise.withResolvers(),release=Promise.withResolvers();let detached;
  const scope=applicationSessions(async(method,args,signal)=>{
    seen.push(args.operation.type);
    if(args.operation.type==='execute')throw Error('native failure');
    entered.resolve(signal);await release.promise;
  },{owner:'application-owner'});
  await assert.rejects(scope.runOwned(()=>{
    scope.stage(signal=>scope.command('session',{type:'execute'},signal));
    scope.stage(signal=>scope.command('session',{type:'status'},signal));
  }),/native failure/);
  assert.deepEqual(seen,['execute']);
  await scope.runOwned(()=>{const snapshot=AsyncLocalStorage.snapshot();detached=()=>snapshot(()=>scope.authorize('session'));});
  assert.throws(detached,/active native request/);
  const running=scope.runOwned(()=>scope.command('session',{type:'status'}));
  const signal=await entered.promise;
  let closed=false;const closing=scope.close().then(()=>{closed=true;});
  await setImmediate();assert.equal(signal.aborted,true);assert.equal(closed,false);
  release.resolve();await assert.rejects(running,/retired/);await closing;
  assert.throws(()=>scope.runOwned(()=>{}),/retired/);
});

test('catalog changes publish native activity, status and disappearance without transcript reads',()=>{
  const events=[],ctx={get:()=>undefined,emit:(...args)=>events.push(args)},publish=catalogObserver(ctx);
  const original={id:'one',updatedAt:1,blank:true,running:false};
  publish([original]);publish([original]);
  assert.equal(events.length,1);assert.equal(events[0][0],'api-session/added');
  publish([{...original,updatedAt:2,blank:false,running:true}]);
  assert.deepEqual(events.slice(-2),[['api-session/status','one',true],['api-session/activity','one',2]]);
  publish([]);assert.deepEqual(events.at(-1),['api-session/removed','one']);
});

test('a draft published between catalog reads never disappears from the combined listing',async()=>{
  let published=false;
  const scope=applicationSessions(async method=>{
    if(method==='application.workspaces')return {items:published?[]:[{id:'promoted',blank:true}],next:null};
    assert.equal(method,'application.sessions');
    published=true;return {items:[],next:null};
  },{owner:'application-owner'});
  assert.deepEqual(await scope.runOwned(()=>scope.list()),[{id:'promoted',blank:true}]);
  await scope.close();
});

test('Cordis retirement cancels and drains the independent catalog observer',async()=>{
  let dispose,stopped=false;const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const ctx={get:()=>undefined,emit(){},on(){},effect(factory){dispose=factory();}};
  const scope=applicationSessions(async(_method,_args,signal)=>{
    entered.resolve(signal);await release.promise;
    signal.throwIfAborted();throw Error('unreachable');
  },{owner:'application-owner'});
  watchWorkbenchCatalog(ctx,scope);
  const signal=await entered.promise;
  const closing=dispose().then(()=>{stopped=true;});
  await setImmediate();assert.equal(signal.aborted,true);assert.equal(stopped,false);
  release.resolve();await closing;await scope.close();
});

test('a native change during capture and local agent changes reach the catalog with one pending wait',{timeout:10000},async()=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),events=[],listeners=new Map();
  const firstChange=Promise.withResolvers(),rearmed=Promise.withResolvers();
  let dispose,available=false,reads=0,waits=0,opens=0,published=Promise.withResolvers();
  const ctx={get:()=>({get:()=>available}),emit:(name,row)=>{events.push([name,row]);published.resolve();},
    on:(name,handler)=>listeners.set(name,handler),effect:factory=>{dispose=factory();}};
  const scope=applicationSessions(async(method,args,signal)=>{
    if(method==='application.directory.wait'){
      if(args.open){opens++;return;}
      waits++;const pending=waits===1?firstChange:Promise.withResolvers();
      if(waits===2)rearmed.resolve();
      const cancel=()=>pending.reject(signal.reason);
      signal.addEventListener('abort',cancel,{once:true});
      try{await pending.promise;}finally{signal.removeEventListener('abort',cancel);}
      return;
    }
    if(method==='application.workspaces')return {items:[],next:null};
    assert.equal(method,'application.sessions');assert.equal(opens,1);
    if(++reads===1){entered.resolve();await release.promise;}
    return {items:[{id:'visible',updatedAt:1,running:false,blank:reads===1}],next:null};
  },{owner:'owner'});
  watchWorkbenchCatalog(ctx,scope);
  try {
    await entered.promise;firstChange.resolve();release.resolve();
    await published.promise;published=Promise.withResolvers();await published.promise;await rearmed.promise;
    assert.equal(events.at(-1)[1].blank,false);assert.equal(waits,2);
    published=Promise.withResolvers();available=true;listeners.get('agent/created')();
    listeners.get('rsi/catalog-projection')();await published.promise;
    assert.equal(events.at(-1)[1].agentAvailable,true);
    assert.equal(reads,3);assert.equal(waits,2);
  } finally {await dispose();await scope.close();}
});

test('Workspace pin order uses lossless revisions and falls back to native activity and identity order',async()=>{
  const members=[
    ['newest-pin','1','9007199254740993'],['second-pin','9','9007199254740992'],
    ['older','8'],['z','9'],['Z','9'],
  ].map(([session,last_activity_ms,partition_revision])=>({group:0,session,last_activity_ms,partition_revision,pinned:true}));
  members.push(...[['second','1','9007199254740993'],['first','2','9007199254740992'],['old-b','9'],['old-a','1']].map(([session,last_activity_ms,partition_revision])=>({group:0,session,last_activity_ms,partition_revision,archived:true})));
  members.forEach((member,index)=>{member.account_position=index;});
  const Workspace=workspaceController(class {},{workspaceChange:()=>new AbortController().signal,drafts:async()=>[],
    workspace:async({type})=>type==='list'?{items:[{id:'ws',path:'/work',created:1}],order:['ws']}:{groups:['ws'],members}});
  const frames=new Workspace().follow(new AbortController().signal);
  const {value:{value}}=await frames.next();
  assert.deepEqual(value.pinnedSessionIds,['newest-pin','second-pin','z','Z','older']);
  assert.deepEqual(value.archivedSessionIds,['old-a','old-b','first','second']);
  await frames.return();
});

const cohort=process.env.RSI_DSH_MARKET_COHORT;

test('Workspace baseline preserves Host display order across creation-order pages',async()=>{
  const requests=[];
  const Workspace=workspaceController(class {},{
    workspaceChange:()=>new AbortController().signal,drafts:async()=>[],
    async workspace(operation){
      requests.push(operation);
      if(operation.type==='membership')return {groups:[],members:[]};
      const ids=operation.after?['third']:['first','second'];
      return {items:ids.map(id=>({id,path:'/work/'+id,created:1})),
        next:operation.after?null:{after_order:2},order:operation.after?null:['third','first','second']};
    },
  });
  const frames=new Workspace().follow(new AbortController().signal);
  assert.deepEqual((await frames.next()).value.value.items.map(row=>row.workspaceId),['third','first','second']);
  assert.deepEqual(requests.map(row=>row.type),['list','list','membership']);
  await frames.return();
});

test('Workspace followers share invalidation across a suspended baseline and read their own rows',async()=>{
  const owner=applicationSessions(()=>{}, {owner:'owner'}),stop=new AbortController();
  let title='before',reads=0;
  const follower=id=>{
    const Workspace=workspaceController(class {},{workspaceChange:owner.workspaceChange, drafts:async()=>[],
      async workspace({type}){
        if(type==='membership')return {groups:[],members:[]};
        reads++;return {items:[{id,path:'/work/'+id,title,created:1}],order:[id]};
      }});
    return new Workspace().follow(stop.signal);
  };
  const left=follower('left'),right=follower('right');
  for(const stream of [left,right])assert.equal((await stream.next()).value.type,'baseline');
  title='renamed';owner.invalidateWorkspaces();
  const frames=await Promise.all([left.next(),right.next()]);
  assert.deepEqual(frames.map(({value})=>[value.type,value.value.items[0].workspaceId,value.value.items[0].title]),
    [['replace','left',title],['replace','right',title]]);
  const pending=[left.next(),right.next()];
  await setImmediate();assert.equal(reads,4);stop.abort();
  for(const result of await Promise.allSettled(pending))assert.equal(result.reason?.name,'AbortError');
  await owner.close();
});

test('a Workspace-only change wakes followers while the Session page is blocked',{timeout:5000},async()=>{
  const page=Promise.withResolvers(),entered=Promise.withResolvers(),change=Promise.withResolvers();
  let dispose,waits=0,reads=0;
  const scope=applicationSessions(async(method,args,signal)=>{
    if(method==='application.directory.wait'){
      if(args.open)return;
      if(++waits===1)return change.promise;
      return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    }
    if(method==='application.sessions'){reads++;entered.resolve();await page.promise;}
    return {items:[],next:null};
  },{owner:'owner'});
  watchWorkbenchCatalog({get(){},emit(){},on(){},effect:fn=>{dispose=fn();}},scope);
  try{
    await entered.promise;const before=scope.workspaceChange();
    change.resolve('workspace');await setImmediate();
    assert.equal(before.aborted,true);assert.equal(waits,2);assert.equal(reads,1);
  }finally{page.resolve();await dispose();await scope.close();}
});

test('one owned publication drains transitive writes without a cumulative 64-write gate',async()=>{
  const seen=[],scope=applicationSessions(async(_method,args)=>{seen.push(args.operation.index);},{owner:'owner'});
  const append=index=>scope.publish(async signal=>{
    await scope.command('one',{type:'execute',index},signal);
    if(index<100)append(index+1);
  });
  await scope.runOwned(()=>{append(0);});
  assert.deepEqual(seen,Array.from({length:101},(_,i)=>i));await scope.close();
});

test('resident observation writes have finite failure boundaries and outlive read cancellation',async()=>{
  const seen=[],entered=Promise.withResolvers(),release=Promise.withResolvers();let accepted,writeSignal;
  const scope=applicationSessions(async(_method,args,signal)=>{
    assert.equal(args.request,'owner');seen.push(args.operation.type);
    if(args.operation.type==='fail')throw Error('one notification failed');
    if(args.operation.type==='held'){writeSignal=signal;entered.resolve();await release.promise;}
  },{owner:'owner'});
  const stop=new AbortController();
  const observer=scope.observeOwned(async signal=>{
    await assert.rejects(scope.publish(s=>scope.command('one',{type:'fail'},s)),/one notification failed/);
    for(let i=0;i<100;i++)await scope.publish(s=>scope.command('one',{type:'write'},s));
    accepted=scope.publish(s=>scope.command('one',{type:'held'},s));
    await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  },stop.signal);
  await entered.promise;assert.equal(seen.filter(row=>row==='write').length,100);
  const rejected=assert.rejects(observer,/read stopped/);stop.abort(Error('read stopped'));await rejected;
  assert.equal(writeSignal.aborted,false,'accepted work retains the application lifetime');
  release.resolve();await accepted;await scope.close();
  assert.throws(()=>scope.observeOwned(()=>{}),/retired/);
});
test('original Cordis plugin disposal can await native owner work before caller retirement',{skip:!cohort},async()=>{
  const require=createRequire(join(cohort,'package.json'));
  const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
  const ctx=new Context(),entered=Promise.withResolvers(),release=Promise.withResolvers(),seen=[];
  const scope=applicationSessions(async(_method,args)=>{
    seen.push(args.request);entered.resolve();await release.promise;return {committed:true};
  },{owner:'application-owner'});
  await ctx.plugin({name:'native-owner-disposal-test',apply(ctx){
    ctx.effect(()=>()=>scope.runOwned(()=>scope.command('session',{type:'status'})));
  }});
  let closed=false;
  const closing=ctx.fiber.dispose().then(()=>{closed=true;});
  await entered.promise;assert.equal(closed,false);assert.deepEqual(seen,['application-owner']);
  release.resolve();await closing;await scope.close();
  assert.throws(()=>scope.runOwned(()=>{}),/retired/);
});
