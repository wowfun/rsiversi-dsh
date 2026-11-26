import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {readJournalDocument} from '../../src/session/journal-document.mjs';
import {SessionProjectionJournal} from '../../src/session/session-projection-journal.mjs';
import {SessionFacade,validateHeader} from '../../src/session/session.mjs';
import {sessionJournalStore} from '../../src/session/session-journal-store.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
const selection={provider:'native',model:'chosen',reasoningEffort:'low'};
const header={version:4,id:'journal-test',createdAt:1,isSeeded:false};
const message=(id,role,text)=>({id,role,source:{kind:role==='system'?'system-prompt':'user'},content:[{type:'text',text}]});
async function fixture(t,options={}) {
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();t.after(()=>ctx.fiber.dispose());
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  return {ctx,api,load,journal:new SessionProjectionJournal(ctx,api,{header},options)};
}

test('a cold owner adopts its private decoded events and preserves lossless JSON checks', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t);
  journal.accept('choose','model/selection',selection,{},1);
  const bytes=journal.encode();
  const open=document=>new SessionProjectionJournal(ctx,api,{header},{restore:document,adoptRestore:true,nativeEventState:'shared-frozen'});
  const restored=readJournalDocument(bytes);
  const cold=open(restored);
  assert.equal(cold.session.eventAt(0),restored.events[0]);
  assert.ok(Object.isFrozen(restored.events[0].data));
  for(const number of ['1e999','-0']){
    const damaged=readJournalDocument(bytes.replace('"time":1','"time":'+number));
    assert.throws(()=>open(damaged),/lossless JSON/);
  }
});

test('cold recovery preserves native sources correlated in reverse acceptance order', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t);
  journal.accept('first','model/selection',selection,{},1);
  journal.accept('second','model/selection',selection,{},2);
  const duplicate=readJournalDocument(journal.encode());
  duplicate.operations[1].seq=duplicate.operations[0].seq;
  assert.throws(()=>new SessionProjectionJournal(ctx,api,{header},{restore:duplicate}),/Invalid application mutation record/);
  journal.appendStored([{seq:2,time:3,type:'feedback/record',data:{text:'after both choices'}}]);
  const native=[2,1].map((time,seq)=>({seq,time,type:'model/selection',data:selection}));
  journal.merge(native,new Map([[0,'second'],[1,'first']]));
  const encoded=journal.encode();
  const disk=JSON.parse(encoded);
  assert.deepEqual(disk.sources,[[1,1],[0,1]]);
  assert.deepEqual(disk.operations.map(op=>[op.id,op.source]),[['first',1],['second',0]]);
  const restore=state=>new SessionProjectionJournal(ctx,api,{header},{restore:state,native,adoptRestore:true});
  const previous={...disk,version:7,sources:[{seq:1,operation:'second'},{seq:0,operation:'first'}]};
  assert.equal(restore(readJournalDocument(JSON.stringify(previous))).encode(),encoded);
  const parse=patch=>readJournalDocument(JSON.stringify({...disk,...patch}));
  for(const sources of [[[0,2],[1,1]], [[0,100_001]], [[0,0]], [[99_999,2]], [[1]], [[0,1,2]]])
    assert.throws(()=>parse({sources}),/source map/);
  assert.throws(()=>parse({operations:disk.operations.map(op=>({...op,source:0}))}),/correlation/);
  const cold=restore(readJournalDocument(encoded));
  assert.equal(cold.encode(),encoded);
  assert.deepEqual([cold.sourceAt(0).seq,cold.sourceAt(1).seq],[1,0]);
  assert.deepEqual([...cold.operationsBetween(0)].map(op=>op.id),['first','second']);
  cold.advance(2,[{seq:2,time:4,type:'turn/start',data:{turn:1}}]);
  assert.equal(cold.session.eventAt(3).type,'turn/start');
});

test('the release action-card service recovers decisions from the ordinary Session journal', {skip:!root},async t=>{
  const {ctx,api,load,journal}=await fixture(t);
  await ctx.plugin((await load('dsh-session-projection')).default);
  await ctx.plugin((await load('dsh-agent')).AgentRegistry);
  ctx.provide('remoteAccess',{allows:()=>true});
  await (await ctx.plugin((await load('dsh-action-cards')).default,{})).await();
  const {z}=createRequire(join(root,'package.json'))('zod');
  ctx.actionCards.register({action:'sample',details:z.object({}),verbs:{},act:async()=>({status:'ok'})});
  const decision={cardId:'sample-offer',action:'sample',phase:'dismissed'};
  ctx.actionCards.record({session:journal},decision);
  assert.deepEqual(ctx.actionCards.view(journal.session).decisions[decision.cardId],decision);
  assert.deepEqual(journal.session.deriveMessages(),[]);
  const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(journal.encode()),native:[]});
  assert.deepEqual(ctx.actionCards.view(cold.session),ctx.actionCards.view(journal.session));
});

test('live Session position and range reads match the selected release at the log boundary', {skip:!root},async t=>{
  const {api,journal}=await fixture(t);
  const original=api.Session.create(header.id);
  const event=original.append('turn/start',{turn:1});
  journal.merge([event]);
  const session=journal.session;
  for(const position of [0,1,9])assert.deepEqual(session.eventAt(position),original.eventAt(position));
  for(const [start,end] of [[0,2],[1,1],[1,9],[1,0],[9,12]]){
    const range=session.snapshotEvents(start,end);
    assert.deepEqual(range,original.snapshotEvents(start,end));
    assert.ok(Object.isFrozen(range));
  }
  const before=session.snapshotEvents();
  assert.equal(session.snapshotEvents(),before);
  journal.merge([event,{seq:1,time:2,type:'turn/end',data:{turn:1,reason:'completed'}}]);
  assert.equal(before.length,1);
  assert.equal(session.eventAt(1).type,'turn/end');
});

test('selection records and the native delta commit together without copying native events into storage', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t);
  const first={seq:0,time:1,type:'turn/start',data:{turn:1}};
  const second={seq:1,time:2,type:'turn/end',data:{turn:1,reason:'completed'}};
  journal.merge([first]);
  const before=journal.encode(),selection={time:2,type:'agent-preset/selected',data:{agentPreset:'custom'}};
  assert.throws(()=>journal.advance(1,[{...second,seq:2}],new Map(),new Map(),[selection]),/not dense/);
  assert.equal(journal.encode(),before);
  assert.throws(()=>journal.advance(1,[second],new Map(),new Map(),[{...selection,surfaceOp:'append'}]),/Log-only/);
  assert.equal(journal.encode(),before);
  journal.advance(1,[second],new Map(),new Map(),[selection]);
  assert.deepEqual(journal.session.snapshotEvents().map(event=>event.type),['turn/start','agent-preset/selected','turn/end']);
  const stored=readJournalDocument(journal.encode());
  assert.deepEqual(stored.events,[{...selection,seq:1}]);
  assert.deepEqual(stored.sources.map(row=>row.seq),[0,2]);
  const cold=new SessionProjectionJournal(ctx,api,{header},{restore:stored,native:[first,second]});
  assert.equal(cold.encode(),journal.encode());
});

