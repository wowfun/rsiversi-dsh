import {realpath,stat} from 'node:fs/promises';
import {relative,resolve} from 'node:path';

export function nativeWorkingDirectory(ownsSession,ownsAgent,directoryOf,createUserMessage){
  function get(session){
    if(!ownsSession(session)||!session?.header?.cwd)throw Error('Session has no available local working directory');
    return directoryOf?.(session)??session.header.cwd;
  }
  async function ensure(agent,signal){
    signal?.throwIfAborted();
    if(!ownsAgent(agent))throw Error('Agent no longer owns this Session view');
    const current=get(agent.session);
    const actual=await realpath(current);
    if(relative(actual,current)!==''||!(await stat(actual)).isDirectory())throw Error('Session working directory is no longer available');
    signal?.throwIfAborted();
    if(!ownsAgent(agent))throw Error('Agent no longer owns this Session view');
    return current;
  }
  return {get,ensure,async set(agent,path,signal){
    if(typeof path!=='string'||!path)throw Error('Working directory must not be empty');
    const current=await ensure(agent,signal);
    const requested=resolve(current,path);
    if(relative(current,requested)!==''&&relative(current,await realpath(requested))!=='')
      throw Error('Changing the native working directory requires a new Session');
    signal?.throwIfAborted();
    if(!ownsAgent(agent))throw Error('Agent no longer owns this Session view');
    const recorded=agent.session.lastEvent?.('workspace-root/change')?.data.cwd??agent.session.header.cwd;
    if(relative(recorded,current)!==''){
      agent.session.append('workspace-root/change',{cwd:current});
      try {
        agent.inject(createUserMessage({source:{kind:'working-directory'},content:[{type:'text',
          text:`The working directory changed from ${JSON.stringify(recorded)} to ${JSON.stringify(current)}.` }]}));
      }catch(error){agent.ctx.logger.warn('Working directory committed but its notice could not be queued:',error);}
    }
    return current;
  }};
}
