import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {readJournalDocument} from '../../src/session/journal-document.mjs';
import {SessionProjectionJournal} from '../../src/session/session-projection-journal.mjs';
import {SessionFacade} from '../../src/session/session.mjs';
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
  journal.append('approval/policy',{policy:'ask'});walks.length=0;
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
  journal.append('approval/policy',{policy:'ask'});
  journal.merge(source.snapshotEvents());
  assert.equal(journal.session.eventAt(1).seq,1);assert.equal(first.seq,0);
  assert.equal(journal.session.eventAt(1).data,first.data);
  assert.notEqual(journal.session.eventAt(1),first,'application positions own their envelopes');
  const saved=readJournalDocument(journal.encode());
  const cold=new SessionProjectionJournal(ctx,api,{header},{restore:saved,native:source.snapshotEvents(),nativeEventState:'shared-frozen'});
  cold.merge(source.snapshotEvents());
  assert.equal(cold.session.eventAt(1).data,first.data);
  assert.deepEqual(cold.session.snapshotEvents(),journal.session.snapshotEvents());
  saved.events[0].data.policy='changed outside';
  assert.equal(cold.session.eventAt(0).data.policy,'ask');
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
  journal.append('approval/policy',{policy:'ask'});
  journal.append('approval/asked',{id:'one',toolName:'bash',callId:'native-call'});
  journal.append('approval/decided',{id:'one',outcome:'allowed-once'});
  journal.append('session/title',title);
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