test('incremental journal publication retains the surface across valid and rejected batches', {skip:!root},async t=>{
  const {journal}=await fixture(t);
  const surface=journal.session.surface;
  const user=(seq,id)=>({seq,type:'user/message',time:1,surfaceOp:'append',data:message(id,'user',id)});
  journal.advance(0,[user(0,'first')]);
  assert.equal(journal.session.surface,surface);
  const before=journal.session.snapshotEvents();
  const replacement={...user(2,'replacement'),surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[1]};
  assert.throws(()=>journal.advance(1,[user(1,'second'),{...replacement,surfaceOp:{op:'replace',startSeq:4,endSeq:4}}]));
  assert.equal(journal.session.snapshotEvents(),before);
  assert.deepEqual(surface.nodes,[0]);
  journal.advance(1,[user(1,'second'),replacement]);
  assert.equal(journal.session.surface,surface);
  assert.deepEqual(surface.nodes,[0,2]);
  journal.appendStored([3,4].map(seq=>({type:'feedback/record',seq,time:1,data:{text:'Review'}})));
  assert.equal(journal.session.surface,surface);
  assert.deepEqual(journal.session.deriveMessages().map(item=>item.id),['first','replacement']);
});

test('native branches keep an isolated suffix and publish it to the existing release surface', {skip:!root},async t=>{
  const {ctx,api}=await fixture(t);
  const native=new SessionFacade(ctx,api,{header},false),surface=native.surface;
  native.prepareBranch(native.branch())();
  assert.deepEqual(surface.nodes,[]);
  function append(session,id,options={surfaceOp:'append'}) {
    session.begin();
    try{return session.appendObserved('user/message',message(id,'user',id),1,options);}
    finally{session.end();}
  }
  const first=append(native,'first'),batch=native.branch(),second=append(batch,'second');
  assert.equal(batch.eventAt(0),first);assert.deepEqual(batch.snapshotEvents(1),[second]);
  const commit=native.prepareBranch(batch);
  assert.deepEqual(surface.nodes,[0]);assert.equal(native.seq,1);
  commit();assert.equal(native.surface,surface);assert.deepEqual(surface.nodes,[0,1]);
  const bad=native.branch();
  const replaceFirst={surfaceOp:{op:'replace',startSeq:0,endSeq:0},sourceEventSeqs:[0]};
  append(bad,'replacement',replaceFirst);append(bad,'already-shadowed',replaceFirst);
  assert.throws(()=>native.prepareBranch(bad));
  assert.deepEqual(surface.nodes,[0,1]);assert.equal(native.seq,2);
  const stale=native.branch(),third=append(stale,'third');
  assert.deepEqual(stale.surface.nodes,[0,1,2]);
  const fourth=append(stale,'fourth');assert.deepEqual(stale.snapshotEvents(-2),[third,fourth]);
  const publish=native.prepareBranch(stale);
  append(native,'other');assert.throws(publish,/lost its original prefix/);
  assert.equal(native.eventAt(2).data.id,'other');
});

test('preceding records and a full native merge publish or fail as one restorable batch', {skip:!root},async t=>{
  const notices=[],{ctx,api,journal}=await fixture(t,{notify:(_session,event)=>notices.push(event)});
  const first={seq:0,time:1,type:'turn/start',data:{turn:1}};
  const second={seq:1,time:2,type:'turn/end',data:{turn:1,reason:'completed'}};
  const preceding={time:3,type:'agent-preset/selected',data:{agentPreset:'custom'}};
  const merge=(native,extra=[preceding])=>journal.merge(native,new Map(),0,new Map(),[],extra);
  const before=journal.encode();
  assert.throws(()=>merge([first,{seq:1,time:2,type:'plan/mode',data:{active:'invalid'}}]),/Plan/);
  assert.throws(()=>merge([first,second],[first]),/log-only/);
  assert.equal(journal.encode(),before);
  assert.deepEqual([journal.seq,journal.nativeSeq,journal.ownedEventCount,journal.revision,notices.length],[0,0,0,0,0]);
  merge([first,second]);
  assert.deepEqual(notices.map(event=>event.type),['agent-preset/selected','turn/start','turn/end']);
  assert.deepEqual([journal.sourceAt(0).seq,journal.sourceAt(1).seq],[1,2]);
  preceding.data.agentPreset='mutated after acceptance';
  assert.equal(journal.session.eventAt(0).data.agentPreset,'custom');
  assert.ok(Object.isFrozen(journal.session.eventAt(0)));
  const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(journal.encode()),native:[first,second]});
  assert.equal(cold.encode(),journal.encode());
});

test('preceding records cannot enter a fresh inherited prefix, with or without constructor annotations', {skip:!root},async t=>{
  const {ctx,api}=await fixture(t),child={...header,isSeeded:true,parentSession:'parent'};
  for(const [cut,annotated] of [[1,true],[1,false],[0,true]]) {
    const prefix=cut?[{type:'session/end-seed',seq:0,time:1,data:{inherited:true}}]:[];
    const native=[...prefix,{type:'session/end-seed',seq:cut,time:2,data:{inherited:true}}];
    const annotations=annotated?[{type:'working-directory/change',time:2,data:{cwd:process.cwd()},ignorable:true}]:[];
    const notices=[],journal=new SessionProjectionJournal(ctx,api,{header:child},{notify:(_session,event)=>notices.push(event)});
    const before=journal.encode();
    assert.throws(()=>journal.merge(native,new Map(),cut,new Map(),annotations,
      [{type:'agent-preset/selected',time:3,data:{agentPreset:'custom'}}]),/inherited prefix/);
    assert.equal(journal.encode(),before);
    assert.deepEqual([journal.seq,journal.nativeSeq,journal.ownedEventCount,journal.revision,notices.length],[0,0,0,0,0]);
    journal.merge(native,new Map(),cut,new Map(),annotations);
    const cold=new SessionProjectionJournal(ctx,api,{header:child},{restore:readJournalDocument(journal.encode()),native});
    assert.equal(cold.encode(),journal.encode());
  }
  const journal=new SessionProjectionJournal(ctx,api,{header:child});
  assert.throws(()=>journal.merge([],new Map(),1,new Map(),[],
    [{type:'agent-preset/selected',time:3,data:{agentPreset:'custom'}}]),/prefix moved backwards/);
});

test('Header preset identifiers are bounded nonblank values when present',()=>{
  assert.deepEqual(validateHeader(header),header);
  for(const agentPreset of ['', ' \t ', 'x'.repeat(257), 1, null])
    assert.throws(()=>validateHeader({...header,agentPreset}),/Session header/);
  assert.equal(validateHeader({...header,agentPreset:'x'.repeat(256)}).agentPreset.length,256);
});

test('selection identifiers share Header bounds and rejected selections leave no durable record', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t),before=journal.encode();
  for(const agentPreset of ['', ' \t ', 'x'.repeat(257), 1, null]) {
    assert.throws(()=>journal.append('agent-preset/selected',{agentPreset}),/Agent preset selection/);
    assert.equal(journal.encode(),before);
  }
  journal.append('agent-preset/selected',{agentPreset:'x'.repeat(256)});
  const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(journal.encode())});
  assert.equal(cold.encode(),journal.encode());
});

