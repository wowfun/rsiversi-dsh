import {createHash} from 'node:crypto';

export const invocationDigest=invocation=>createHash('sha256').update('rsi-session-command-v1\0').update(JSON.stringify({
  command:invocation.command,request_id:invocation.request_id,expected_revision:invocation.expected_revision,
  arguments:invocation.arguments,
})).digest('hex');

/** Match an actual native command receipt to the exact retained invocation. */
export function commandReceipt(operation,receipt,digest) {
  if(receipt?.command!==operation.invocation?.command||receipt?.request_id!==operation.id)
    throw Error('Native command receipt changed its invocation identity');
  const expected=operation.invocation.expected_revision,outcome=receipt.outcome;
  if(expected.kind==='draft'?(outcome?.kind!=='draft_changed'||outcome.revision!==expected.revision+1)
    :(expected.kind!=='durable'||outcome?.kind!=='committed'||outcome.control_seq!==expected.control_seq+1))
    throw Error('Native command receipt changed its publication boundary');
  if(receipt.invocation_sha256!==(digest??invocationDigest(operation.invocation))||typeof receipt.state_sha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.state_sha256))
    throw Error('Native command receipt changed its invocation digest');
  return receipt;
}
