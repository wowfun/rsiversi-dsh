import {parentPort, receiveMessageOnPort} from 'node:worker_threads';

let wake;

// The existing carrier pumps native requests while a Cordis service is inside a synchronous mutation.
export function commitControl(request, sessionId, control) {
  if (!parentPort) throw Error('Session control requires the application worker');
  wake ??= new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(wake,0,0);
  parentPort.postMessage({type:'commit-session-control', request, sessionId, control, wake});
  while (Atomics.load(wake,0)===0) Atomics.wait(wake,0,0);
  const {message} = receiveMessageOnPort(parentPort);
  if (message.error !== undefined) throw Error(message.error);
  return message.result;
}

export async function receiveControl(carrier, {request, sessionId, control, wake}, signal, worker) {
  const command = operation => carrier.request('application.command', {request, session_id:sessionId, operation},{signal});
  let response;
  try {
    response = {result:control.type==='disarm_goal' || control.type==='begin_maintenance'
      ? await command(control)
      : await commitChange(command,control,signal)};
  } catch (error) {
    response = {error:String(error?.message ?? error)};
  }
  worker.postMessage(response);
  Atomics.store(wake,0,1);
  Atomics.notify(wake,0);
}

async function commitChange(command,control,signal) {
  let expected = control.expected_revision;
  if (expected.kind === 'draft') {
    // Publish the blank identity before returning a durable command receipt.
    expected = await command({type:'prepare',expected_draft_revision:expected.revision});
  }
  const accepted = {...control, expected_revision:expected};
  const invocation = accepted.type==='execute'
    ? {command:accepted.command,request_id:accepted.request_id,expected_revision:expected,arguments:accepted.arguments}
    : ['create','resume','edit'].includes(accepted.action.action)
      ? {command:'rsi.goal.command',request_id:accepted.request_id,expected_revision:expected,
        arguments:{...accepted.action,published_at_ms:accepted.published_at_ms}}
      : undefined;
  let receipt;
  try {
    receipt = invocation
      ? await command({type:'execute',invocation})
      : (await command({type:'goal',control:accepted})).command;
  } catch (error) {
    signal.throwIfAborted();
    receipt = await command({type:'status',request_id:accepted.request_id}).catch(()=>undefined);
    if(!receipt)throw error;
  }
  return {control:accepted,receipt};
}