test('native admission shares one encoding with source digests while cold replay still checks them', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t,{nativeEventState:'shared-frozen'});
  const source=new SessionFacade(ctx,api,{header},false);
  const stringify=JSON.stringify;let encoded=0;
  t.mock.method(JSON,'stringify',function(value,...args){
    if(value?.type==='user/message'&&value.data.id==='single-encoding')encoded++;
    return stringify(value,...args);
  });
  source.begin();
  const event=source.appendObserved('user/message',message('single-encoding','user','immutable input'),1,{surfaceOp:'append'});
  source.end();
  assert.equal(encoded,1,'admission accounts for the encoded byte size');
  journal.merge(source.snapshotEvents());
  journal.merge(source.snapshotEvents());
  assert.equal(encoded,1,'transfer and repeated reconciliation reuse the admitted digest');
  const document=journal.encode();
  const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(document),
    native:source.snapshotEvents(),nativeEventState:'shared-frozen'});
  cold.merge(source.snapshotEvents());
  assert.equal(cold.encode(),document);
  assert.equal(encoded,1,'cold reconciliation reuses the native admission evidence');
  const changed=api.deepFreeze({...event,time:2});
  assert.throws(()=>cold.merge([changed]),/prefix changed/);
  assert.equal(encoded,2,'freezing a different object does not establish admission');
  assert.equal(cold.encode(),document);
});

test('one durable source digest detects cold changes and advances only after a valid native batch', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t);
  const native=[0,1].map(seq=>({type:'model/selection',seq,time:seq,data:{...selection,model:'model-'+seq}}));
  journal.merge(native);
  const before=journal.encode(),saved=JSON.parse(before);
  assert.equal(saved.version,8);assert.match(saved.sourceDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(saved.sources,[[0,2]]);
  const restore=(state,events=native)=>new SessionProjectionJournal(ctx,api,{header},
    {restore:readJournalDocument(JSON.stringify(state)),native:events});
  assert.equal(restore(saved).encode(),before);
  assert.throws(()=>restore({...saved,sourceDigest:'0'.repeat(64)}),/prefix changed/);
  assert.throws(()=>restore(saved,[native[0],{...native[1],time:9}]),/prefix changed/);
  assert.throws(()=>restore(saved,native.slice(0,1)),/prefix moved backwards/);
  assert.throws(()=>readJournalDocument(JSON.stringify({...saved,version:7,sources:[{seq:0,hash:'0'.repeat(64)},{seq:1}]})),/source map/);
  const next={...native[1],seq:2,time:2};
  assert.throws(()=>journal.advance(2,[next,{...next,seq:3,surfaceOp:{type:'replace',startSeq:99,endSeq:99}}]),/outside its observed prefix/);
  assert.equal(journal.encode(),before,'a rejected batch cannot advance the saved source digest');
  journal.advance(2,[next]);
  const complete=JSON.parse(journal.encode());
  assert.notEqual(complete.sourceDigest,saved.sourceDigest);
  assert.equal(restore(complete,[...native,next]).encode(),journal.encode());
});

test('version 6 source hashes are checked before rewriting a journal with one prefix digest', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t),native=[{type:'model/selection',seq:0,time:1,data:selection}];
  journal.merge(native);
  const legacy=JSON.parse(journal.encode());legacy.version=6;delete legacy.sourceDigest;
  legacy.sources=Array.from({length:journal.nativeSeq},(_,index)=>journal.sourceAt(index));
  let stored;
  const cold=new SessionProjectionJournal(ctx,api,{header},
    {restore:readJournalDocument(JSON.stringify(legacy)),native,save:async value=>{stored=value;}});
  cold.merge(native);await cold.flush();
  assert.equal(stored,journal.encode());
  const corrupt=structuredClone(legacy);corrupt.sources[0].hash='0'.repeat(64);
  const bad=new SessionProjectionJournal(ctx,api,{header},
    {restore:readJournalDocument(JSON.stringify(corrupt)),native,save:async()=>{assert.fail('invalid history must not publish');}});
  assert.throws(()=>bad.merge(native),/prefix changed/);
});

test('request headers freeze once at admission and share immutable schemas across journal transfer', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t,{nativeEventState:'shared-frozen'});
  const freeze=api.deepFreeze,walks=[];
  api.deepFreeze=value=>{walks.push(value);return freeze(value);};
  const input=Object.freeze({reason:'initial',header:{config:{provider:'native',model:'chosen'},
    adapterDefaults:{maxTokens:true},tools:[{name:'read',description:'Read',
      parameters:{type:'object',properties:{path:{type:'string'}}}}]}});
  const source=new SessionFacade(ctx,api,{header},false);
  source.begin();const event=source.appendObserved('request/header',input,1);source.end();
  input.header.tools[0].parameters.properties.path.type='outside mutation';
  assert.equal(event.data.header.tools[0].parameters.properties.path.type,'string');
  const canonical=source.requestHeader();
  assert.notEqual(canonical,event.data.header);
  assert.equal(canonical.tools,event.data.header.tools);
  assert.equal(canonical.config,event.data.header.config);
  assert.equal(canonical.adapterDefaults,event.data.header.adapterDefaults);
  assert.ok(Object.isFrozen(canonical));
  assert.ok(Object.isFrozen(canonical.tools[0].parameters.properties.path));
  assert.deepEqual(walks,[event],'the shallow canonical wrapper must not walk the schema graph again');
  journal.append('feedback/record',{text:'Review'});walks.length=0;
  journal.merge(source.snapshotEvents());
  const transferred=journal.session.eventAt(1);
  assert.notEqual(transferred,event);
  assert.equal(transferred.data,event.data);
  assert.ok(Object.isFrozen(transferred));
  assert.equal(journal.session.requestHeader().tools,canonical.tools);
  assert.ok(Object.isFrozen(journal.session.requestHeader()));
  assert.deepEqual(walks,[],'shared native payloads need no full-graph freeze');
  const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(journal.encode()),
    native:source.snapshotEvents(),nativeEventState:'shared-frozen'});
  assert.equal(cold.session.requestHeader().tools,canonical.tools);
  assert.ok(Object.isFrozen(cold.session.requestHeader()));
});

test('native frozen bodies survive remapped positions and cold restore without duplication', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t,{nativeEventState:'shared-frozen'});
  const source=new SessionFacade(ctx,api,{header},false);
  source.begin();
  const first=source.appendObserved('user/message',message('one','user','retained body'),1,{surfaceOp:'append'});
  source.end();
  journal.append('feedback/record',{text:'Review'});
  journal.merge(source.snapshotEvents());
  assert.equal(journal.session.eventAt(1).seq,1);assert.equal(first.seq,0);
  assert.equal(journal.session.eventAt(1).data,first.data);
  assert.notEqual(journal.session.eventAt(1),first,'application positions own their envelopes');
  const saved=readJournalDocument(journal.encode());
  const cold=new SessionProjectionJournal(ctx,api,{header},{restore:saved,native:source.snapshotEvents(),nativeEventState:'shared-frozen'});
  cold.merge(source.snapshotEvents());
  assert.equal(cold.session.eventAt(1).data,first.data);
  assert.deepEqual(cold.session.snapshotEvents(),journal.session.snapshotEvents());
  saved.events[0].data.text='changed outside';
  assert.equal(cold.session.eventAt(0).data.text,'Review');
});

