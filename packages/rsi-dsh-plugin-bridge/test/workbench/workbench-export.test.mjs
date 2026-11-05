import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {workbenchPersistence} from '../../src/workbench/persistence.mjs';
import {workbenchHistory} from '../../src/workbench/history.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('stored metadata stays pageable beyond the browser response budget',async()=>{
  const cwd='a'.repeat(4000);let requests=0;
  const scope=applicationSessions(async(_method,{history})=>{
    assert.equal(history,true);
    const items=Array.from({length:64},(_,i)=>({id:String(requests*64+i),cwd}));
    return {items,next:++requests<20?String(requests):null};
  });
  const run=await scope.prepare(new Request('http://localhost/api/session.export'),'owner');
  await run(async()=>{
    let count=0;for await(const page of scope.storedPages())count+=page.length;
    assert.equal(count,1280);
  });
});

test('original lineage merges registered Sessions with paged durable metadata without opening event logs',{skip:!root},async()=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const {Context}=await load('cordis'),{default:Query}=await load('dsh-session-query-sqlite');
  const ctx=new Context(),calls=[];
  const meta=(id,parent)=>({id,created_at:10,parent,cwd:'/work',inherited:!!parent,preset:'native',
    selection_cursor:{kind:'durable',fact_seq:8,control_seq:3}});
  const parent=meta('root'),child=meta('child','root');
  const header={version:4,id:'child',createdAt:10,parentSession:'root',isSeeded:true,cwd:'/work',agentPreset:'native',origin:'subagent',delegationDepth:1};
  const attached={id:'child',header};
  const scope=applicationSessions(async(method,args)=>{
    calls.push(method);assert.equal(method,'application.sessions');assert.equal(args.request,'owner-request');assert.equal(args.history,true);
    return args.after?{items:[child],next:null}:{items:[parent],next:'page-2'};
  },{attached:()=>[attached],agent:id=>id==='child'?{session:attached}:undefined});
  let count=4;
  const history=workbenchHistory({storage:{metadata:id=>id==='child'?{header,eventCount:count}:undefined},
    read:async(id,operation)=>{assert.equal(operation.type,'open');if(id==='missing')return null;
      assert.equal(operation.metadata_only,true);return id==='child'?child:parent;}});
  const persistence=workbenchPersistence(history,await load('dsh-session-persistence'),scope.storedPages);
  ctx.provide('sessions',scope.sessions);ctx.provide('sessionPersistence',persistence);
  try {
    await (await ctx.plugin(Query,{path:':memory:',openAt:'never'})).await();
    const run=await scope.prepare(new Request('http://localhost/api/session.export'),'owner-request');
    await run(async()=>{
      assert.equal(scope.sessions.get('root'),undefined);
      assert.equal(scope.sessions.get('child'),attached);
      const trace=await ctx.sessionQuery.traceSession('root');
      assert.deepEqual(trace.descendants.map(row=>row.session.header),[header]);
      assert.deepEqual(calls,['application.sessions','application.sessions']);
      const [,listed]=await persistence.list();
      assert.deepEqual(await persistence.stat('child'),listed);
      assert.equal(await persistence.stat('missing'),undefined);
      await assert.rejects(persistence.open('missing','read'),(await load('dsh-session-persistence')).SessionPersistenceNotFoundError);
      count++;assert.notEqual((await persistence.stat('child')).revision,listed.revision);
    });
  }finally{await ctx.fiber.dispose();}
});