test('constructor annotations keep the original DSH inherited cut through deltas and cold replay', {skip:!root},async t=>{
  const {ctx,api,load}=await fixture(t);
  const {foldSubagentDescriptor,snapshotSubagentDescriptor}=await load('dsh-subagent');
  const child={...header,isSeeded:true,parentSession:'parent'};
  const descriptor=snapshotSubagentDescriptor({mode:'continuable',provider:'test',label:'Child'});
  const create=(document,native)=>new SessionProjectionJournal(ctx,api,{header:child},{restore:readJournalDocument(document),native});
  for(const prefix of [[],[{type:'session/end-seed',seq:0,time:1,data:{inherited:true}}]]) {
    const cut=prefix.length;
    const annotations=[{type:'working-directory/change',seq:cut,time:4,data:{cwd:process.cwd()},ignorable:true},
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
    journal.append('approval/policy',{policy:'ask'});
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
  journal.append('approval/policy',{policy:'ask'});
  const native=[{seq:0,time:2,type:'user/message',data:message('large','user','canonical-only-'.repeat(20_000)),surfaceOp:'append'},
    {seq:1,time:3,type:'model/selection',data:selection}];
  const correlations=new Map([[1,'choice']]);journal.merge(native,correlations);
  const document=journal.encode(),state=JSON.parse(document);
  assert.equal(state.version,6);assert.equal(state.ownedEventCount,2);
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
  assert.throws(()=>restore({...state,sources:state.sources.map((row,i)=>i?row:{...row,seq:4})}),/unowned event positions/);
  assert.throws(()=>restore({...state,sources:state.sources.map((row,i)=>i?row:{...row,seq:100_000})}),/source map/);
});

test('a cold catalog reads the atomic title prefix without parsing history and matches native creation identities',{skip:!root},async t=>{
  const {ctx,api,load}=await fixture(t),directory=await mkdtemp(join(tmpdir(),'rsi-title-catalog-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let changes=0;
  const atomic=await load('dsh-atomic-write'),storage=sessionJournalStore(directory,atomic,()=>changes++);
  const child={...header,origin:'subagent',parentSession:'parent',delegationDepth:1,isSeeded:true};
  const journal=new SessionProjectionJournal(ctx,api,{header:child},{save:value=>storage.save(child.id,value)});
  const title='Side: 第一条会话',row={id:child.id,createdAt:child.createdAt};
  journal.accept('rename','session/title',{title,source:{kind:'user'},messageSeqs:[]});
  await journal.flush();
  const expected={...row,parent:'parent',projections:{kind:'cached',asOfSeq:0,values:{title}}};
  const file=join(directory,(await readdir(directory))[0]),document=await readFile(file,'utf8');
  assert.equal(changes,1);
  await storage.save(child.id,document);
  assert.equal(changes,1);
  await writeFile(file,document.slice(0,document.indexOf('\n')+1)+'invalid history body');
  const cold=sessionJournalStore(directory,atomic);
  assert.deepEqual(await cold.decorate([{...row}]),[expected]);
  assert.deepEqual(await cold.decorate([{...row,createdAt:7}]),[{...row,createdAt:7}]);
  await writeFile(file,document);
  assert.equal(JSON.parse(document).events[0].data.title,title);
  const saved=new SessionProjectionJournal(ctx,api,{header:child},{restore:readJournalDocument(document)});
  assert.deepEqual(saved.session.lastEvent('session/title'),journal.session.lastEvent('session/title'));
  const rename='Side: 换名';journal.accept('again','session/title',{title:rename,source:{kind:'user'},messageSeqs:[]});
  await journal.flush();assert.deepEqual((await storage.decorate([{...row}]))[0].projections,
    {kind:'cached',asOfSeq:1,values:{title:rename}});
  assert.equal(changes,2);
  const manual={...header,parentSession:'parent',isSeeded:true};
  const unmarked=new SessionProjectionJournal(ctx,api,{header:manual},{save:value=>storage.save(manual.id,value)});
  unmarked.accept('ordinary-rename','session/title',{title,source:{kind:'user'},messageSeqs:[]});
  await unmarked.flush();
  assert.equal((await storage.decorate([{...row}]))[0].parent,undefined,'a title is not proof of a DSH subagent origin');
  const {catalogTitle,ownedEventCount,version,...payload}=readJournalDocument(unmarked.encode());
  const legacy=JSON.stringify({version:1,...payload});
  await writeFile(file,legacy);
  assert.deepEqual(await sessionJournalStore(directory,atomic).decorate([{...row}]),[row]);
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

test('invalid native batches and persisted correlations cannot partially publish or silently rewrite history',
  {skip:!root},async t=>{
    const {ctx,api,journal}=await fixture(t);
    journal.accept('choose','model/selection',selection,{},1);
    const before=journal.encode(),event={seq:0,time:2,type:'model/selection',data:selection};
    const orphan=JSON.parse(before);orphan.operations=[];
    assert.throws(()=>new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(JSON.stringify(orphan))}),/unowned event/);
    assert.throws(()=>journal.merge([event,{seq:1,time:2,type:'not-an-event',data:{}}]),/event envelope/);
    assert.equal(journal.encode(),before);
    assert.throws(()=>journal.merge([{...event,data:{...selection,model:'wrong'}}],new Map([[0,'choose']])),/disagrees/);
    assert.equal(journal.encode(),before);
    journal.merge([event],new Map([[0,'choose']]));
    const state=JSON.parse(journal.encode());state.operations[0].source=99;
    assert.throws(()=>new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(JSON.stringify(state)),native:[event]}),/mutation record/);
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
    assert.throws(()=>journal.session.adoptBranch(branch),/lost its original prefix/);
    assert.equal(journal.seq,3);
  });

test('saved journals retain the native prefix that used predecessor-based inbox identities', {skip:!root},async t=>{
  const {ctx,api,journal}=await fixture(t),restore=(raw,native)=>new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(JSON.stringify(raw)),native});
  const native=[0,1].map(seq=>({type:'model/selection',seq,time:seq,data:selection}));
  journal.merge(native);
  const saved=JSON.parse(journal.encode());assert.equal(restore(saved,native).inboxSlotFrom,0);
  saved.version=1;saved.events=journal.session.snapshotEvents();delete saved.inboxSlotFrom;delete saved.ownedEventCount;
  const cold=restore(saved,native);assert.equal(cold.inboxSlotFrom,2);
  cold.merge([...native,{...native[1],seq:2}]);
  assert.equal(restore(JSON.parse(cold.encode()),[...native,{...native[1],seq:2}]).inboxSlotFrom,2);
  assert.throws(()=>restore({...saved,inboxSlotFrom:3},native),/source boundary/);
  assert.throws(()=>restore({...saved,inboxSlotFrom:null},native),/source boundary/);
  assert.throws(()=>restore({...saved,eventCount:null},native),/event count/);
});