test('mutable native inputs are detached once and never frozen on behalf of the caller', {skip:!root},async t=>{
  const {journal}=await fixture(t);
  const input={seq:0,time:1,type:'user/message',data:message('one','user','original'),surfaceOp:'append'};
  journal.merge([input]);
  assert.equal(Object.isFrozen(input.data),false);
  input.data.content[0].text='outside mutation';
  assert.equal(journal.session.eventAt(0).data.content[0].text,'original');
  assert.ok(Object.isFrozen(journal.session.eventAt(0).data.content[0]));
  assert.throws(()=>journal.advance(1,[{...input,seq:1,data:{...input.data,bad:NaN}}]),/lossless JSON/);
  assert.equal(journal.seq,1);
});

test('log-only Session events survive cold reload without allocating native mutation identities', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t);
  const title={title:'Named session',source:{kind:'user'},messageSeqs:[]};
  journal.accept('previous-release','session/title',title);
  journal.append('feedback/record',{text:'Review'});
  journal.append('approval/asked',{id:'one',toolName:'bash',callId:'native-call'});
  journal.append('approval/decided',{id:'one',outcome:'allowed-once'});
  journal.append('session/title',title);
  const titleInput=message('title-input','user','Short title');
  const request={titleProvider:'first-prompt',messageSeqs:[0],route:{provider:'native',model:'chosen'},
    system:'Name the session',messages:[titleInput],maxTokens:4096};
  journal.append('session/title-llm-request',request);
  assert.throws(()=>journal.append('session/title-llm-request',request,{surfaceOp:'append'}),/Log-only/);
  journal.append('command/run',{commandId:'web-export',name:'export',source:{kind:'user'}});
  journal.append('command/done',{commandId:'web-export',kind:'success'});
  const job={jobId:'bash-first',owner:header.id,kind:'bash',label:'sleep 1',startedAt:1,
    toolCall:{callId:'shell-call',rootCallId:'shell-call'}};
  journal.append('job/registered',job);
  journal.append('job/settled',{...job,finishedAt:2,status:'completed',cause:'producer',producerReported:true});
  assert.throws(()=>journal.append('model/selection',selection),/owning native command/);
  assert.throws(()=>journal.append('approval/decided',{id:'one',outcome:'allowed-once'},{surfaceOp:'append'}),/Log-only/);
  const restore=document=>new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(document)});
  const cold=restore(journal.encode());
  assert.deepEqual(cold.session.snapshotEvents(),journal.session.snapshotEvents());
  assert.deepEqual(cold.session.lastEvent('session/title-llm-request').data,request);
  assert.deepEqual(cold.session.deriveMessages(),[]);
  assert.deepEqual(cold.operations(),[{id:'previous-release',seq:0}]);
  const corrupt=JSON.parse(journal.encode());
  Object.assign(corrupt.events[1],{type:'model/selection',data:selection});
  assert.throws(()=>restore(JSON.stringify(corrupt)),/unowned event/);
});

test('log-only hook invocation and result stay in their turn across cold replay', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t);
  const start={seq:0,time:1,type:'turn/start',data:{turn:1}};
  journal.merge([start],new Map(),0);
  const invoked={turn:1,point:'Stop',dialect:'claude-code',handlerId:'stop-1'};
  const result={turn:1,point:'Stop',handlerId:'stop-1',decision:'deny',durationMs:3};
  journal.append('hook/invoked',invoked);
  journal.append('hook/result',result);
  assert.throws(()=>journal.append('hook/result',result,{surfaceOp:'append'}),/Log-only/);
  const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(journal.encode()),native:[start]});
  assert.deepEqual(cold.session.snapshotEvents(),journal.session.snapshotEvents());
  assert.deepEqual(cold.session.surface.nodes,[]);
});

test('fresh managed children retain descriptor and delegated policy while the parent retains the DSH catalog',{skip:!root},async t=>{
  const {ctx,api,load,journal}=await fixture(t);
  const {snapshotSubagentDescriptor,foldSubagentDescriptor}=await load('dsh-subagent');
  const childHeader={...header,id:'child',parentSession:header.id,origin:'subagent',delegationDepth:1,isSeeded:false};
  const child=new SessionProjectionJournal(ctx,api,{header:childHeader},{});
  const descriptor=snapshotSubagentDescriptor({mode:'continuable',provider:'spawn',label:'review'});
  child.append('subagent/descriptor',descriptor);
  const policy={mode:'read-only',source:'delegation'};
  assert.throws(()=>child.append('sandbox/mode',policy),/owning native command/);
  assert.throws(()=>journal.append('sandbox/mode',policy,{},true),/owning native command/);
  child.append('sandbox/mode',policy,{},true);
  child.append('permission/preset',{preset:'auto'},{},true);
  const entry={version:3,childId:'child',childCreatedAt:childHeader.createdAt,mode:'continuable',label:'review',name:'worker'};
  journal.append('subagent/catalog',entry);
  const reopen=(owner,identity)=>new SessionProjectionJournal(ctx,api,{header:identity},{restore:readJournalDocument(owner.encode()),native:[]}).session;
  const restored=reopen(child,childHeader);
  assert.deepEqual(foldSubagentDescriptor(restored.snapshotEvents()),descriptor);
  assert.deepEqual(restored.snapshotEvents(),child.session.snapshotEvents());
  assert.deepEqual(reopen(journal,header).lastEvent('subagent/catalog').data,entry);
});

test('constructor annotations keep the original DSH inherited cut through deltas and cold replay', {skip:!root},async t=>{
  const {ctx,api,load}=await fixture(t);
  const {foldSubagentDescriptor,snapshotSubagentDescriptor}=await load('dsh-subagent');
  const child={...header,isSeeded:true,parentSession:'parent'};
  const descriptor=snapshotSubagentDescriptor({mode:'continuable',provider:'test',label:'Child'});
  const create=(document,native)=>new SessionProjectionJournal(ctx,api,{header:child},{restore:readJournalDocument(document),native});
  for(const prefix of [[],[{type:'session/end-seed',seq:0,time:1,data:{inherited:true}}]]) {
    const cut=prefix.length;
    const annotations=[{type:'workspace-root/change',seq:cut,time:4,data:{cwd:process.cwd()},ignorable:true},
      {type:'subagent/descriptor',seq:cut+1,time:5,data:descriptor}];
    const expected=api.Session.create(child.id,[...prefix,...annotations],child,cut+2);
    const native=[...prefix,{type:'session/end-seed',seq:cut,time:6,data:{inherited:true}}];
    const journal=create();
    const merge=(target,extra)=>target.merge(native,new Map(),cut,new Map(),extra);
    assert.throws(()=>merge(journal,[{...annotations[0],surfaceOp:'append'}]));
    assert.equal(journal.seq,0);
    merge(journal,annotations);
    const later={type:'plan/mode',seq:cut+1,time:7,data:{active:false}};
    journal.advance(native.length,[later]);
    journal.append('feedback/record',{text:'Review'});
    const restored=create(journal.encode(),[...native,later]);
    restored.merge([...native,later],new Map(),cut);
    restored.advance(native.length+1,[{...later,seq:cut+2,time:8}]);
    for(const target of [journal,restored]) {
      assert.equal(target.session.inheritedEventCount,expected.inheritedEventCount);
      assert.deepEqual(target.session.snapshotEvents(0,cut+2),expected.snapshotEvents(0,cut+2));
      assert.deepEqual(foldSubagentDescriptor(target.session.snapshotEvents()),descriptor);
      assert.equal(foldSubagentDescriptor(target.session.snapshotEvents(cut+2)),undefined);
      assert.equal(target.sourceAt(cut).seq,cut+2);assert.ok(target.hasLocalEvents);
      assert.equal(target.session.eventAt(target.sourceAt(cut).seq).type,'session/end-seed');
    }
    const corrupt=JSON.parse(journal.encode());
    corrupt.inheritedEventCount--;
    assert.throws(()=>create(JSON.stringify(corrupt),[...native,later]),/unowned event/);
  }
});

