import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {modelServer} from './provider.mjs';

/** Stock CLI/Web/standard-preset composition with a local Messages endpoint. */
export async function originalWebProfile({cohort,profile,corpus=[],sessionId='search-caller',cwd,
  resume=false,verifyDurability=false,onRequest,onLog}){
  await mkdir(profile,{recursive:true});
  let call;
  const provider=await modelServer(async request=>{
    if(verifyDurability&&request.request===1){
      const events=await call('read');
      assert.ok(events.some(row=>row.type==='tool/result'&&row.data.message.source.callId===request.callId),'Result must be durable before the next model request');
    }
    await onRequest?.(request);
  });
  const child=spawn(process.execPath,[fileURLToPath(new URL('./worker.mjs',import.meta.url)),cohort],{
    cwd:profile,windowsHide:true,env:{...process.env,DSH_HOME:profile,DSH_TELEMETRY_DISABLED:'1',
      DEEPSEEK_BASE_URL:provider.endpoint,DEEPSEEK_API_KEY:'local-deterministic-fixture'},
    stdio:['ignore','pipe','pipe','ipc'],
  });
  let next=0,closed=false;
  const pending=new Map(),exited=once(child,'exit');
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>onLog?.(chunk.toString()));
  const rejectAll=error=>{for(const {reject} of pending.values())reject(error);pending.clear();};
  child.on('error',rejectAll);
  child.on('exit',(code,signal)=>rejectAll(Error(`Original Web profile exited (${code}, ${signal})`)));
  child.on('message',({id,value,error})=>{
    const job=pending.get(id);if(!job)return;pending.delete(id);
    if(error)job.reject(Error(error));else job.resolve(value);
  });
  call=(method,args={})=>new Promise((resolve,reject)=>{
    const id=++next;
    pending.set(id,{resolve,reject});
    child.send({id,method,args},error=>{if(error){pending.delete(id);reject(error);}});
  });
  async function close(){
    if(closed)return;closed=true;
    try{
      if(child.exitCode===null&&child.signalCode===null&&child.connected)child.send({method:'close'});
      const [code,signal]=await exited;assert.equal(signal,null);assert.equal(code,0);
    }finally{await provider.close();}
  }
  try{
    const opening=await call('boot',{corpus,sessionId,cwd:cwd??corpus[0]?.header.cwd??profile,resume,verifyDurability});
    return {opening:{...opening,processId:child.pid},provider,
      execute:(name,args)=>provider.execute(name,args,callId=>call('prompt',{callId})),
      append:(id,events,{live=false}={})=>call('append',{sessionId:id,events,live}),
      snapshot:()=>call('snapshot'),read:()=>call('read'),close,
    };
  }catch(error){await close();throw error;}
}
