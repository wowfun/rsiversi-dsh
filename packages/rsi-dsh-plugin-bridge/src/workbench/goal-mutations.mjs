import {randomUUID} from 'node:crypto';
import {loaderEntry} from './subagents.mjs';
import {commandReceipt} from '../session/command-receipts.mjs';

/** Keep attribution on the original Goal service's own synchronous append. */
export function workbenchGoalMutations(Runtime,caller,disarm) {
  let mutation;
  function invoke(service,agent,operation,run,edit) {
    const ctx=service[caller],entry=loaderEntry(ctx);
    if(!entry)throw Error('Goal mutation requires a Cordis plugin entry');
    ctx.fiber.assertActive();
    const previous=mutation;
    mutation={agent,service,operation,name:entry.options.name,edit};
    try{return run();}finally{mutation=previous;}
  }
  return {
    Runtime:class extends Runtime {
      create(agent,spec){return invoke(this,agent,'create',()=>super.create(agent,spec));}
      edit(agent,ref,spec){return invoke(this,agent,'edit',()=>super.edit(agent,ref,spec),spec);}
      clear(agent,ref){return invoke(this,agent,'clear',()=>super.clear(agent,ref));}
      pause(agent,ref){return invoke(this,agent,'pause',()=>super.pause(agent,ref));}
      resume(agent,ref){return invoke(this,agent,'resume',()=>super.resume(agent,ref));}
      block(agent,ref,reason){return invoke(this,agent,'block',()=>super.block(agent,ref,reason));}
      complete(agent,ref){return invoke(this,agent,'complete',()=>super.complete(agent,ref));}
      disarm(agent) {
        const ctx=this[caller];
        // Cordis retains the committed injections until the plugin's disposers settle.
        if(!loaderEntry(ctx)||!ctx.fiber.committed)throw Error('Goal disarm requires a live Cordis plugin');
        super.get(agent); // Validate the exact Agent before addressing the Host by id.
        disarm(agent.id);
        return super.disarm(agent);
      }
    },
    commit(record,scope,change,opts,stage,publish) {
      if(mutation?.agent!==record.agent||mutation.operation!==change.operation)
        throw Error('Goal changes require their owning Goal service');
      const {name,operation,service,edit}=mutation;
      mutation=undefined;
      const goal=change.goal,action={action:operation,id:(goal??change.cleared).id};
      const publishedAt=change.updatedAt??change.clearedAt;
      // The receipt binds JSON field order, including when a pure create is later armed.
      if(operation==='create')Object.assign(action,{objective:goal.objective,constraints:'',max_rounds:goal.maxGoalRounds});
      if(operation==='edit'){
        if(edit.objective!==undefined)action.objective=goal.objective;
        if(edit.maxGoalRounds!==undefined)action.max_rounds=goal.maxGoalRounds;
      }
      if(operation==='complete')action.source={kind:'plugin',name};
      if(operation==='block')Object.assign(action,goal.blockedReason);
      const captured=record.owner.meta.selection_cursor;
      const expected=captured.kind==='draft'&&record.controlSeq===undefined
        ?{kind:'draft',revision:captured.revision}
        :{kind:'durable',control_seq:Math.max(captured.control_seq??0,record.controlSeq??0)};
      const time=Date.now(),id=randomUUID();
      const journal=record.owner.journal;
      let event,accepted;
      stage(record,async signal=>{
        if(!event||journal.session.lastEvent('goal/change')?.seq!==event.seq)return false;
        if(!['create','resume','edit'].includes(operation)||service.get(record.agent)?.activation!=='armed')return;
        const {live}=await scope.command(record.id,{type:'goal',control:accepted.control},signal);
        if(!live.armed&&journal.session.lastEvent('goal/change')?.seq===event.seq)Runtime.prototype.disarm.call(service,record.agent);
      });
      accepted=scope.commitControl(record.id,{
        request_id:id,expected_revision:expected,action,published_at_ms:publishedAt});
      const {control,receipt}=accepted;
      commandReceipt({id,invocation:{command:'rsi.goal.command',request_id:id,
        expected_revision:control.expected_revision,arguments:{...action,published_at_ms:publishedAt}}},receipt);
      record.controlSeq=receipt.outcome.control_seq;
      event=journal.accept(id,'goal/change',change,opts,time);
      publish(record);
      return event;
    },
  };
}
