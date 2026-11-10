import {randomUUID} from 'node:crypto';
import {readPage} from './pages.mjs';

// Match the native application's two prepared-page reservations. Queued reads
// must not occupy the RPC slots needed by active readers and their cleanup.
let active=0;
const waiting=new Set();
async function acquire(signal) {
  signal?.throwIfAborted();
  if(active<2)active++;
  else await new Promise((resolve,reject)=>{
    const grant=()=>{signal?.removeEventListener('abort',cancel);resolve();};
    const cancel=()=>{waiting.delete(grant);reject(signal.reason);};
    waiting.add(grant);signal?.addEventListener('abort',cancel,{once:true});
  });
}
function free() {
  const next=waiting.values().next().value;
  if(next){waiting.delete(next);next();}else active--;
}

export async function nativePage(call, release, operation, after, horizon, signal) {
  await acquire(signal);
  const reader=randomUUID();let complete=false,started=false;
  try {
    signal?.throwIfAborted();
    const page=await readPage(async offset=>{
      started=true;
      return call({...operation,reader,offset});
    },after,horizon,signal);
    complete=true;return page;
  } finally {
    try {
      if(started&&!complete)await release({type:'page_close',reader});
    } finally {free();}
  }
}

export const nativeFactPages=(call,release,signal,operation={type:'fact'})=>(after,horizon)=>
  nativePage(call,release,{...operation,after_seq:after,through_seq:horizon},after,horizon,signal);

const integer=value=>Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
export async function readControls(call, release, after, horizon, signal) {
  const {through,value}=await nativePage(call,release,{type:'controls',after_seq:after,
    through_seq:horizon},after,horizon,signal);
  return controlPage({through,value},after);
}

function controlPage({through,value},after) {
  if(!Array.isArray(value)||value.length>64||value.some((event,i)=>
    !integer(event.seq)||event.seq<=(i?value[i-1].seq:after)||event.seq>through))
    throw Error('Invalid captured control page');
  return {through,events:value};
}

/** One fresh durable cut, with ordinary first pages under the same native reservation. */
export async function nativeCapture(call,release,after,signal) {
  const {through,value}=await nativePage(call,release,{type:'capture',after},undefined,undefined,signal);
  if(value===null){if(through!==0)throw Error('Invalid absent history capture');return {meta:null};}
  const {meta,facts,controls}=value,cut=meta?.selection_cursor;
  if(cut?.kind!=='durable'||!integer(cut.fact_seq)||!integer(cut.control_seq)||meta.through!==through
    ||cut.fact_seq!==through||cut.fact_seq<after.fact_seq||cut.control_seq<after.control_seq)
    throw Error('Invalid captured history cut');
  for(const [page,start,end] of [[facts,after.fact_seq,cut.fact_seq],[controls,after.control_seq,cut.control_seq]]) {
    if(page!==null&&(!page||!integer(page.through)||page.through<=start||page.through>end))
      throw Error('Invalid captured history slice');
  }
  return {meta,first:{after,cut,facts:facts??undefined,controls:controls===null?undefined:controlPage(controls,after.control_seq)}};
}

export async function readNativeMessage(call, release, messageId, seq, signal) {
  const {through,value}=await nativePage(call,release,{type:'message',message_id:messageId,
    accepted_control_seq:seq},seq-1,seq,signal);
  if(through!==seq||value.message_id!==messageId)throw new Error('Native inbox acceptance identity mismatch');
  return value;
}
