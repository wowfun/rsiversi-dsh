import {randomUUID} from 'node:crypto';
import {MAX_FRAME_BYTES} from '../../../rsi-dsh-cordis/src/runtime/frames.mjs';

const integer=value=>Number.isSafeInteger(value)&&value>=0;
const capacity=64*1024*1024;

/** Captured pending work remains native; this reader never owns a scheduler. */
export function applicationInbox(call) {
  async function capture(id,signal) {
    const key=randomUUID();let bytes=0;
    const request=(operation,stop)=>call(id,operation,stop);
    async function read(operation) {
      let offset=0,total;const parts=[];
      do {
        signal?.throwIfAborted();
        const page=await request({...operation,key,offset},signal);
        const size=typeof page.json==='string'?Buffer.byteLength(page.json):-1;
        if(!integer(page.total_bytes)||page.total_bytes<2||page.total_bytes>36*1024*1024
          ||page.offset!==offset||!integer(page.next_offset)||page.next_offset<=offset
          ||page.next_offset>page.total_bytes||page.next_offset-offset!==size||size>MAX_FRAME_BYTES
          ||total!==undefined&&total!==page.total_bytes)throw Error('Invalid native inbox fragment');
        bytes+=size;if(bytes>capacity)throw Error('Native inbox exceeds retained response capacity');
        total=page.total_bytes;offset=page.next_offset;parts.push(page.json);
      }while(offset<total);
      return JSON.parse(parts.join(''));
    }
    const snapshot=await request({type:'open',key},signal);
    let failure;
    try {
      signal?.throwIfAborted();
      if(snapshot?.session_id!==id||!Array.isArray(snapshot.pending)||snapshot.pending.length>64)
        throw Error('Invalid native inbox snapshot');
      const ids=new Set();
      for(const row of snapshot.pending){
        if(typeof row.message_id!=='string'||ids.has(row.message_id))throw Error('Repeated native inbox identity');
        ids.add(row.message_id);
        const message=await read({type:'message',message_id:row.message_id});
        if(message.message_id!==row.message_id||message.source?.type!==row.source_kind)
          throw Error('Native inbox acceptance identity changed');
        row.message=message;
      }
      return snapshot;
    }catch(error){failure=error;throw error;}
    finally {
      try {if(snapshot?.pending?.length!==0)await request({type:'close',key},undefined);}
      catch(error){if(!failure)throw error;}
    }
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
