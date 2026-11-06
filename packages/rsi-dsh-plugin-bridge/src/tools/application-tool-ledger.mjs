import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';

const limit=32*1024*1024,capacity=128,budget=64*1024*1024;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyOf=({session,effect})=>digest([session,effect]);
const signature=({identity,name,registration,args})=>digest([identity.call_id,name,registration,args]);
const identifier=value=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=256;

function receiptOf(input){
  const {session,effect,registration,identity}=input;
  if(!identifier(session)||!identifier(effect)||!identifier(registration)||!identity||identity.invocation_id!==effect||
    !identifier(identity.call_id)||!identifier(identity.owner_id)||
    !/^[0-9a-f]{64}$/.test(identity.request_sha256))throw Error('Invalid native tool receipt identity');
  return {session,effect,registration,identity:{owner_id:identity.owner_id,invocation_id:effect,
    call_id:identity.call_id,request_sha256:identity.request_sha256}};
}
function matches(record,receipt){
  return record?.session===receipt.session&&record.effect===receipt.effect&&record.registration===receipt.registration&&
    record.identity?.invocation_id===receipt.identity.invocation_id&&record.identity.call_id===receipt.identity.call_id&&
    record.identity.owner_id===receipt.identity.owner_id&&record.identity.request_sha256===receipt.identity.request_sha256;
}

/** Native owns durable admission and never repeats start after process loss.
 * The caller admits only a live captured view; replacement processes query outcomes.
 * Pending/unknown bindings stay in bounded memory, settled results are durable. */
export async function toolLedger(directory,writeAtomic){
  await mkdir(directory,{recursive:true});
  const records=new Map(),active=new Map();
  let bytes=0,lane=Promise.resolve(),retired=false;
  const serialize=fn=>{const next=lane.then(fn);lane=next.catch(()=>{});return next;};
  const path=key=>join(directory,key+'.json');
  for(const name of await readdir(directory)){
    if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
    const info=await stat(join(directory,name));
    if(!info.isFile()||info.size>limit||records.size>=capacity||bytes+info.size>budget)throw Error('Tool outcome ledger exceeds capacity');
    records.set(name.slice(0,-5),{size:info.size});bytes+=info.size;
  }
  async function reserve(key,size){
    const old=records.get(key)?.size??0;
    while((!records.has(key)&&records.size>=capacity)||bytes-old+size>budget){
      let victim;
      for(const id of records.keys())if(id!==key&&!active.has(id)){victim=id;break;}
      if(victim===undefined)throw Error('Tool outcome ledger is full');
      const row=records.get(victim);
      if(row.size!==undefined)await unlink(path(victim));
      bytes-=row.size??0;records.delete(victim);
    }
  }
  async function save(key,value){
    const data=JSON.stringify(value),size=Buffer.byteLength(data);
    if(size>limit)throw Error('Tool outcome exceeds ledger capacity');
    await reserve(key,size);
    await writeAtomic(path(key),data,{mode:0o600});
    const old=records.get(key)?.size??0;
    records.delete(key);records.set(key,{size});bytes+=size-old;
    return data;
  }
  async function read(key){
    const row=records.get(key);
    return row?.size!==undefined?JSON.parse(await readFile(path(key),'utf8')):row?.bound;
  }
  function outcomeOf(record,key){
    if(record.state==='settled')return {state:'settled',result:record.result};
    return {state:active.has(key)?'pending':'unknown'};
  }
  return {
    async start(input,run){
      if(retired)throw Error('Application tool source is closed');
      const receipt=receiptOf(input),key=keyOf(receipt),sig=signature(input);
      let outcome;
      await serialize(async()=>{
        const prior=await read(key);
        if(prior){
          if(!matches(prior,receipt)||prior.signature!==sig)throw Error('Tool effect was already bound to another call');
          outcome=outcomeOf(prior,key);
          return;
        }
        if(!run){outcome={state:'unknown'};return;}
        if(active.size>=8)throw Error('Application tool executions are at capacity');
        const bound={...receipt,signature:sig};
        await reserve(key,0);
        if(retired){outcome={state:'unknown'};return;}
        records.set(key,{bound});
        const abort=new AbortController();
        const settled=Promise.resolve().then(async()=>{
          // Native owns durable admission; a retired view can only be queried.
          // The bounded live binding fences duplicates before any plugin code.
          if(retired)return {state:'unknown'};
          let outcome;
          try {outcome={...bound,state:'settled',result:await run(abort.signal)};}
          catch {return {state:'unknown'};}
          const committed=await serialize(()=>save(key,outcome));
          return outcomeOf(JSON.parse(committed),key);
        }).catch(error=>{
          console.error('Tool outcome write failed:',error.message);
          return {state:'unknown'};
        }).finally(()=>active.delete(key));
        active.set(key,{abort,settled,receipt});
        outcome=settled;
      });
      // Waiting inside the write lane would block the settlement itself.
      return outcome;
    },
    async outcome(identity){
      const receipt=receiptOf(identity),key=keyOf(receipt),record=await serialize(()=>read(key));
      return matches(record,receipt)?outcomeOf(record,key):{state:'unknown'};
    },
    async cancel(identity){
      const receipt=receiptOf(identity),key=keyOf(receipt);
      let running=active.get(key);
      if(!running){await lane;running=active.get(key);}
      const accepted=matches(running?.receipt,receipt);
      if(accepted)running.abort.abort();
      return {accepted};
    },
    async close(){
      retired=true;
      for(const {abort} of active.values())abort.abort();
      await lane;
      await Promise.all(Array.from(active.values(),row=>row.settled));
    },
  };
}
