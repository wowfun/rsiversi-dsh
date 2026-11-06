import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {workbenchInbox} from '../../src/workbench/inbox.mjs';
import {workbenchHistory} from '../../src/workbench/history.mjs';
import {SessionFacade} from '../../src/session/session.mjs';
import {inputMessage,observeInput} from '../../src/history/conversation-history.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT,source=process.env.RSI_DSH_INBOX_SOURCE;
async function fixture(t) {
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();t.after(()=>ctx.fiber.dispose());
  await ctx.plugin((await load('dsh-session-projection')).default);
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  return {ctx,api,llm:await load('dsh-llm')};
}
function fragment(value,seq,offset) {
  const bytes=Buffer.from(JSON.stringify(value));let end=Math.min(offset+130_000,bytes.length);
  while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
  return {through_seq:seq,offset,next_offset:end,total_bytes:bytes.length,json:bytes.subarray(offset,end).toString('utf8')};
}
for(const sourceType of ['command','human'])test(`${sourceType} inbox transitions agree with the original DSH fold across replacement, promotion, claim and discard`,
  {skip:!root||!source},async t=>{
    const {ctx,api}=await fixture(t);
    const directory=await mkdtemp(join(tmpdir(),'rsi-inbox-fold-'));t.after(()=>rm(directory,{recursive:true,force:true}));
    const outfile=join(directory,'inbox.mjs');
    const {build}=await import('esbuild');
    await build({entryPoints:[source],outfile,bundle:true,format:'esm',platform:'node',
      nodePaths:[join(root,'node_modules')],logLevel:'silent'});
    const {inboxProjectionDefinition}=await import(pathToFileURL(outfile));
    ctx.sessionProjections.register(inboxProjectionDefinition);
    const session=new SessionFacade(ctx,api,{header:{version:4,id:'test',createdAt:1,isSeeded:false}});
    let inbox=workbenchInbox();const reads=[];
    const messages=new Map(['a','b','c','a2','b2'].map(id=>[id,{message_id:id,source:{type:'human'},
      content:[{type:'text',text:id==='c'?'界'.repeat(100_000):id}]}]));
    const attribution={id:'original:c',source:{kind:'plugin:sidechat',nested:{value:'原始来源'}}};
    messages.get('c').source=sourceType==='command'?{type:'command',source:{attribution}}:{type:'human',attribution};
    messages.get('c').content.push({type:'text',text:'separate second block'});
    const call=async op=>{reads.push(op);return fragment(messages.get(op.message_id),op.accepted_control_seq,op.offset);};
    const controls=[
      {kind:'accepted',message_id:'a',target:'next_turn',time:100},
      {kind:'accepted',message_id:'b',target:'next_turn',time:200},
      {kind:'accepted',message_id:'c',target:'next_step',time:50},
      {kind:'successor',predecessor_id:'a',successor_id:'a2',slot:{id:'a',timestamp_ms:100,control_seq:1}},
      {kind:'accepted',message_id:'a2',target:'next_turn',time:1},
      {kind:'promoted',message_id:'c'},
      {kind:'successor',predecessor_id:'b',successor_id:'b2',slot:{id:'b',timestamp_ms:200,control_seq:2}},
      {kind:'accepted',message_id:'b2',target:'next_turn',time:2},
      {kind:'claimed',message_id:'c',turn_id:'turn'},
      {kind:'discarded',message_id:'a2'},
      {kind:'claimed',message_id:'b2',turn_id:'turn'},
    ];
    for(const [index,control] of controls.entries()) {
      session.begin();try{await inbox.observe({time:300,...control,seq:index+1},session,call,undefined,1);}finally{session.end();}
      inbox=inbox.branch();
      assert.deepEqual(ctx.sessionProjections.snapshot(session).values.inbox,inbox.snapshot());
      for(const [seq,transition] of inbox.transitions)for(const [position,row] of transition.inserted.entries())
        assert.equal(row.message,session.eventAt(seq).data.inserted[position],'transitions retain the admitted frozen message');
      if(index===4)assert.deepEqual(inbox.snapshot()['next-turn'].map(row=>row.id),['a','b']);
      if(index===7)assert.deepEqual(inbox.snapshot()['next-turn'].map(row=>row.id),['a','b','original:c']);
    }
    assert.equal(reads.filter(op=>op.message_id==='c').length,3,'native input larger than 256 KiB crosses fragments without a mirror-specific rejection');
    const notices=[...inbox.transitions.values()].flatMap(row=>row.notifications??[]);
    assert.deepEqual(notices.filter(row=>row.type==='agent/inbox/claimed').map(row=>[row.data.message.id,row.data.turn]),[['original:c',1],['b',1]]);
    assert.ok(notices.every(row=>Object.isFrozen(row.data.message)));
    const replay=new SessionFacade(ctx,api,{header:session.header,events:JSON.parse(JSON.stringify(session.snapshotEvents()))});
    assert.deepEqual(ctx.sessionProjections.snapshot(replay).values.inbox,{'next-step':[],'next-turn':[]});
    const consumed=new SessionFacade(ctx,api,{header:{version:4,id:'independent-fork',createdAt:1,isSeeded:false}});
    consumed.begin();try{observeInput(consumed,{turn:1,step:1},
      inputMessage(consumed.id,{seq:12,type:'input_message_claimed',source:{...messages.get('c').source,message_id:'c'},content:messages.get('c').content}),400);}
    finally{consumed.end();}
    const message=consumed.lastEvent('user/message').data;
    assert.deepEqual(message,{id:attribution.id,role:'user',source:attribution.source,content:messages.get('c').content});
    assert.deepEqual(message,notices.find(row=>row.type==='agent/inbox/claimed').data.message,
      'accepted and independently consumed messages retain exactly the same original envelope');
  });

