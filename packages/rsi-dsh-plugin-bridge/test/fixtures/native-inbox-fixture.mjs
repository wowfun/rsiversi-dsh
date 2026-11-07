import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {RemoteRequestError} from '../../../rsi-dsh-cordis/src/runtime/transport.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {workbenchHistory} from '../../src/workbench/history.mjs';
import {workbenchAgents} from '../../src/workbench/agents.mjs';
import {invocationDigest} from '../../src/session/command-receipts.mjs';
import {contextRequest} from '../../src/session/inbox/input-invocation.mjs';
import {historyPage} from './history-page.mjs';

export function contextIntent(command,expected_revision,id,event) {
  const invocation={command,expected_revision};
  return {kind:'context-input',...invocation,sha256:invocationDigest(contextRequest({id,invocation},event))};
}

export function nativeMessagePage(message,op) {
  return historyPage(message,op.accepted_control_seq,op.offset);
}

export const message=(id,text=id)=>({id,role:'user',source:{kind:'plugin:test',tag:{n:1}},content:[{type:'text',text},{type:'text',text:'第二块'}]});
export async function nativeInboxFixture(t,{kind='draft',pending=[]}={}) {
  const root=process.env.RSI_DSH_MARKET_COHORT,require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();
  await ctx.plugin((await load('dsh-session-projection')).default);
  await ctx.plugin((await load('dsh-agent')).AgentRegistry);
  const directory=await mkdtemp(join(tmpdir(),'rsi-public-inbox-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const outfile=join(directory,'inbox.mjs');
  const {build}=await import('esbuild');
  await build({entryPoints:[process.env.RSI_DSH_INBOX_SOURCE],outfile,bundle:true,format:'esm',platform:'node',
    nodePaths:[join(root,'node_modules')],logLevel:'silent'});
  ctx.sessionProjections.register((await import(pathToFileURL(outfile))).inboxProjectionDefinition);
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  const state={kind,revision:1,control:0,pending:structuredClone(pending),controls:[],messages:new Map(),receipts:new Map(),submissions:new Map(),
    executeGate:undefined,withdrawGate:undefined,saveGate:undefined,failExecute:undefined,failWithdraw:undefined,failSave:false};
  const calls=[],waiters=new Set(),documents=new Map(),draftOwners=new Set(),baseline={model:{deployment:'native',model:'configured'}};
  const cursor=()=>({fact_seq:0,control_seq:state.control});
  const changed=()=>{for(const wake of waiters)wake();};
  const control=body=>{state.controls.push({seq:++state.control,after_fact_seq:0,time:state.control,...body});changed();};
  for(const row of state.pending) {
    state.messages.set(row.message_id,row.message);
    if(kind==='durable')control({kind:'accepted',message_id:row.message_id,target:row.target});
  }
  const meta=()=>({id:'one',created_at:1,cwd:process.cwd(),inherited:false,through:0,model_baseline:baseline,model_selection:baseline,
    selection_cursor:state.kind==='draft'?{kind:'draft',revision:state.revision}:{kind:'durable',...cursor()}});
  const snapshot=()=>structuredClone({kind:state.kind,session_id:'one',pending:state.pending,active_turn_id:state.activeTurn?'turn':null,
    driver_active:!!(state.activeTurn||state.activationActive||(!state.paused&&state.pending.some(row=>row.target==='next_turn'))),
    ...(state.kind==='draft'?{revision:state.revision}:{cursor:cursor(),history:meta()})});
  const read=async(id,op,signal)=>{
    assert.equal(id,'one');signal?.throwIfAborted();
    if(op.type==='open')return meta();
    if(op.type==='controls'){
      const through=Math.min(op.after_seq+64,op.through_seq);
      return historyPage(state.controls.filter(row=>row.seq>op.after_seq&&row.seq<=through)
        .map(row=>row.kind==='accepted'?{...row,message:state.messages.get(row.message_id)}:row),through,op.offset);
    }
    if(op.type==='message')return nativeMessagePage(state.messages.get(op.message_id),op);
    assert.equal(op.type,'wait');if(op.cursor.control_seq<state.control)return cursor();
    return new Promise((resolve,reject)=>{
      const done=()=>{waiters.delete(done);signal?.removeEventListener('abort',aborted);resolve(cursor());};
      const aborted=()=>{waiters.delete(done);reject(signal.reason);};
      waiters.add(done);signal?.addEventListener('abort',aborted,{once:true});
    });
  };
  let agents;
  const scope=applicationSessions(async(method,args,signal)=>{
    const op=args.operation;calls.push({method,op:structuredClone(op),args:structuredClone(args)});
    if(method==='application.history')return read(args.session_id,op,signal);
    if(method==='application.cancel') {
      await state.cancelGate?.promise;
      if(state.failCancel==='before')throw Error('cancel outcome unknown');
      if(args.inbox_only||!args.keep_inbox) {
        const pending=state.pending;state.pending=[];
        if(pending.length&&state.kind==='draft')state.revision++;
        if(state.kind==='durable')for(const row of pending)control({kind:'discarded',message_id:row.message_id});
      }
      if(!args.inbox_only){state.cancelled=true;state.activeTurn=false;state.paused=true;}
      changed();
      if(state.failCancel==='after')throw Error('cancel reply lost');
      return {session_id:args.session_id};
    }
    if(method==='application.command') {
      if(op.type==='list')return {commands:[{id:'native-context',name:'context-input'}],revision:meta().selection_cursor.kind==='draft'
        ?{kind:'draft',revision:state.revision}:{kind:'durable',control_seq:state.control}};
      if(op.type==='status')return state.receipts.get(op.request_id)??null;
      await state.executeGate?.promise;
      if(state.failExecute==='before')throw Error('execution outcome unknown');
      const {invocation}=op,prior=state.receipts.get(invocation.request_id);if(prior)return prior;
      const hash=invocationDigest(invocation),id=`command-${hash}-0`,{attribution,content}=invocation.arguments;
      const source={type:'command',source:{command:invocation.command,request_id:invocation.request_id,invocation_sha256:hash,ordinal:0,attribution}};
      const native={message_id:id,source,content};state.messages.set(id,native);
      const row={message_id:id,target:'next_step',source_kind:'command',queue_slot:{id},message:native};state.pending.push(row);
      const receipt={command:invocation.command,request_id:invocation.request_id,invocation_sha256:hash,state_sha256:'a'.repeat(64),
        outcome:state.kind==='draft'?{kind:'draft_changed',revision:++state.revision}:{kind:'committed',control_seq:++state.control}};
      if(state.kind==='durable')control({kind:'accepted',message_id:id,target:'next_step'});
      state.receipts.set(invocation.request_id,receipt);
      if(state.failExecute==='after')throw Error('command reply lost');return receipt;
    }
    if(method==='application.inbox') {
      if(op.type==='wait_idle') {
        await state.idleGate?.promise;
        const busy=()=>state.activeTurn||state.activationActive||(!state.paused&&state.pending.some(row=>row.target==='next_turn'));
        if(!busy())return null;
        return new Promise((resolve,reject)=>{
          const done=()=>{if(busy())return;waiters.delete(done);signal?.removeEventListener('abort',aborted);resolve(null);};
          const aborted=()=>{waiters.delete(done);reject(signal.reason);};
          waiters.add(done);signal?.addEventListener('abort',aborted,{once:true});
        });
      }
      if(op.type==='retain_draft'){if(state.kind!=='draft')return false;draftOwners.add(op.key);return true;}
      if(op.type==='release_draft'){draftOwners.delete(op.key);return null;}
      if(op.type==='wait_draft') {
        if(state.kind!=='draft'||state.revision!==op.revision)return null;
        return new Promise((resolve,reject)=>{
          const done=()=>{if(state.kind==='draft'&&state.revision===op.revision)return;
            waiters.delete(done);signal?.removeEventListener('abort',aborted);resolve(null);};
          const aborted=()=>{waiters.delete(done);reject(signal.reason);};
          waiters.add(done);signal?.addEventListener('abort',aborted,{once:true});
        });
      }
      if(op.type==='message_status') {
        await state.statusGate?.promise;
        return state.submissions.get(op.message_id)?.receipt??null;
      }
      await state.withdrawGate?.promise;
      if(state.failWithdraw==='io')throw Error('storage unavailable');
      if(op.type==='discard_draft') {
        if(state.failWithdraw==='publish') {
          state.kind='durable';for(const row of state.pending)control({kind:'accepted',message_id:row.message_id,target:row.target});
          throw Error('unpublished draft not found');
        }
        const prior=state.pending.length;state.pending=state.pending.filter(row=>!op.message_ids.includes(row.message_id));
        if(prior!==state.pending.length)state.revision++;
        if(state.failWithdraw==='discard-then-publish') {state.kind='durable';throw Error('draft discard reply lost');}
        return {revision:state.revision};
      }
      assert.equal(op.type,'mutate');const mutation=op.mutation;
      if(state.failWithdraw==='claimed') {
        for(const row of state.pending)control({kind:'claimed',message_id:row.message_id});state.pending=[];
      }
      const row=state.pending.find(row=>row.message_id===mutation.expected_message_id);
      if(row){state.pending=state.pending.filter(item=>item!==row);control({kind:'discarded',message_id:row.message_id});}
      return {operation_id:mutation.operation_id,slot_id:mutation.slot_id,expected_message_id:mutation.expected_message_id,
        request_fingerprint:createHash('sha256').update('rsi.queue-mutation.v1\0').update(JSON.stringify(mutation)).digest('hex'),
        control_seq:++state.control,outcome:row?{result:'withdrawn'}:{result:'rejected',
          reason:state.controls.some(event=>event.kind==='accepted'&&event.message_id===mutation.expected_message_id)?'claimed':'missing_slot',
          current_message_id:mutation.expected_message_id}};
    }
    if(method==='application.submit') {
      await state.submitGate?.promise;
      if(state.failSubmit==='before')throw Error('submission outcome unknown');
      if(state.failSubmit==='rejected')throw new RemoteRequestError('mailbox refused');
      const {request,...input}=args,prior=state.submissions.get(args.message_id);
      if(prior){assert.deepEqual(prior.input,input);return prior.receipt;}
      if(args.delivery!=='next_step')state.paused=false;
      if(state.kind==='draft') {state.kind='durable';for(const row of state.pending)control({kind:'accepted',message_id:row.message_id,target:row.target});}
      const native={message_id:args.message_id,source:{type:args.origin==='application'?'application':'human',attribution:args.attribution},
        content:args.content.map(({kind,...part})=>({type:kind,...part}))};state.messages.set(args.message_id,native);
      const target=args.delivery==='next_step'||args.delivery==='steer'&&state.activeTurn?'next_step':'next_turn';
      state.pending.push({message_id:args.message_id,source_kind:native.source.type,target,queue_slot:{id:args.message_id},message:native});
      control({kind:'accepted',message_id:args.message_id,target});
      const receipt={session_id:'one',message_id:args.message_id,accepted_control_seq:state.control};
      state.submissions.set(args.message_id,{input,receipt});
      if(args.delivery!=='next_step'&&!state.holdSubmissions){for(const row of state.pending)control({kind:'claimed',message_id:row.message_id});state.pending=[];}
      if(state.failSubmit==='after')throw Error('submission reply lost');
      if(state.failSubmit==='committed-error')throw new RemoteRequestError('reply failed after commit');
      return receipt;
    }
    throw Error(method);
  },{owner:'owner',agent:id=>agents?.get(id)});
  scope.inbox.capture=async()=>snapshot();
  const options={ctx,api,llm:await load('dsh-llm'),read,authorize:async()=>{},listChildren:async()=>[],command:scope.command,submit:scope.submit,inbox:scope.inbox,
    storage:{read:async id=>documents.get(id),save:async(id,value)=>{await state.saveGate?.promise;if(state.failSave)throw Error('disk unavailable');documents.set(id,value);}}};
  const history=workbenchHistory(options);agents=await workbenchAgents(ctx,scope,history,await load('dsh-scope'),await load('dsh-agent'),api.snapshotJsonValue);
  const agent=await scope.runOwned(()=>agents.ensure('one'));
  t.after(async()=>{state.executeGate?.resolve();state.withdrawGate?.resolve();state.saveGate?.resolve();state.submitGate?.resolve();state.statusGate?.resolve();state.cancelGate?.resolve();await ctx.fiber.dispose();await history.close();await scope.close();});
  return {ctx,scope,history,agent,agents,state,calls,options,documents,snapshot,control,changed,
    observerWaiters:()=>waiters.size,draftOwners,
    owner:history.owner((await history.capture('one',meta()))),
    projection:()=>ctx.sessionProjections.snapshot(agent.session).values.inbox,
    refresh:()=>scope.runOwned(()=>agents.refresh('one')),
  };
}
