import {realpath,stat} from 'node:fs/promises';
import {relative,resolve} from 'node:path';

export function nativeWorkingDirectory({ctx,lifetime,ownsSession,ownsAgent,directoryOf,createUserMessage,updateDirectory}){
  const pending=new WeakMap();
  function get(session){
    if(!ownsSession(session)||!session?.header?.cwd)throw Error('Session has no available local working directory');
    return directoryOf?.(session)??session.header.cwd;
  }
  function current(agent,signal){
    signal.throwIfAborted();
    if(!ownsAgent(agent))throw Error('Agent no longer owns this Session view');
    return get(agent.session);
  }
  function access(agent,path,signal,inspect){
    const session=agent.session,control=signal?AbortSignal.any([lifetime,signal]):lifetime;
    const run=()=>{
      current(agent,control);
      return ctx.waterfall('working-directory/access',{agent,path,signal:control},()=>inspect(control));
    };
    const operation=(pending.get(session)??Promise.resolve()).then(run,run);
    const settled=operation.finally(()=>{if(pending.get(session)===settled)pending.delete(session);});
    pending.set(session,settled);
    return settled;
  }
  return {get,
    ensure:(agent,signal)=>access(agent,null,signal,async control=>{
      const cwd=current(agent,control);
      try {
        const actual=await realpath(cwd);
        if(relative(actual,cwd)!=='')throw Error('Session working directory changed its canonical target');
        if((await stat(actual)).isDirectory())return current(agent,control);
      }catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
      current(agent,control);
      if(updateDirectory&&cwd!==agent.session.header.cwd)return updateDirectory(agent,null,control);
      throw Error('Session working directory is no longer available');
    }),
    set:(agent,path,signal)=>access(agent,path,signal,async control=>{
      if(typeof path!=='string'||!path)throw Error('Working directory must not be empty');
      const cwd=current(agent,control),target=resolve(cwd,path);
      if(updateDirectory&&relative(cwd,target)!=='')return updateDirectory(agent,path,control);
      const actual=await realpath(target);
      if(relative(cwd,actual)!=='')throw Error('Changing the native working directory requires a new Session');
      if(!(await stat(actual)).isDirectory())throw Error('Session working directory is no longer available');
      current(agent,control);
      const recorded=agent.session.lastEvent?.('workspace-root/change')?.data.cwd??agent.session.header.cwd;
      if(createUserMessage&&relative(recorded,cwd)!==''){
        agent.session.append('workspace-root/change',{cwd});
        try {
          agent.inject(createUserMessage({source:{kind:'working-directory'},content:[{type:'text',
            text:`The working directory changed from ${JSON.stringify(recorded)} to ${JSON.stringify(cwd)}.` }]}));
        }catch(error){ctx.logger.warn('Working directory committed but its notice could not be queued:',error);}
      }
      return cwd;
    }),
  };
}