test('accepted event identity survives intervening native input, delayed acknowledgement and cold reload',
  {skip:!root},async t=>{
    let persisted;const notices=[];
    const {ctx,api,journal}=await fixture(t,{save:async value=>{persisted=value;},notify:(_session,event)=>notices.push(event)});
    const data=structuredClone(selection),accepted=journal.accept('choose','model/selection',data,{},10);
    data.model='mutated';assert.deepEqual(accepted.data,selection);assert.ok(Object.isFrozen(accepted.data));
    assert.equal(journal.operationAt(accepted.seq),journal.operation('choose'));
    journal.prepare('choose',{request_id:'choose',expected_revision:{kind:'durable',control_seq:8},arguments:selection});
    await journal.flush();
    const native=[{seq:0,time:20,type:'user/message',data:message('one','user','concurrent native input'),surfaceOp:'append'},
      {seq:1,time:30,type:'model/selection',data:selection}];
    const correlations=new Map([[1,'choose']]);
    assert.equal(journal.merge(native,correlations).length,1);
    assert.equal(journal.session.eventAt(accepted.seq).time,10,'native acknowledgement cannot replace the original acceptance time');
    assert.equal(journal.session.eventAt(accepted.seq),accepted,'later observations retain the exact accepted event object');
    assert.equal(journal.seq,2);assert.equal(notices.length,2);
    assert.equal(journal.operationAt(1),undefined,'a native-only position has no local operation');
    journal.complete('choose',{request_id:'choose',outcome:{kind:'committed',control_seq:9}});
    await journal.flush();
    const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(persisted),native});
    assert.deepEqual(cold.session.snapshotEvents(),journal.session.snapshotEvents());
    assert.deepEqual(cold.operations(),journal.operations());
    assert.deepEqual(cold.operationAt(accepted.seq),journal.operation('choose'),'position reads include preparation, receipt and native alias after reload');
    assert.equal(cold.operationAt(1),undefined);
    assert.deepEqual(cold.merge(native,correlations),[]);
    assert.equal(cold.seq,2);
    assert.throws(()=>cold.merge([...native,{...native[1],seq:2}],new Map([[1,'choose'],[2,'choose']])),/repeated mutation/);
    assert.throws(()=>cold.merge([{...native[0],time:21},native[1]],correlations),/prefix changed/);
    assert.deepEqual(cold.session.snapshotEvents(),journal.session.snapshotEvents());
  });

test('source, replacement, developer-header and command references retain their meaning after local interleaving',
  {skip:!root},async t=>{
    const {ctx,api,journal}=await fixture(t);journal.accept('choose','model/selection',selection,{},1);
    const native=[];
    const add=(type,data,opts={})=>{const seq=native.length;native.push({seq,time:seq+10,type,data,...opts});return seq;};
    const system=add('system/message',{turn:0,step:0,message:message('old','system','old')},{surfaceOp:'append'});
    const request=add('request/header',{reason:'initial',header:{config:{provider:'native',model:'chosen'},
      tools:[{name:'read',description:'Read',parameters:{type:'object',properties:{}}}]}});
    const input=add('user/message',message('input','user','input'),{surfaceOp:'append'});
    add('developer/message',{turn:0,step:0,headerSeq:request,message:{...message('tools','developer','tools'),
      content:[{type:'tool-addition',toolName:'read'}]}},{surfaceOp:'append'});
    add('command/run',{commandId:'cmd',name:'context',source:{kind:'user'}});
    add('command/done',{commandId:'cmd',kind:'success',text:'done',sourceEventSeq:input});
    add('system/message',{turn:0,step:0,message:message('new','system','new')},
      {surfaceOp:{op:'replace',startSeq:system,endSeq:system},sourceEventSeqs:[system]});
    journal.merge(native);
    const events=journal.session.snapshotEvents();
    assert.equal(events.find(event=>event.type==='developer/message').data.headerSeq,request+1);
    assert.equal(events.find(event=>event.type==='command/done').data.sourceEventSeq,input+1);
    assert.deepEqual(events.at(-1).sourceEventSeqs,[system+1]);
    assert.deepEqual(events.at(-1).surfaceOp,{op:'replace',startSeq:system+1,endSeq:system+1});
    assert.ok(Object.isFrozen(events.find(event=>event.type==='developer/message').data));
    assert.ok(Object.isFrozen(events.find(event=>event.type==='command/done').data));
    assert.ok(Object.isFrozen(events.at(-1).sourceEventSeqs));
    assert.ok(Object.isFrozen(events.at(-1).surfaceOp));
    assert.equal(events[journal.session.surface.nodes[0]].data.message.id,'new');
    assert.equal(native.find(event=>event.type==='developer/message').data.headerSeq,request);
    assert.equal(native.find(event=>event.type==='command/done').data.sourceEventSeq,input);
    assert.deepEqual(native.at(-1).surfaceOp,{op:'replace',startSeq:system,endSeq:system});
    assert.deepEqual(native.at(-1).sourceEventSeqs,[system]);
    const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(journal.encode()),native});
    cold.merge(native);
    assert.deepEqual(cold.session.snapshotEvents(),events);
    assert.deepEqual(cold.session.surface.nodes,journal.session.surface.nodes);
  });

test('requestHeader follows the released fold across atomic batches, inherited seeds and cold reads',{skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t);
  assert.equal(journal.session.requestHeader(),undefined);
  const event=(seq,model)=>({seq,time:seq,type:'request/header',data:{reason:seq?'change':'initial',
    header:{config:{provider:'native',model},adapterDefaults:{maxTokens:true}}}});
  const first=event(0,'parent');
  journal.merge([first],new Map(),1);
  const previous=journal.session.requestHeader();
  assert.deepEqual(previous,api.foldRequestHeader([first]));
  assert.ok(Object.isFrozen(previous.config));
  const second=event(1,'child');
  assert.throws(()=>journal.advance(1,[second,{seq:2,time:3,type:'plan/mode',data:{active:0}}]));
  assert.equal(journal.session.requestHeader(),previous);
  journal.advance(1,[second]);const current=journal.session.requestHeader();
  assert.deepEqual(current,api.foldRequestHeader([first,second]));
  const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(journal.encode()),native:[first,second]});
  assert.deepEqual(cold.session.requestHeader(),current);
  journal.accept('plain','plan/mode',{active:false});assert.equal(journal.session.requestHeader(),current);
});

