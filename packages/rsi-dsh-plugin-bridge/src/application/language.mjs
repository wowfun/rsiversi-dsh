import {INLINE_BODY_BYTES,requestBodies,writeBodyFragment} from '../request-body.mjs';
import {modelChunks} from '../history/model-history.mjs';
import {wait} from './request-boundary.mjs';

function content(block) {
  switch(block.type) {
    case 'text': return {type:'text',content:{text:block.text}};
    case 'reasoning': return {type:'reasoning',content:{text:block.text,evidence:null}};
    case 'tool-call': return {type:'tool_call',content:{kind:'function',id:block.id,name:block.name,arguments:block.arguments}};
    default: throw new Error('Unsupported standalone Language input block: '+block.type);
  }
}

function languageRequest(options) {
  const messages=options.messages.map(message=>{
    const blocks=message.content.map(content);
    return {role:message.role,content:message.role==='tool'
      ?[{type:'tool_result',content:{call_id:message.toolCallId,content:blocks,is_error:message.isError??false}}]:blocks};
  });
  if(options.system)messages.unshift({role:'system',content:[content({type:'text',text:options.system})]});
  return {messages,tools:(options.tools??[]).map(tool=>({name:tool.name,description:tool.description,input_schema:tool.parameters})),
    tool_choice:{type:'auto'},hosted_tools:[],response_format:{type:'text'},extensions:[],
    settings:{temperature:options.temperature,max_output_tokens:options.maxTokens,reasoning_effort:options.reasoningEffort,stop:options.stop??[]}};
}

/** One native request owns the attempt. The consumer acknowledges each batch before the producer can send another. */
export function languageCalls(call,owner) {
  const bodies=requestBodies(16*1024*1024),live=new Map(),lifetime=new AbortController();
  let sequence=0;
  async function* stream(options) {
    const request=languageRequest(options);
    const id=++sequence,stop=new AbortController();
    const signal=AbortSignal.any([stop.signal,lifetime.signal,...(options.signal?[options.signal]:[])]);
    const state={next:Promise.withResolvers()};live.set(id,state);
    const chunks=[];
    const project=modelChunks((_,chunk)=>chunks.push(chunk));
    let received;
    const work=bodies.send(request,{id},signal,body=>
      call('application.language',{id,request:owner,model:{deployment:options.provider,model:options.model},body},signal)
    ).then(reply=>state.next.resolve({done:true,events:reply?.events}),error=>state.next.resolve({error}));
    try {
      for(;;) {
        received=await state.next.promise;
        if(received.error)throw received.error;
        state.next=Promise.withResolvers();
        for(const event of received.events??[]) {
          // DSH has no chunk for ancillary native diagnostics or source annotations.
          if(event.type==='warning'||event.type==='source')continue;
          project(0,event);
          yield* chunks;chunks.length=0;
        }
        if(received.done)return;
        received.ack.resolve();
      }
    } finally {
      stop.abort();received?.ack?.resolve();live.delete(id);await work;
    }
  }
  async function deliver({id,events,bytes,part},signal) {
    const state=live.get(id);if(!state)throw Error('Language consumer has retired');
    if(part) {
      // Native admits 32 MiB of output. JSON escaping takes up to six bytes per
      // source byte, plus metadata for the sixteen events in one native batch.
      const maxBatchBytes=6*32*1024*1024+16*(256*1024+4096);
      if(!Number.isSafeInteger(bytes)||bytes<=INLINE_BODY_BYTES||bytes>maxBatchBytes)throw Error('Invalid Language event length');
      state.buffer??=Buffer.allocUnsafe(bytes);
      if(bytes!==state.buffer.length)throw Error('Language event length changed');
      state.offset=writeBodyFragment(state.buffer,state.offset??0,part);
      if(state.offset<bytes)return null;
      events=JSON.parse(state.buffer.toString('utf8'));delete state.buffer;delete state.offset;
    }
    const ack=Promise.withResolvers();
    state.next.resolve({events,ack});await wait(ack.promise,signal);return null;
  }
  return {stream,deliver,read:args=>bodies.read(args),close(){lifetime.abort();bodies.close();}};
}

export async function provideLanguage(ctx,load,catalog,calls) {
  const {default:Runtime,LlmAdapter}=await load('@deepseek-ai/dsh-llm');
  await (await ctx.plugin(Runtime)).await();
  if(catalog.default) {
    const {default:DefaultModel}=await load('@deepseek-ai/dsh-agent-default-model');
    await (await ctx.plugin(DefaultModel,catalog.default)).await();
  }
  class HostAdapter extends LlmAdapter {
    async listModels(provider) {
      return (catalog.groups.find(group=>group.id===provider)?.models??[]).map(model=>({provider,...model}));
    }
    async resolveModel(provider,id) {
      const selected=catalog.groups.find(group=>group.id===provider)?.models.find(model=>model.id===id);
      return selected?{provider,...selected}:{provider,id,name:id};
    }
    stream(options) {return calls.stream(options);}
  }
  if(catalog.routableProviders.length)ctx.llm.registerAdapter(catalog.routableProviders,new HostAdapter());
}
