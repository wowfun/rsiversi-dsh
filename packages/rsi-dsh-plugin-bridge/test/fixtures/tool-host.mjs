import {applicationTools} from '../../src/tools/application-tools.mjs';

/** Run the actual capture service with stable release Sessions for this fixture. */
export async function fixtureTools(ctx,options,cwdForSession=()=>options.directory) {
  const {Session}=await options.load('@deepseek-ai/dsh-session');
  const agents=new Map();
  function resolveAgent(id) {
    if(!agents.has(id)){
      const header={version:4,id,cwd:cwdForSession(id),createdAt:0,isSeeded:false};
      agents.set(id,{id,ctx,session:Session.create(id,[],header)});
    }
    return agents.get(id);
  }
  return applicationTools(ctx,{resolveAgent,...options});
}
