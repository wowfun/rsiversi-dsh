import {isDeepStrictEqual} from 'node:util';
import {AsyncLocalStorage} from 'node:async_hooks';

/** The original batch stores error.info and meta beside the tool message. */
export function resultMetadata({error, meta}) {
  const info = error?.info;
  if (!info && meta === undefined) return;
  const dsh = {};
  if (info) dsh.error = info;
  if (meta !== undefined) dsh.meta = meta;
  return {dsh};
}

/** The Rust Tool owner admits a single body. DSH owns policy, wrapping,
 * rendering and result finalization inside this invocation. */
export function toolPipeline(ctx, {ToolExecutionPipeline}, {projectToolSchema}) {
  const invocation=new AsyncLocalStorage();
  const registry=ctx.tools;
  const pipeline=new ToolExecutionPipeline(ctx,{
    get(name,agent,toolSet) {
      const grant=invocation.getStore();
      if(grant?.native && grant.input.agent===agent && grant.native.name===name)return grant.native;
      return registry.executable(name,agent,toolSet);
    }
  });
  ctx.on('approval/request',(request,next)=>{
    const grant=invocation.getStore();
    if(!grant?.ask || grant.input.agent!==request.agent ||
        grant.input.callId!==request.callId || grant.input.name!==request.toolName)return next();
    return grant.ask(request,next);
  },{prepend:true});
  registry.guard(exec=>{
    const grant=invocation.getStore(),input=grant?.input;
    if (!input || input.agent!==exec.agent || grant.used || exec.parent || exec.callId!==input.callId || exec.name!==input.name ||
      !isDeepStrictEqual(exec.arguments,input.arguments)) return 'Tool execution requires an RSI invocation authority';
    grant.used=true;
  });
  registry.setExecutor({
    describe(definitions){return {schemas:definitions.map(definition=>projectToolSchema(definition,false))};},
    async execute(){throw new Error('Tool execution requires an RSI invocation authority');}
  });
  return async (input,native,ask)=>{
    const grant={input,native,ask,used:false};
    try {
      return await invocation.run(grant,async()=>{
        const prepared=await pipeline.prepare(input);
        const outcome=prepared.kind==='dispatch'?await pipeline.dispatch(prepared.exec):prepared;
        return pipeline.complete(prepared.exec,outcome);
      });
    } finally {
      grant.input=undefined;
      grant.native=undefined;
      grant.ask=undefined;
    }
  };
}
