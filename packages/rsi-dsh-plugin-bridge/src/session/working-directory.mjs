import {realpath,stat} from 'node:fs/promises';
import {relative,resolve} from 'node:path';

export function nativeWorkingDirectory(ownsSession,ownsAgent){
  function get(session){
    if(!ownsSession(session)||!session?.header?.cwd)throw Error('Session has no available local working directory');
    return session.header.cwd;
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
    const current=await ensure(agent,signal);
    if(relative(current,resolve(current,path))!=='')throw Error('Changing the native working directory requires a new Session');
    return current;
  }};
}
