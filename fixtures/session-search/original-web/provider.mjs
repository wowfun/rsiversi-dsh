import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';

/** Actual DeepSeek Messages transport with deterministic model output. */
export async function modelServer(onRequest) {
  let active;
  const requests=[],failures=[];
  const server=createServer(async(request,response)=>{
    const entered=performance.now();
    try {
      if(request.method==='GET'&&request.url==='/models'){
        response.writeHead(404).end();return;
      }
      assert.equal(request.method,'POST');assert.equal(request.url,'/v1/messages');
      const chunks=[];for await(const chunk of request)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks));assert.equal(body.stream,true);
      const auxiliary=!body.tools?.length;
      const call=auxiliary?undefined:active;
      assert.ok(auxiliary||call,'Unexpected conversation model request');
      const number=call?call.requests++:undefined;
      if(call){assert.ok(number<2);if(number===1)call.toolCycleMs=entered-call.started;}
      requests.push({path:request.url,auxiliary,tools:body.tools?.map(tool=>tool.name)??[],model:body.model,bytes:Buffer.byteLength(JSON.stringify(body))});
      await onRequest?.({request:number,callId:call?.callId,auxiliary,body});
      const tool=call&&number===0;
      if(tool)assert.ok(body.tools.some(row=>row.name===call.name),'Tool must be in the actual standard-preset catalog');
      const events=[{type:'message_start',message:{id:'msg_'+randomUUID(),model:body.model,usage:{input_tokens:100,output_tokens:0}}},
        {type:'content_block_start',index:0,content_block:tool
          ?{type:'tool_use',id:call.callId,name:call.name,input:call.args}
          :{type:'text',text:auxiliary?'Search acceptance':'Search complete.'}},
        {type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:30}},
        {type:'message_stop'}];
      const encoded=events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
      response.writeHead(200,{'content-type':'text/event-stream'});
      if(tool)call.started=performance.now();
      response.end(encoded);
    }catch(error){failures.push(error.stack);response.writeHead(500).end(error.message);}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {
    endpoint:'http://127.0.0.1:'+server.address().port,requests,failures,
    async execute(name,args,invoke){
      assert.equal(active,undefined,'Benchmark turns must not overlap');
      const call={name,args,callId:randomUUID(),requests:0};active=call;
      try{
        const result=await invoke(call.callId);
        assert.deepEqual(failures,[]);assert.equal(call.requests,2);assert.ok(call.toolCycleMs>0);
        return {callId:call.callId,toolCycleMs:call.toolCycleMs,result};
      }finally{active=undefined;}
    },
    async close(){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));},
  };
}
