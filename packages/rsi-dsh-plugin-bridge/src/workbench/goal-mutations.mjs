import {randomUUID} from 'node:crypto';
import {loaderEntry} from './subagents.mjs';
import {commandReceipt} from '../session/command-receipts.mjs';

/** Keep attribution on the original Goal service's own synchronous append. */
export function workbenchGoalMutations(Runtime,caller) {
  let mutation;
  function invoke(service,agent,operation,run) {
    const ctx=service[caller],entry=loaderEntry(ctx);
    if(!entry)throw Error('Goal mutation requires a Cordis plugin entry');
    ctx.fiber.assertActive();
    const previous=mutation;
    mutation={agent,service,operation,name:entry.options.name};
    try{return run();}finally{mutation=previous;}
  }
  return {
    Runtime:class extends Runtime {
      create(agent,spec){return invoke(this,agent,'create',()=>super.create(agent,spec));}
      pause(agent,ref){return invoke(this,agent,'pause',()=>super.pause(agent,ref));}
      resume(agent,ref){return invoke(this,agent,'resume',()=>super.resume(agent,ref));}
      complete(agent,ref){return invoke(this,agent,'complete',()=>super.complete(agent,ref));}
    },
    commit(record,scope,change,opts,stage,publish) {
      if(mutation?.agent!==record.agent||mutation.operation!==change.operation)
        throw Error('Goal changes require their owning Goal service');
      const {name,operation,service}=mutation;
      mutation=undefined;
      const goal=change.goal,action={action:operation,id:goal.id};
      // The receipt binds JSON field order, including when a pure create is later armed.
      if(operation==='create')Object.assign(action,{objective:goal.objective,constraints:'',max_rounds:goal.maxGoalRounds});
      if(operation==='complete')action.source={kind:'plugin',name};
      const captured=record.owner.meta.selection_cursor;
      const expected=captured.kind==='draft'&&record.goalControlSeq===undefined
        ?{kind:'draft',revision:captured.revision}
        :{kind:'durable',control_seq:Math.max(captured.control_seq??0,record.goalControlSeq??0)};
      const time=Date.now(),id=randomUUID();
      const journal=record.owner.journal;
      let event,accepted;
      stage(record,async signal=>{
        if(!event||journal.session.lastEvent('goal/change')?.seq!==event.seq)return false;
        if(operation!=='create'&&operation!=='resume')return;
        const {live}=await scope.command(record.id,{type:'goal',control:accepted.control},signal);
        if(!live.armed&&journal.session.lastEvent('goal/change')?.seq===event.seq)service.disarm(record.agent);
      });
      accepted=scope.commitGoal(record.id,{
        request_id:id,expected_revision:expected,action,published_at_ms:change.updatedAt});
      const {control,receipt}=accepted;
      commandReceipt({id,invocation:{command:'rsi.goal.command',request_id:id,
        expected_revision:control.expected_revision,arguments:{...action,published_at_ms:change.updatedAt}}},receipt);
      record.goalControlSeq=receipt.outcome.control_seq;
      event=journal.accept(id,'goal/change',change,opts,time);
      publish(record);
      return event;
    },
  };
}