test('durable journals omit native bodies while preserving local acknowledgements and exact cold events', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t);
  const accepted=journal.accept('choice','model/selection',selection,{},1);
  journal.append('feedback/record',{text:'Review'});
  const native=[{seq:0,time:2,type:'user/message',data:message('large','user','canonical-only-'.repeat(20_000)),surfaceOp:'append'},
    {seq:1,time:3,type:'model/selection',data:selection}];
  const correlations=new Map([[1,'choice']]);journal.merge(native,correlations);
  const document=journal.encode(),state=JSON.parse(document);
  assert.equal(state.version,8);assert.equal(state.ownedEventCount,2);
  assert.equal(Object.hasOwn(state,'eventCount'),false);
  assert.equal(readJournalDocument(document).eventCount,3);
  assert.deepEqual(state.events.map(event=>event.seq),[0,1]);
  assert.equal(document.includes('canonical-only-'),false);
  assert.ok(Buffer.byteLength(document)<Buffer.byteLength(JSON.stringify(journal.session.snapshotEvents()))/100);
  const restore=(value=state,events=native)=>new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(JSON.stringify(value)),native:events});
  const cold=restore();cold.merge(native,correlations);
  assert.deepEqual(cold.session.snapshotEvents(),journal.session.snapshotEvents());
  assert.deepEqual(cold.session.eventAt(accepted.seq),accepted);
  assert.equal(cold.encode(),document);
  assert.throws(()=>restore(state,native.slice(0,1)),/prefix moved backwards/);
  const changed=[{...native[0],time:99},native[1]];
  assert.throws(()=>restore(state,changed).merge(changed,correlations),/prefix changed/);
  assert.throws(()=>restore({...state,ownedEventCount:3,events:[...state.events,journal.session.eventAt(2)]}),/Native-only event body/);
  assert.throws(()=>restore({...state,events:[state.events[0],state.events[0]]}),/local application event position/);
  assert.throws(()=>restore({...state,ownedEventCount:1,events:[state.events[1]]}),/lost its accepted event/);
  assert.throws(()=>restore({...state,eventCount:4}),/event count/);
  assert.throws(()=>restore({...state,ownedEventCount:3}),/event count/);
  assert.throws(()=>restore({...state,sources:[[4,1],[0,1]]}),/unowned event positions/);
  assert.throws(()=>restore({...state,sources:[[100_000,1],[0,1]]}),/source map/);
});

test('a cold catalog reads the atomic title prefix without parsing history and matches native creation identities',{skip:!root},async t=>{
  const {ctx,api,load}=await fixture(t),temporary=await mkdtemp(join(tmpdir(),'rsi-title-catalog-'));
  const privateRoot=join(temporary,'private'),directory=join(privateRoot,'sessions');
  t.after(()=>rm(temporary,{recursive:true,force:true}));
  let changes=0;
  const atomic=await load('dsh-atomic-write'),storage=sessionJournalStore(directory,atomic,()=>changes++);
  const nativeOnly=[{get id(){assert.fail('an empty journal directory needs no native identity lookups');}}];
  assert.equal(await storage.decorate(nativeOnly),nativeOnly);
  assert.equal(await storage.metadata(header.id),undefined);
  const child={...header,origin:'subagent',parentSession:'parent',delegationDepth:1,isSeeded:true};
  const journal=new SessionProjectionJournal(ctx,api,{header:child},{save:value=>storage.save(child.id,value)});
  const title='Side: 第一条会话',row={id:child.id,createdAt:child.createdAt};
  journal.accept('rename','session/title',{title,source:{kind:'user'},messageSeqs:[]});
  await journal.flush();
  const expected={...row,parent:'parent',projections:{kind:'cached',asOfSeq:0,values:{title}}};
  const unrelated={id:'native-only',createdAt:2};
  assert.deepEqual(await storage.decorate([unrelated,{...row}]),[unrelated,expected]);
  const packed=join(directory,'packed'),file=join(packed,(await readdir(packed))[0]);
  const bytes=await readFile(file),body=bytes.indexOf(10)+1,document=journal.encode();
  assert.equal(bytes.readUInt32LE(body),0xfd2fb528);
  assert.equal(await storage.read(child.id),document);
  if(process.platform!=='win32') {
    for(const path of [privateRoot,directory,packed])assert.equal((await stat(path)).mode&0o777,0o700&~process.umask());
    assert.equal((await stat(file)).mode&0o777,0o600&~process.umask());
  }
  assert.equal(changes,1);
  await storage.save(child.id,document);
  assert.equal(changes,1);
  const damaged=Buffer.from(bytes);
  damaged[damaged.length-1]^=1;
  await writeFile(file,damaged);
  const cold=sessionJournalStore(directory,atomic);
  assert.deepEqual(await cold.decorate([{...row}]),[expected]);
  const cancel=new AbortController(),closed=Error('listing closed'),part={...row};
  const pending=cold.decorate([part,{...row}],cancel.signal);
  cancel.abort(closed);
  await assert.rejects(pending,error=>error===closed);
  assert.deepEqual(part,row);
  assert.deepEqual(await cold.decorate([{...row,createdAt:7}]),[{...row,createdAt:7}]);
  await assert.rejects(cold.read(child.id));
  await writeFile(file,Buffer.concat([bytes,Buffer.from('x')]));
  await assert.rejects(cold.read(child.id),/trailing/i);
  await writeFile(file,bytes);
  assert.equal(JSON.parse(document).events[0].data.title,title);
  const saved=new SessionProjectionJournal(ctx,api,{header:child},{restore:readJournalDocument(document)});
  assert.deepEqual(saved.session.lastEvent('session/title'),journal.session.lastEvent('session/title'));
  const rename='Side: 换名';journal.accept('again','session/title',{title:rename,source:{kind:'user'},messageSeqs:[]});
  await journal.flush();assert.deepEqual((await storage.decorate([{...row}]))[0].projections,
    {kind:'cached',asOfSeq:1,values:{title:rename}});
  assert.equal((await readdir(packed)).length,1,'replacement leaves only the current journal');
  if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o777,0o600&~process.umask());
  assert.equal(changes,2);
  const manual={...header,parentSession:'parent',isSeeded:true};
  const unmarked=new SessionProjectionJournal(ctx,api,{header:manual},{save:value=>storage.save(manual.id,value)});
  unmarked.accept('ordinary-rename','session/title',{title,source:{kind:'user'},messageSeqs:[]});
  await unmarked.flush();
  assert.equal((await storage.decorate([{...row}]))[0].parent,undefined,'a title is not proof of a DSH subagent origin');
  const {catalogTitle,ownedEventCount,version,sourceDigest,...payload}=readJournalDocument(unmarked.encode());
  const legacy=JSON.stringify({version:1,...payload});
  const legacyDirectory=join(temporary,'old-store'),legacyName=createHash('sha256').update(manual.id).digest('hex')+'.json';
  await atomic.writeFileAtomic(join(legacyDirectory,legacyName),legacy,{mode:0o600,dirMode:0o700});
  const old=sessionJournalStore(legacyDirectory,atomic);
  assert.deepEqual(await old.decorate([{...row}]),[row]);
  assert.equal(await old.read(manual.id),legacy);
  await old.save(manual.id,unmarked.encode());
  assert.equal(await readFile(join(legacyDirectory,legacyName),'utf8'),unmarked.encode());
  assert.deepEqual(await readdir(legacyDirectory),[legacyName]);
  assert.deepEqual(new SessionProjectionJournal(ctx,api,{header:manual},{restore:readJournalDocument(legacy)}).session.header,manual);
});

