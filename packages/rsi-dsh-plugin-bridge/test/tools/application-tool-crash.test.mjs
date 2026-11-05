import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';

test('a killed Cordis process leaves settled and orphaned receipts without replaying either body',
  {skip:!process.env.RSI_DSH_MARKET_COHORT,timeout:30000},async t=>{
    const directory=await mkdtemp(join(tmpdir(),'rsi-process-receipts-'));
    const key=randomUUID();
    let worker;
    async function kill(){
      if(!worker)return;
      const exited=once(worker,'exit');
      worker.kill('SIGKILL');await exited;worker=undefined;
    }
    t.after(async()=>{await kill();await rm(directory,{recursive:true,force:true});});
    async function launch(){
      worker=fork(new URL('../fixtures/receipt-worker.mjs',import.meta.url),[directory,key],
        {execArgv:[],windowsHide:true,stdio:['ignore','ignore','inherit','ipc']});
      const [hello]=await once(worker,'message',{signal:AbortSignal.timeout(10000)});
      assert.equal(hello.protocol,10);
      return async(op,body)=>{
        const response=await fetch('http://127.0.0.1:'+hello.port+'/v1/'+op,{method:'POST',headers:{authorization:key},
          body:JSON.stringify(body)});
        assert.equal(response.status,200);return response.json();
      };
    }
    let post=await launch();
    async function capture(session){
      const view=await post('capture',{view:randomUUID(),header:{id:session,cwd:directory},reserved:[],
        modelSelection:{provider:'fixture',model:'receipt-test'}});
      const effect=randomUUID();
      return {session,effect,identity:{invocation_id:effect,owner_id:'test-owner',call_id:randomUUID(),
        request_sha256:'a'.repeat(64)},registration:view.tools[0].registration,view:view.view,name:'receipt_probe',args:{}};
    }
    const done=await capture('completed'),pending=await capture('unfinished');
    assert.equal((await post('start',done)).result.value,'completed');
    const interrupted=assert.rejects(post('start',pending));
    const bodies=()=>readFile(join(directory,'body-calls'),'utf8');
    for(let i=0;i<200;i++){
      if((await bodies()).includes('unfinished'))break;
      await delay(10);
    }
    assert.equal((await post('outcome',done)).result.value,'completed');
    assert.equal((await post('outcome',pending)).state,'pending');
    assert.deepEqual((await bodies()).trim().split('\n').sort(),['completed','unfinished']);
    await kill();await interrupted;
    post=await launch();
    assert.equal((await post('outcome',done)).result.value,'completed');
    assert.equal((await post('outcome',pending)).state,'unknown');
    assert.equal((await post('outcome',{...done,registration:randomUUID()})).state,'unknown');
    await post('start',done);await post('start',pending);
    assert.deepEqual((await bodies()).trim().split('\n').sort(),['completed','unfinished']);
  });