test('saved inbox prefix reopens with its published IDs and switches to stable slots for later edits', {skip:!root},async t=>{
  const {ctx,api}=await fixture(t);
  const session=new SessionFacade(ctx,api,{header:{version:4,id:'saved',createdAt:1,isSeeded:false}});
  const inbox=workbenchInbox(),accepted=(id,seq)=>({kind:'accepted',target:'next_turn',message_id:id,seq,time:seq});
  const successor=(from,to,seq)=>({kind:'successor',predecessor_id:from,successor_id:to,slot:{id:'a'},seq,time:seq});
  const events=[accepted('a',1),accepted('b',2),successor('a','a2',3),accepted('a2',4),
    successor('a2','a3',5),accepted('a3',6),accepted('c',7),successor('a3','a4',8),accepted('a4',9)];
  for(const event of events){
    const call=async op=>fragment({message_id:op.message_id,source:{type:'human'},content:[{type:'text',text:op.message_id}]},op.accepted_control_seq,op.offset);
    session.begin();try{await inbox.observe(event,session,call,undefined,1,4);}finally{session.end();}
    if(event.seq===4)assert.deepEqual(inbox.snapshot()['next-turn'].map(r=>r.id),['b','a2']);
    if(event.seq===6)assert.deepEqual(inbox.snapshot()['next-turn'].map(r=>r.id),['b','a']);
  }
  assert.deepEqual(inbox.snapshot()['next-turn'].map(r=>[r.id,r.content[0].text]),[['b','b'],['a','a4'],['c','c']]);
});

test('control-only acceptance and withdrawal notify subscribers and replay at the same Session cursors',
  {skip:!root},async t=>{
    const {ctx,api,llm}=await fixture(t),baseline={model:{deployment:'native',model:'configured'}};
    let control=1,waiter=Promise.withResolvers();
    const events=[{kind:'accepted',seq:1,after_fact_seq:0,time:100,message_id:'one',target:'next_step'},
      {kind:'discarded',seq:2,after_fact_seq:0,time:1,message_id:'one'}];
    const history=workbenchHistory({ctx,api,llm,authorize:async()=>{},async read(id,op){
      if(op.type==='open')return {id,created_at:1,through:0,inherited:false,model_baseline:baseline,
        model_selection:baseline,selection_cursor:{kind:'durable',fact_seq:0,control_seq:control}};
      if(op.type==='controls')return {through:op.through_seq,events:events.filter(event=>event.seq>op.after_seq&&event.seq<=op.through_seq)};
      if(op.type==='message')return fragment({message_id:'one',source:{type:'human'},content:[{type:'text',text:'pending'}]},1,op.offset);
      assert.equal(op.type,'wait');return waiter.promise;
    }});
    const life=new AbortController(),request={address:{kind:'session',sessionId:'test'},maxMessages:50};
    const flow=history.follow(request,life.signal),initial=(await flow.next()).value;
    assert.equal(initial.projections.values.inbox['next-step'][0].id,'one');
    const next=flow.next();control=2;waiter.resolve({fact_seq:0,control_seq:control});waiter=Promise.withResolvers();
    const change=(await next).value.event;
    assert.equal(change.type,'agent/inbox/spliced');assert.equal(change.data.outcome,'canceled');
    assert.equal(change.seq,initial.cursor+1);assert.equal(change.time,1);
    const reopened=history.follow(request,life.signal),current=(await reopened.next()).value;
    assert.deepEqual(current.records.map(row=>row.event),[...initial.records.map(row=>row.event),change]);
    assert.deepEqual(current.projections.values.inbox,{'next-step':[],'next-turn':[]});
    life.abort();await flow.return();await reopened.return();
  });
