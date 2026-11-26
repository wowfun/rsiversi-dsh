// Cordis removes the carrier and name from args when it resolves the listeners.
export function callSessionListeners(ctx,name,args,listeners) {
  const id=args[0].id;
  for(const listener of listeners){
    try{
      const result=listener(...args);
      if(result!==undefined)void Promise.resolve(result).catch(error=>
        ctx.logger.warn(`session "${id}": ${name} listener rejected: ${String(error)}`));
    }catch(error){
      if(name==='session/created')throw error;
      ctx.logger.warn(`session "${id}": ${name} listener threw: ${String(error)}`);
    }
  }
}

export function notifySession(ctx,name,session,carrier,event) {
  const args=carrier?[carrier,name,session]:[name,session];
  if(event!==undefined)args.push(event);
  try{
    const listeners=ctx.events.dispatch('emit',args);
    callSessionListeners(ctx,name,args,listeners);
  }catch(error){
    if(name!=='session/disposed')throw error;
    ctx.logger.warn(`session "${session.id}": session/disposed dispatch threw: ${String(error)}`);
  }
}
