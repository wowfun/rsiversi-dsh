import {once} from 'node:events';
import {isDeepStrictEqual} from 'node:util';
import {contentBlocks} from '../history/conversation-history.mjs';
import {nativeMedia} from '../agent/file-input.mjs';
import {resultMetadata} from './tool-pipeline.mjs';
import {toolContextOutput,toolUserMessage} from '../history/step-messages.mjs';

function nativeBlock(block) {
  if(block.type==='text')return block;
  if(block.type!=='image')throw Error('Unmapped native Tool result block');
  return {type:'image',media:nativeMedia(block.attachment)};
}

/** Run the release's own policy, around, post and result stages on the captured Agent. */
async function invoke(row,input,execute,next,ask,signal) {
  let original,content,failure;
  const definition={name:input.name,description:input.name,parameters:{},
    output:{schema:input.output_schema??{},render:(_,value)=>
      original && isDeepStrictEqual(original.value,value)?content:[{type:'text',text:JSON.stringify(value)}]},
    projectContent:(_,result)=>failure && result.error?.message===failure?content:undefined,
    async execute(_,exec){
      original=await next(exec.signal);
      content=contentBlocks(original.content);
      for(const message of original.additional_contexts??[])
        exec.deferContext(toolUserMessage(message.id,message.source,message.text.map(text=>({type:'text',text}))));
      if(original.is_error){
        failure=content.filter(b=>b.type==='text').map(b=>b.text).join('\n')||'Native tool failed';
        throw Error(failure);
      }
      if(original.concludes_turn)exec.concludeTurn();
      return original.value;
    }};
  const result=await execute({agent:row.agent,callId:input.call_id,
    name:input.name,arguments:input.args,toolSet:row.selection,signal},definition,ask);
  const isError=result.isError===true;
  if(!original&&isError){
    const reason=result.content.filter(block=>block.type==='text').map(block=>block.text).join('\n');
    const contexts=toolContextOutput(result.additionalContexts??[]);
    return {state:'denied',reason:reason||result.error?.message||'Application denied this Tool call',
      ...(contexts.length?{additional_contexts:contexts}:{})};
  }
  const output={value:isError?(failure && result.error?.message===failure?original.value:result.error??null):result.value,
    is_error:isError,content:result.content.map(nativeBlock),additional_contexts:toolContextOutput(result.additionalContexts??[]),
    ...(result.concludesTurn?{concludes_turn:true}:{})};
  const metadata=resultMetadata(result);
  if(original && original.is_error===isError && isDeepStrictEqual(original.value,output.value)){
    if(isDeepStrictEqual(original.content,output.content) && isDeepStrictEqual(original.additional_contexts??[],output.additional_contexts)
      && Boolean(original.concludes_turn)===Boolean(output.concludes_turn) && !metadata)
      return {state:'unchanged'};
    return {state:'rendered',content:output.content,metadata,additional_contexts:output.additional_contexts,
      ...(output.concludes_turn?{concludes_turn:true}:{})};
  }
  return {state:'settled',result:{...output,metadata}};
}

/** Socket lifetime binds the only continuation; nothing is stored or redispatched on disconnect. */
export function serveNativeTools(server,WebSocketServer,authenticated,views,sessions,execute) {
  const sockets=new WebSocketServer({noServer:true,maxPayload:32*1024*1024,perMessageDeflate:false});
  server.on('upgrade',(req,stream,head)=>{
    if(req.url!=='/v1/native'||!authenticated(req)){stream.destroy();return;}
    sockets.handleUpgrade(req,stream,head,socket=>{
      const lifetime=new AbortController();
      socket.on('close',()=>lifetime.abort());
      socket.on('error',error=>lifetime.abort(error));
      const read=async signal=>JSON.parse((await once(socket,'message',{signal}))[0].toString());
      const run=async()=>{
        const input=await read(lifetime.signal),row=views.get(input.view);
        if(!row||row.session.id!==input.session||!row.reserved.has(input.name))throw Error('Native Tool outside its request capture');
        const signal=AbortSignal.any([lifetime.signal,row.controller.signal]);
        let reviewOpen=true;
        const next=async bodySignal=>{
          reviewOpen=false;
          const reply=read(AbortSignal.any([signal,bodySignal]));
          socket.send('{"state":"next"}');
          return reply;
        };
        const ask=async (request,nextAnswer)=>{
          if(!reviewOpen)return nextAnswer();
          reviewOpen=false;
          const reply=read(request.signal?AbortSignal.any([signal,request.signal]):signal);
          socket.send(JSON.stringify({state:'ask',reason:request.reason||request.displayReason?.en||('Allow '+input.name+'?')}));
          return (await reply).allow===true?'allowed-once':'rejected';
        };
        const outcome=await sessions.withToolAgent(row.agent,()=>invoke(row,input,execute,next,ask,signal));
        socket.send(JSON.stringify(outcome),()=>socket.close());
      };
      void run().catch(()=>socket.terminate());
    });
  });
  return ()=>{for(const socket of sockets.clients)socket.terminate();sockets.close();};
}