test('native acknowledgement deltas retain the Surface and do no full history read',
  {skip:!root},async t=>{
    const {journal}=await fixture(t),count=512;
    journal.merge(Array.from({length:count},(_,seq)=>({seq,time:1,type:'model/selection',data:selection})));
    const accepted=Array.from({length:count},(_,i)=>journal.accept('choice-'+i,'model/selection',selection,{},2));
    const surface=journal.session.surface,snapshot=journal.session.snapshotEvents.bind(journal.session);
    let read=0;
    journal.session.snapshotEvents=(start=0,end=journal.seq)=>{
      assert.ok(start>=count*2,'acknowledgement must not snapshot existing events');return snapshot(start,end);
    };
    const eventAt=journal.session.eventAt.bind(journal.session);
    journal.session.eventAt=seq=>{read++;return eventAt(seq);};
    for(let i=0;i<count;i++){
      const seq=count+i;
      assert.deepEqual(journal.advance(seq,[{seq,time:3,type:'model/selection',data:selection}],new Map([[seq,'choice-'+i]])),[]);
      assert.equal(journal.operation('choice-'+i).source,seq);
    }
    assert.equal(read,count,'each acknowledgement reads only its correlated acceptance');
    assert.equal(journal.session.surface,surface,'acknowledgements preserve the incremental Surface cache');
    assert.equal(journal.seq,count*2);assert.equal(journal.nativeSeq,count*2);
    assert.equal(eventAt(count),accepted[0]);
  });

test('a failed mixed delta publishes neither source mappings nor earlier acknowledgements',
  {skip:!root},async t=>{
    const notices=[];
    const {journal}=await fixture(t,{notify:(_session,event)=>notices.push(event)});
    const first={seq:0,time:1,type:'model/selection',data:selection};journal.merge([first]);
    const accepted=journal.accept('choice','model/selection',selection,{},2);
    const before=journal.encode(),revision=journal.revision,operation=journal.operation('choice');
    const delta=[{...first,seq:1},{seq:2,time:3,type:'user/message',data:message('valid','user','valid'),surfaceOp:'append'},
      {seq:3,time:4,type:'user/message',data:message('invalid','user','invalid'),
        surfaceOp:{op:'replace',startSeq:2,endSeq:2},sourceEventSeqs:[]}];
    assert.throws(()=>journal.advance(1,delta,new Map([[1,'choice']])),/sourceEventSeqs|replacement|shadowed/i);
    assert.equal(journal.encode(),before);assert.equal(journal.revision,revision);
    assert.equal(journal.operation('choice'),operation);assert.equal(journal.sourceAt(1),undefined);
    assert.equal(journal.session.eventAt(accepted.seq),accepted);assert.equal(notices.length,2);
    assert.equal(journal.advance(1,delta.slice(0,2),new Map([[1,'choice']])).length,1);
    assert.equal(journal.sourceAt(1).seq,accepted.seq);assert.equal(journal.nativeSeq,3);
    assert.equal(journal.operation('choice').source,1);assert.equal(notices.length,3);
  });

test('a cold journal advances its immutable source rows without rewriting earlier identities',
  {skip:!root},async t=>{
    const {ctx,api,journal}=await fixture(t);
    const native=[{seq:0,time:1,type:'model/selection',data:selection}];journal.merge(native);
    journal.accept('choice','model/selection',selection,{},2);
    const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(journal.encode()),native});
    const source=cold.sourceAt(0),accepted=cold.session.eventAt(1);
    assert.ok(Object.isFrozen(source));
    cold.advance(1,[{seq:1,time:3,type:'model/selection',data:selection}],new Map([[1,'choice']]));
    cold.advance(2,[{seq:2,time:4,type:'model/selection',data:{...selection,model:'later'}}]);
    assert.equal(cold.sourceAt(0),source);assert.equal(cold.session.eventAt(1),accepted);
    const reloaded=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(cold.encode()),native:[...native,{seq:1,time:3,type:'model/selection',data:selection},{seq:2,time:4,type:'model/selection',data:{...selection,model:'later'}}]});
    assert.equal(reloaded.encode(),cold.encode());assert.equal(reloaded.operation('choice').source,1);
  });

test('observer failure is contained and reentrant mutation cannot change an accepted log',
  {skip:!root},async t=>{
    const reports=[];let journal,notifications=0;
    ({journal}=await fixture(t,{report:error=>reports.push(error.message),notify:(session,event)=>{
      assert.equal(session.eventAt(event.seq),event);notifications++;
      assert.throws(()=>journal.accept('reentrant','model/selection',selection),/Reentrant/);
      assert.throws(()=>journal.prepare('first',{}),/Reentrant/);
      throw Error('observer failed');
    }}));
    const first=journal.accept('first','model/selection',selection,{},1);
    assert.equal(first.seq,0);assert.equal(journal.seq,1);
    assert.equal(journal.accept('second','model/selection',selection,{},2).seq,1);
    assert.equal(notifications,2);assert.deepEqual(reports,['observer failed','observer failed']);
    assert.equal(journal.operations().length,2);
  });

test('flushes serialize immutable snapshots, join equal writes and retry failures without replaying native work',
  {skip:!root},async t=>{
    const gate=Promise.withResolvers(),writes=[];let fail=true;
    const {ctx,api,journal}=await fixture(t,{save:async value=>{
      writes.push(JSON.parse(value));if(writes.length===1)await gate.promise;
      if(fail)throw Error('disk unavailable');
    }});
    journal.accept('one','model/selection',selection,{},1);
    assert.equal(writes.length,0,'local acceptance performs no I/O');
    const first=journal.flush();assert.equal(journal.flush(),first);
    const failure=assert.rejects(first,/disk unavailable/);
    journal.accept('two','model/selection',{...selection,model:'second'},{},2);
    journal.prepare('two',{request_id:'two',revision:3});
    gate.resolve();await failure;
    fail=false;await journal.flush();
    assert.equal(writes[0].events.length,1);assert.equal(writes[1].events.length,2);
    const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(JSON.stringify(writes[1]))});
    assert.deepEqual(cold.operations()[1].invocation,{request_id:'two',revision:3});
    assert.equal(cold.operations()[1].receipt,undefined,'recovery retains prepared uncertainty instead of fabricating completion');
    assert.throws(()=>cold.prepare('two',{request_id:'fresh-id',revision:4}),/immutable/);
    assert.throws(()=>cold.complete('one',{}),/prepared invocation/);
    cold.complete('two',{control_seq:4});cold.complete('two',{control_seq:4});
    assert.throws(()=>cold.complete('two',{control_seq:5}),/immutable/);
  });

test('flushes behind a busy writer share the next durable snapshot', {skip:!root},async t=>{
  const gates=[Promise.withResolvers(),Promise.withResolvers()];
  const entered=gates.map(()=>Promise.withResolvers()),writes=[];
  const {ctx,api,journal}=await fixture(t,{save:async value=>{
    const index=writes.push(value)-1;
    if(gates[index]){entered[index].resolve();await gates[index].promise;}
  }});
  for(const gate of gates)t.after(()=>gate.resolve());
  const append=i=>journal.append('feedback/record',{text:'Note '+i});
  append(0);
  const first=journal.flush();
  await entered[0].promise;
  const waiting=[];
  for(let i=1;i<=24;i++){append(i);waiting.push(journal.flush());}
  let durable=false;
  const later=Promise.all(waiting).then(()=>{durable=true;});
  gates[0].resolve();
  await first;
  await entered[1].promise;
  assert.equal(durable,false);
  const second=readJournalDocument(writes[1]);
  assert.equal(second.ownedEventCount,25);
  append(25);
  const last=journal.flush();
  gates[1].resolve();
  await Promise.all([later,last]);
  assert.deepEqual(writes.map(value=>readJournalDocument(value).ownedEventCount),[1,25,26]);
  const cold=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(writes[2])});
  assert.deepEqual(cold.session.snapshotEvents(),journal.session.snapshotEvents());
});

