import {createServer} from 'node:http';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {resultMetadata,toolPipeline} from './tool-pipeline.mjs';
import {toolLedger} from './application-tool-ledger.mjs';
import {toolContextOutput} from '../history/step-messages.mjs';
import {prepareRequestInputs,runtimeContextProjection} from '../agent/request-input.mjs';
import {serveNativeTools} from './native-tool.mjs';

const maxBytes=32*1024*1024;
// Native mailbox prefix (32 MiB), contributions (16 MiB), Tool contexts
// (16 MiB), preceding preset edits (32 MiB), and 1 MiB of envelopes.
const maxPreparationBytes=(32+16+16+32+1)*1024*1024;
const failure=(code,message)=>({value:{code,message},content:[{type:'text',text:message}],is_error:true});

export async function applicationTools(ctx,{load,key,generation,directory,sessions,resolveAgent}){
  const tools=await load('@deepseek-ai/dsh-tools');
  const prompt=await load('@deepseek-ai/dsh-system-prompt');
  const {renderPrompt}=prompt;
  const {assembleContextFor,agentEvents}=await load('@deepseek-ai/dsh-agent');
  const runtimeContext=runtimeContextProjection({...prompt,...await load('@deepseek-ai/dsh-llm')});
  const execute=toolPipeline(ctx,await load('@deepseek-ai/dsh-tools/pipeline'),tools);
  const views=new Map(),secret=Buffer.from(key);
  const ledger=await toolLedger(directory,(await load('@deepseek-ai/dsh-atomic-write')).writeFileAtomic);
  let admitted=0;
  function release(id) {
    const row=views.get(id);
    if (!row) return;
    views.delete(id);
    row.controller.abort();
    row.selection?.dispose();
  }
  async function capture({view,header,reserved,allowed,modelSelection},signal){
    if(!modelSelection||typeof modelSelection.provider!=='string'||!modelSelection.provider
      ||typeof modelSelection.model!=='string'||!modelSelection.model
      ||modelSelection.reasoningEffort!==undefined&&(typeof modelSelection.reasoningEffort!=='string'||!modelSelection.reasoningEffort))
      throw Error('Tool capture requires the native request model selection');
    if(views.has(view)||views.size>=64)throw Error('Tool capture capacity');
    const row={session:{id:header.id,header},controller:new AbortController(),bindings:new Map(),reserved:new Set(reserved)};
    views.set(view,row);
    const stop=AbortSignal.any([signal,row.controller.signal]);
    try{
      const agent=row.agent=await resolveAgent?.(header.id,stop)??{id:header.id,ctx,session:row.session};
      stop.throwIfAborted();row.session=agent.session;
      row.selection=await sessions.withToolAgent(agent,()=>ctx.tools.resolve({agent,modelSelection,signal:stop}));
      if(stop.aborted){
        row.selection.dispose();
        row.selection=undefined;
        stop.throwIfAborted();
      }
      const rows=[],delegated=allowed&&new Set(allowed);
      for(const [name,definition] of [...row.selection.view(agent)].sort(([a],[b])=>a<b?-1:a>b?1:0)){
        if(row.reserved.has(name)||delegated&&!delegated.has(name)||name==='report_result')continue;
        if(row.reserved.size+rows.length>=64)break;
        const schema=tools.projectToolSchema(definition,false),registration=randomUUID();
        rows.push({registration,definition:{name,description:schema.description,input_schema:schema.parameters}});
        row.bindings.set(registration,name);
      }
      row.modelSelection=modelSelection;
      const assembly=row.assembly=await sessions.withToolAgent(agent,()=>ctx.systemPrompt.assemble({
        ...assembleContextFor(agent,stop),modelSelection,toolSet:row.selection,
      }));
      stop.throwIfAborted();
      return {generation,view,tools:rows,instructions:renderPrompt(assembly)};
    }catch(error){if(views.get(view)===row)release(view);throw error;}
  }
  async function prepare({view,session,input},signal) {
    const row=views.get(view);
    if(!row||row.session.id!==session)throw Error('Input preparation lost its captured Agent');
    if(!row.preparation) {
      const stop=AbortSignal.any([signal,row.controller.signal]);
      row.preparation=sessions.withToolAgent(row.agent,()=>prepareRequestInputs({ctx,agent:row.agent,input,
        modelSelection:row.modelSelection,assembly:row.assembly,signal:stop},{agentEvents,runtimeContext}));
    }
    return row.preparation;
  }
  async function stopping({view},signal) {
    const row=views.get(view);
    if(!row)throw Error('Stopping lost its captured Agent');
    if(!row.stopping){
      const stop=AbortSignal.any([signal,row.controller.signal]);
      row.stopping=sessions.withToolAgent(row.agent,async()=>{
        // Snapshot the published model/tool result before a listener reads the Session.
        if(resolveAgent&&await resolveAgent(row.agent.id,stop)!==row.agent)throw Error('Stopping Agent has retired');
        const turn=row.agent.session.lastEvent('turn/start').data.turn;
        await agentEvents(ctx,row.agent).serial('agent/turn-stopping',{turn,signal:stop});
        stop.throwIfAborted();
        return null;
      },stop);
    }
    return row.stopping;
  }
  async function run(input,signal){
    const {name,args,registration,session,identity}=input,view=views.get(input.view);
    if(!view||view.session.id!==session||view.bindings.get(registration)!==name)
      return failure('UNKNOWN_TOOL','The captured tool is no longer available');
    if(!view.selection.view(view.agent).has(name))return failure('UNKNOWN_TOOL','The captured tool registration was withdrawn');
    const result=await sessions.withToolAgent(view.agent,()=>execute({agent:view.agent,callId:identity.call_id,name,
      arguments:args,toolSet:view.selection,signal}));
    const contexts=toolContextOutput(result.additionalContexts??[]);
    return {value:result.value??null,content:result.content,is_error:result.isError===true,metadata:resultMetadata(result),
      ...(result.concludesTurn?{concludes_turn:true}:{}),
      ...(contexts.length?{additional_contexts:contexts}:{})};
  }
  async function dispatch(path,input,signal){
    switch(path){
      case '/v1/capture':return capture(input,signal);
      case '/v1/prepare':return prepare(input,signal);
      case '/v1/stopping':return stopping(input,signal);
      case '/v1/callback-outcome':{
        const row=views.get(input.view);
        if(input.callback==='prepare'&&row?.preparation)return row.preparation;
        if(input.callback==='stopping'&&row?.stopping)return row.stopping;
        throw Error('Callback outcome unavailable for this view');
      }
      case '/v1/start':return ledger.start(input,stop=>run(input,stop));
      case '/v1/outcome':return ledger.outcome(input);
      case '/v1/cancel':return ledger.cancel(input);
      case '/v1/release':release(input.view);return {};
      default:throw Error('Unknown application tool operation');
    }
  }
  function authenticated(req){
    const auth=Buffer.from(req.headers.authorization??'');
    return !req.headers.origin&&auth.length===secret.length&&timingSafeEqual(auth,secret);
  }
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST'||!authenticated(req)){res.writeHead(403).end();return;}
    if(admitted>=24){res.writeHead(503).end();return;}
    admitted++;
    const abort=new AbortController();res.on('close',()=>abort.abort());
    try{
      const limit=req.url==='/v1/prepare'?maxPreparationBytes:maxBytes;
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('Tool request exceeds capacity');chunks.push(chunk);}
      const value=await dispatch(req.url,JSON.parse(Buffer.concat(chunks).toString()),abort.signal);
      if(res.destroyed)return;
      const json=JSON.stringify(value);
      const responseLimit=req.url==='/v1/prepare'||req.url==='/v1/callback-outcome'?36*1024*1024:maxBytes;
      if(Buffer.byteLength(json)>responseLimit)throw Error('Tool response exceeds capacity');
      res.writeHead(200,{'content-type':'application/json'}).end(json);
    }catch(error){
      const cause=error instanceof AggregateError&&!error.message?error.errors[0]:error;
      res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:String(cause?.message||cause).slice(0,512)}));
    }
    finally{admitted--;}
  });
  const {WebSocketServer}= (await load('ws')).default;
  const closeNative=serveNativeTools(server,WebSocketServer,authenticated,views,sessions,execute);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  ctx.effect(()=>async()=>{
    closeNative();server.close();server.closeAllConnections();await ledger.close();
    for(const id of views.keys())release(id);
  },'close application tool source');
  return {protocol:14,generation,port:server.address().port};
}
