import {randomUUID} from 'node:crypto';

export async function updateQueue({sessionId,itemId,action},inbox,history,RemoteError,signal) {
  const missing=()=>new RemoteError('session/queue-item-not-found','queued item is no longer pending',{itemId});
  const noSteer=()=>new RemoteError('session/steer-unavailable','current turn no longer accepts steering',{itemId});
  if(action.kind==='edit') {
    if(action.content.some(block=>block.type!=='text'))
      throw new RemoteError('session/attachment-invalid','queue edits accept text content only',{reason:'QUEUE_EDIT_NON_TEXT'});
    if(!action.content.some(block=>block.text.trim()))
      throw new RemoteError('gateway/bad-request','queue edit content must include non-whitespace text',{});
  }
  let pending=await history.queueItem(sessionId,itemId,signal);
  if(!pending)throw missing();
  const {nativeId,source}=pending;
  if(pending.kind==='draft') {
    if(action.kind==='steer')throw noSteer();
    if(action.kind!=='remove')throw new RemoteError('gateway/bad-request','only queued human input can be edited',{});
    try {await inbox.discardDraft(sessionId,[nativeId],signal);}
    catch(error) {
      signal?.throwIfAborted();
      pending=await history.queueItem(sessionId,itemId,signal);
      if(!pending||pending.nativeId!==nativeId)throw missing();
      if(pending.kind!=='durable')throw error;
    }
    if(pending.kind==='draft') {await history.queueItem(sessionId,itemId,signal);return source;}
  }
  let mutation;
  switch(action.kind) {
    case 'remove': mutation={action:'withdraw'};break;
    case 'edit': mutation={action:'replace',new_message_id:randomUUID(),content:action.content};break;
    case 'steer':
      if(pending.target!=='next-turn'||!pending.turn)throw noSteer();
      mutation={action:'convert_to_steer',new_message_id:randomUUID(),expected_turn_id:pending.turn};break;
    default: throw new RemoteError('gateway/bad-request','unknown queue action',{});
  }
  const request={operation_id:randomUUID(),slot_id:pending.slotId,expected_message_id:nativeId,mutation};
  let receipt;
  try {receipt=await inbox.mutate(sessionId,request,signal);}
  catch(error) {
    signal?.throwIfAborted();
    receipt=await inbox.status(sessionId,request.operation_id,signal);
    if(!receipt)throw error;
  }
  const outcome=receipt.outcome;
  if(outcome.result==='rejected') {
    if(['missing_slot','stale_message','claimed','discarded'].includes(outcome.reason))throw missing();
    if(action.kind==='steer'&&['stale_turn','incompatible_options','not_human'].includes(outcome.reason))throw noSteer();
    throw new RemoteError('gateway/bad-request','native queue rejected this change: '+outcome.reason,{});
  }
  return source;
}
