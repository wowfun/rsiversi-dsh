import {INLINE_BODY_BYTES,BODY_FRAGMENT_BYTES} from '../../request-body.mjs';
import {encodedEventBytes} from '../../session/session.mjs';

export const JOURNAL_BYTES=64*1024*1024;
// Bridge results have no enforcement stamps: 4MiB value + 4MiB metadata +
// 8MiB escaped text + 64KiB contexts + bounded image descriptors/framing.
export const TOOL_RESULT_BYTES=17*1024*1024;
export function eventPageCapacity(events) {
  let maximum=0;
  for(const event of events)maximum=Math.max(maximum,encodedEventBytes(event)+2);
  if(maximum>JOURNAL_BYTES)throw Error('operation event capacity');
  return Math.max(events.length?INLINE_BODY_BYTES:0,maximum);
}

export function encodedPart(value,maximum,token) {
  const encoded=JSON.stringify(value),bytes=Buffer.byteLength(encoded);
  if(bytes>maximum)throw Error('operation body capacity');
  return bytes<=INLINE_BODY_BYTES?{body:{kind:'inline',value},size:bytes}:
    {body:{kind:'paged',token,bytes},size:bytes,bytes:Buffer.from(encoded)};
}
export function readPart(part,offset) {
  if(offset===undefined)return part.body;
  if(!part.bytes||!Number.isSafeInteger(offset)||offset<0||offset>=part.bytes.length)throw Error('invalid operation body offset');
  return {offset,data:part.bytes.subarray(offset,offset+BODY_FRAGMENT_BYTES).toString('base64')};
}
export function eventPage(events,offset,token) {
  if(!Number.isSafeInteger(offset)||offset<0||offset>=events.length)throw Error('invalid operation event cursor');
  let end=offset,size=2;
  while(end<events.length&&end-offset<4096) {
    const next=encodedEventBytes(events[end])+(end===offset?0:1);
    if(end>offset&&size+next>INLINE_BODY_BYTES)break;
    size+=next;end++;
    if(size>INLINE_BODY_BYTES)break;
  }
  return {...encodedPart(events.slice(offset,end),JOURNAL_BYTES,token),count:end-offset};
}
export function eventReply(events) {
  let size=2;
  for(const event of events) {
    size+=encodedEventBytes(event)+1;
    if(size>INLINE_BODY_BYTES)return {count:events.length};
  }
  return events;
}
