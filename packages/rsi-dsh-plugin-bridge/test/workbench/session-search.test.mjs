import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {sessionController} from '../../src/workbench/session-controller.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
const signal=new AbortController().signal;
async function fixture(provider,allowed) {
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const {RemoteError}=await load('dsh-typert-protocol');
  const {SessionQueryError}=await load('dsh-session-query');
  const searchApi={...await load('dsh-api-session-controller/types'),RemoteError,SessionQueryError};
  class Service {constructor(ctx){this.ctx=ctx;}}
  const scope={observeOwned:(read,stop)=>read(stop)};
  const Controller=sessionController({TypertRemoteService:Service,searchApi},scope);
  const ctx={get:key=>{assert.equal(key,'sessionQuery');return provider;}};
  if(allowed){
    ctx.invocation={peer:{principal:{kind:'remote'}}};
    ctx.remoteAccess={allows:({kind,id})=>kind==='session'&&allowed.includes(id)};
  }
  return {controller:new Controller(ctx),SessionQueryError};
}

const hit=(id,snippet=id,overrides={})=>({header:{id},bestMatch:{
  sessionId:id,snippet,type:'user/message',surface:'current',...overrides}});

test('sidebar search advances provider pages, respects Session grants and returns bounded Unicode snippets',{skip:!root},async()=>{
  const ids=Array.from({length:23},(_,index)=>String(index));
  const stages=[];
  const provider={
    listSessions:async stop=>{assert.equal(stop,signal);return ids.map(id=>({header:{id,cwd:'/project'}}));},
    searchSessions:async({query,eventFilters,limit,cursor},{signal:stop})=>{
      stages.push([cursor,limit]);assert.equal(stop,signal);assert.equal(query,'orchid');
      assert.deepEqual(eventFilters,[{kind:'type',values:['user/message','assistant/message']},{kind:'surface',values:['current']}]);
      if(limit>10)throw new SessionQueryError('limit','SESSION_QUERY_INVALID_LIMIT');
      if(cursor==='obsolete')throw new SessionQueryError('stale','SESSION_QUERY_STALE_CURSOR');
      if(stages.length===2)return {items:[hit('0','discarded')],nextCursor:'obsolete'};
      if(cursor===undefined)return {items:[hit('hidden'),hit('4','mismatch',{sessionId:'5'}),hit('1','reasoning',{type:'assistant/thought'}),
        hit('5','old',{surface:'historical'}),hit('0','💠'.repeat(245)),hit('0','duplicate')],nextCursor:'a'};
      const start=cursor==='a'?1:11;
      return {items:ids.slice(start,start+10).map(id=>hit(id)),nextCursor:cursor==='a'?'b':undefined};
    },
  };
  const {controller,SessionQueryError}=await fixture(provider,['0']);
  assert.deepEqual(await controller.search({query:' orchid '},signal),{items:[{sessionId:'0',snippet:'💠'.repeat(240)}],hasMore:true});
  assert.deepEqual(stages,[[undefined,20],[undefined,10],['obsolete',10],[undefined,10],['a',10],['b',10]]);
});

test('sidebar search leaves hidden or unlisted messages out, rejects invalid queries and honours cancellation',{skip:!root},async()=>{
  const provider={listSessions:async()=>[{header:{id:'a',cwd:'/w'}},{header:{id:'hidden'}}],
    searchSessions:async()=>({items:[hit('hidden'),hit('other'),hit('a','yes',{type:'assistant/message'})]})};
  const {controller}=await fixture(provider);
  assert.deepEqual(await controller.search({query:'mark'},signal),{items:[{sessionId:'a',snippet:'yes'}],hasMore:false});
  for(const query of ['  ','x\0','🪴'.repeat(251)])
    await assert.rejects(controller.search({query},signal),{code:'gateway/bad-request'});
  const cancelled=AbortSignal.abort(Error('reader left'));
  await assert.rejects(controller.search({query:'mark'},cancelled),error=>error===cancelled.reason);
  provider.searchSessions=async()=>({items:[],nextCursor:'same'});
  await assert.rejects(controller.search({query:'mark'},signal),{code:'gateway/internal',message:/repeated a continuation/});
});
