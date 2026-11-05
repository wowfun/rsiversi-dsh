/** Submit a single model call through the release's selected batch executor. */
export async function nativeTool(ctx,{callId,name,arguments:args,...scope}) {
  const batch=await ctx.tools.execute({...scope,calls:[{type:'tool-call',id:callId,name,arguments:JSON.stringify(args)}]});
  return batch.results[0].result;
}