test('invalid native batches and persisted correlations cannot partially publish or silently rewrite history',
  {skip:!root},async t=>{
    const {ctx,api,journal}=await fixture(t);
    journal.accept('choose','model/selection',selection,{},1);
    const before=journal.encode(),event={seq:0,time:2,type:'model/selection',data:selection};
    const orphan=JSON.parse(before);orphan.operations=[];
    assert.throws(()=>new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(JSON.stringify(orphan))}),/unowned event/);
    const misplaced=JSON.parse(before);
    for(const seq of ['0','length',1]){
      misplaced.operations[0].seq=seq;
      assert.throws(()=>new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(JSON.stringify(misplaced))}),/lost its accepted event/);
    }
    assert.throws(()=>journal.merge([event,{seq:1,time:2,type:'not-an-event',data:{}}]),/event envelope/);
    assert.equal(journal.encode(),before);
    assert.throws(()=>journal.merge([{...event,data:{...selection,model:'wrong'}}],new Map([[0,'choose']])),/disagrees/);
    assert.equal(journal.encode(),before);
    journal.merge([event],new Map([[0,'choose']]));
    const missing=JSON.parse(journal.encode());missing.events=[];missing.ownedEventCount=0;
    assert.throws(()=>new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(JSON.stringify(missing)),native:[event]}),/lost its accepted event/);
    const state=JSON.parse(journal.encode());state.operations[0].source=99;
    assert.throws(()=>new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(JSON.stringify(state)),native:[event]}),/mutation correlation/);
    state.operations[0].source=0;state.events[0].data.model='tampered';
    const corrupted=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(JSON.stringify(state)),native:[event]});
    assert.throws(()=>corrupted.merge([event],new Map([[0,'choose']])),/disagrees/);
  });

test('inherited history remains distinct from locally accepted mutation identities',
  {skip:!root},async t=>{
    const {ctx,api}=await fixture(t),seed={header:{...header,isSeeded:true,parentSession:'parent'}};
    const journal=new SessionProjectionJournal(ctx,api,seed);
    const inherited=[{seq:0,time:1,type:'user/message',data:message('parent','user','reference'),surfaceOp:'append'},
      {seq:1,time:2,type:'session/end-seed',data:{inherited:true}}];
    journal.merge(inherited,new Map(),1);
    const event=journal.accept('child-choice','model/selection',selection,{},3);
    assert.equal(journal.session.inheritedEventCount,1);assert.equal(journal.session.isOwnSeq(event.seq),true);
    assert.equal(journal.session.isOwnSeq(0),false);
    const before=journal.encode();assert.throws(()=>journal.merge(inherited,new Map(),2),/inherited prefix changed/);
    assert.equal(journal.encode(),before);
    const premature=new SessionProjectionJournal(ctx,api,seed);
    premature.accept('premature','model/selection',selection,{},1);
    assert.throws(()=>premature.merge(inherited,new Map(),1),/cannot enter an inherited prefix/);
    assert.equal(premature.seq,1);
  });

test('original atomic persistence restores an exact prepared invocation after an acknowledgement is lost',
  {skip:!root},async t=>{
    const {ctx,api,load}=await fixture(t),{writeFileAtomic}=await load('dsh-atomic-write');
    const directory=await mkdtemp(join(tmpdir(),'rsi-session-journal-'));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const file=join(directory,'session.json');let loseAck=true;
    const journal=new SessionProjectionJournal(ctx,api,{header},{save:async value=>{
      await writeFileAtomic(file,value,{mode:0o600});if(loseAck)throw Error('acknowledgement lost');
    }});
    journal.accept('choice','model/selection',selection,{},8);
    const invocation={command:'rsi.model-selection.command',request_id:'choice',
      expected_revision:{kind:'durable',control_seq:17},arguments:selection};
    journal.prepare('choice',invocation);
    await assert.rejects(journal.flush(),/acknowledgement lost/);
    const document=await readFile(file,'utf8');
    const reopened=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(document)});
    assert.deepEqual(reopened.operations()[0].invocation,invocation);
    assert.equal(reopened.operations()[0].receipt,undefined);
    assert.deepEqual(reopened.session.snapshotEvents(),journal.session.snapshotEvents());
    loseAck=false;await journal.flush();assert.equal(await readFile(file,'utf8'),document);
  });

test('live deltas preserve source cursors and a failed batch or stale branch cannot discard accepted events',
  {skip:!root},async t=>{
    const {journal}=await fixture(t),choice=journal.accept('choice','model/selection',selection,{},1);
    const first={seq:0,time:2,type:'user/message',data:message('one','user','one'),surfaceOp:'append'};
    journal.advance(0,[first]);
    const old=journal.session.eventAt(1),before=journal.encode();
    assert.throws(()=>journal.advance(0,[first]),/source cursor/);
    assert.throws(()=>journal.advance(1,[{...first,seq:2}]),/not dense/);
    assert.throws(()=>journal.advance(1,[{...first,seq:1},{seq:2,time:2,type:'invalid',data:{}}]),/event envelope/);
    assert.equal(journal.encode(),before);assert.equal(journal.session.eventAt(1),old);
    journal.advance(1,[{seq:1,time:3,type:'model/selection',data:selection}],new Map([[1,'choice']]));
    assert.equal(journal.session.eventAt(0),choice);assert.equal(journal.seq,2);
    assert.deepEqual(journal.advance(2,[]),[]);
    const branch=journal.session.branch();
    journal.accept('second','model/selection',{...selection,model:'second'},{},4);
    assert.throws(()=>journal.session.prepareBranch(branch),/lost its original prefix/);
    assert.equal(journal.seq,3);
  });

test('saved journals retain the native prefix that used predecessor-based inbox identities', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t),restore=(raw,native)=>new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(JSON.stringify(raw)),native});
  const native=[0,1].map(seq=>({type:'model/selection',seq,time:seq,data:selection}));
  journal.merge(native);
  const saved=JSON.parse(journal.encode());assert.equal(restore(saved,native).inboxSlotFrom,0);
  saved.version=1;saved.events=journal.session.snapshotEvents();delete saved.inboxSlotFrom;delete saved.ownedEventCount;
  delete saved.sourceDigest;saved.sources=Array.from({length:journal.nativeSeq},(_,index)=>journal.sourceAt(index));
  const cold=restore(saved,native);assert.equal(cold.inboxSlotFrom,2);
  cold.merge([...native,{...native[1],seq:2}]);
  assert.equal(restore(JSON.parse(cold.encode()),[...native,{...native[1],seq:2}]).inboxSlotFrom,2);
  assert.throws(()=>restore({...saved,inboxSlotFrom:3},native),/source boundary/);
  assert.throws(()=>restore({...saved,inboxSlotFrom:null},native),/source boundary/);
  assert.throws(()=>restore({...saved,eventCount:null},native),/event count/);
});
