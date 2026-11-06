import {isDeepStrictEqual} from 'node:util';
import {invocationDigest} from '../command-receipts.mjs';
import {messageContent,submissionContent} from '../../agent/file-input.mjs';

const shape=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const integer=value=>Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
const attribution=message=>({id:message.id,source:message.source});
const contextInputArguments=message=>({content:messageContent(message.content),attribution:attribution(message)});

/** Wire bodies are temporary views of the accepted event, never recovery state. */
export function submissionRequest(operation,event) {
  const message=event.data.inserted[0];
  return {message_id:operation.id,delivery:event.data.target==='next-step'?'steer':'next_turn',
    content:submissionContent(message.content),attribution:attribution(message)};
}
export function contextRequest(operation,event) {
  const {command,expected_revision}=operation.invocation;
  return {command,request_id:operation.id,expected_revision,arguments:contextInputArguments(event.data.inserted[0])};
}
export function contextIntent(command,expected_revision,id,event) {
  const invocation={command,expected_revision};
  return {kind:'context-input',...invocation,sha256:invocationDigest(contextRequest({id,invocation},event))};
}

/** Normalize previous documents once and validate the durable input boundary. */
export function restoreInputOperation(operation,event,version) {
  let input=operation?.invocation,requestDigest;
  if(event?.type!=='agent/inbox/spliced'||!input||!event.data?.inserted?.length)return operation;
  if(input.kind!=='submission'&&input.kind!=='context-input'&&!input.command)return operation;
  if(event.data.inserted.length!==1||event.data.removedCount||event.data.outcome||
    !['next-step','next-turn'].includes(event.data.target))throw Error('Invalid retained input acceptance');
  if(version<3) {
    if(input.kind==='submission') {
      if(!isDeepStrictEqual(input,{kind:'submission',...submissionRequest(operation,event)}))
        throw Error('Retained submission disagrees with its accepted message');
      input={kind:'submission'};
    } else {
      const request=contextRequest(operation,event);
      if(input.request_id!==operation.id||!isDeepStrictEqual(input.arguments,request.arguments))
        throw Error('Retained input invocation disagrees with its accepted message');
      requestDigest=invocationDigest(request);
      input={kind:'context-input',command:request.command,expected_revision:request.expected_revision,sha256:requestDigest};
    }
    operation={...operation,invocation:input};
  }
  if(input.kind==='submission') {
    if(!shape(input,['kind']))throw Error('Invalid retained submission descriptor');
  } else {
    const revision=input.expected_revision;
    if(!shape(input,['kind','command','expected_revision','sha256'])||input.kind!=='context-input'||
      typeof input.command!=='string'||!input.command||
      (revision?.kind==='draft'?!integer(revision.revision):revision?.kind!=='durable'||!integer(revision.control_seq))||
      input.sha256!==(requestDigest??invocationDigest(contextRequest(operation,event))))
      throw Error('Retained input invocation disagrees with its accepted message');
  }
  return operation;
}
