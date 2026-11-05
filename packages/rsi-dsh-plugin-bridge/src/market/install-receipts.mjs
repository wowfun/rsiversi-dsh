import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';

const maximum=8*1024*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if(Array.isArray(value)) return value.map(canonical);
  if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}

async function readRows(path) {
  const chunks=[];let length=0;
  try {
    for await(const part of createReadStream(path)) {
      length+=part.length;
      if(length>maximum) throw new Error('Install receipts exceed profile capacity');
      chunks.push(part);
    }
  } catch(error) {if(error.code==='ENOENT')return [];throw error;}
  const rows=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!Array.isArray(rows)||rows.length>128||rows.some(row=>!row||!['key','intent'].every(key=>/^[a-f0-9]{64}$/.test(row[key]))))
    throw new Error('Invalid install receipts');
  return rows;
}

/** The original Plugin Manager owns approval, cancellation and activation. */
export async function replayableInstalls(Manager,directory,{withFileLock,writeFileAtomic}) {
  await mkdir(directory,{recursive:true});
  const path=join(directory,'install-receipts.json'),active=new Map();
  const change=operation=>withFileLock(path,async()=>{
    const rows=await readRows(path);
    const outcome=operation(rows);
    if(!outcome.write) return outcome;
    let encoded=JSON.stringify(rows);
    while(rows.length>128 || Buffer.byteLength(encoded)>maximum) {
      const index=rows.findIndex(row=>row.key!==outcome.key&&!active.has(row.key));
      if(index<0) throw new Error('Install receipts exceed profile capacity');
      rows.splice(index,1);
      encoded=JSON.stringify(rows);
    }
    await writeFileAtomic(path,encoded,{mode:0o600});
    return outcome;
  });
  return class extends Manager {
    async cancelInstall(id) {
      const pending=typeof id==='string'&&active.get(hash(id));
      if(pending && !await pending.started) return {status:'not-running'};
      return super.cancelInstall(id);
    }
    installBundle(spec,options) {
      const id=options?.requestId;
      if(id===undefined) return super.installBundle(spec,options);
      if(typeof id!=='string'||!id.length||id.length>512) return Promise.reject(new Error('Invalid install request ID'));
      const key=hash(id),intent=hash(JSON.stringify(canonical([spec,options])));
      const prior=active.get(key);
      const conflict=()=>new Error('Install request ID reused with different arguments');
      if(prior) return prior.intent===intent?prior.work:Promise.reject(conflict());
      const started=Promise.withResolvers();
      const work=(async()=>{
        const claim=await change(rows=>{
          const row=rows.find(row=>row.key===key);
          if(row) {
            if(row.intent!==intent) throw conflict();
            if(Object.hasOwn(row,'result')) return {result:row.result};
            if(Object.hasOwn(row,'error')) throw new Error(row.error);
            throw new Error('Previous install was interrupted. Inspect the installed bundle before retrying with a new request ID.');
          }
          rows.push({key,intent});
          return {write:true,key};
        });
        if(!claim.write) return claim.result;
        const finish=fields=>change(rows=>{
          const row=rows.find(row=>row.key===key&&row.intent===intent);
          if(!row) throw new Error('Install request receipt retired');
          Object.assign(row,fields);
          return {write:true,key};
        });
        let result;
        try {
          const operation=super.installBundle(spec,options);
          started.resolve(true);
          result=await operation;
        }
        catch(error) {await finish({error:String(error.message??error).slice(0,1000)});throw error;}
        await finish({result});
        return result;
      })().finally(()=>{started.resolve(false);active.delete(key);});
      active.set(key,{intent,work,started:started.promise});
      return work;
    }
  };
}
