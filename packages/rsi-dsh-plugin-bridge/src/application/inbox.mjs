/** Pending work is read at one native cut; durable bodies belong to history. */
export function applicationInbox(call) {
  async function capture(id,signal) {
    const snapshot=await call(id,{type:'open'},signal);
    signal?.throwIfAborted();
    if(!['draft','durable'].includes(snapshot?.kind)||snapshot.session_id!==id||!Array.isArray(snapshot.pending)||snapshot.pending.length>64)
      throw Error('Invalid native inbox snapshot');
    const ids=new Set();
    for(const row of snapshot.pending){
      if(typeof row.message_id!=='string'||ids.has(row.message_id))throw Error('Repeated native inbox identity');
      ids.add(row.message_id);
      if(snapshot.kind==='draft'&&(row.message?.message_id!==row.message_id||row.message.source?.type!==row.source_kind))
        throw Error('Native inbox acceptance identity changed');
    }
    return snapshot;
  }
  return {capture,
    waitIdle:(id,signal)=>call(id,{type:'wait_idle'},signal),
    waitDraft:(id,revision,signal)=>call(id,{type:'wait_draft',revision},signal),
    discardDraft:(id,messageIds,signal)=>call(id,{type:'discard_draft',message_ids:messageIds},signal),
    mutate:(id,mutation,signal)=>call(id,{type:'mutate',mutation},signal),
    status:(id,operationId,signal)=>call(id,{type:'status',operation_id:operationId},signal),
    messageStatus:(id,messageId,signal)=>call(id,{type:'message_status',message_id:messageId},signal),
  };
}
