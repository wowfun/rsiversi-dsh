import {once} from 'node:events';
import {readWorkspaceBaseline,workspaceView} from './workspace-registry.mjs';
import {isDeepStrictEqual} from 'node:util';

function mergeActivity(reported,native) {
  if(!reported.length)return native;
  if(!native.length)return reported;
  const activity=[...reported];
  for(const family of native){
    const first=reported.findIndex(entry=>entry.kind===family.kind);
    if(first<0){activity.push(family);continue;}
    if(!family.items)continue;
    const known=new Set();
    for(const entry of reported){
      if(entry.kind===family.kind)for(const item of entry.items)known.add(item.id);
    }
    const missing=family.items.filter(item=>!known.has(item.id));
    if(missing.length)activity[first]={...reported[first],items:[...reported[first].items,...missing]};
  }
  return activity;
}

/** The original Workspace client consumes one baseline per physical follow. */
export function workspaceController(TypertRemoteService,scope,RemoteError) {
  function selected(row){
    const view=workspaceView(row);
    scope.workspaceMetadata?.record(view);
    return view;
  }
  const nativeId = /^[0-9a-f]{64}$/;
  function workspaceNotFound(workspaceId) {
    return new RemoteError('workspace/not-found', `Workspace "${workspaceId}" not found`, {workspaceId});
  }
  async function setPin(sessionId,pinned,signal){
    const result=await scope.workspace({type:'set_pin',session:sessionId,pinned},signal);
    if(result.status==='unknown')throw new RemoteError('session/not-found','Unknown Session',{sessionId});
    if(result.status==='archived')throw new RemoteError('gateway/bad-request','Cannot pin an archived Session',{});
    scope.workspaceMetadata?.pinned(result.pinnedSessionIds);
    return {pinnedSessionIds:result.pinnedSessionIds};
  }
  let archiveTail=Promise.resolve();
  function serializeArchive(operation){
    const result=archiveTail.then(operation);
    archiveTail=result.catch(()=>{});
    return result;
  }
  return class extends TypertRemoteService {
    constructor(ctx){super(ctx,'workspaceController',{namespace:'workspace'});}
    async *follow(signal){
      let change=scope.workspaceChange();
      let value=await readWorkspaceBaseline(scope,signal);
      yield {type:'baseline',value};
      while(!signal.aborted){
        if(!change.aborted)await once(change,'abort',{signal});
        change=scope.workspaceChange();
        const next=await readWorkspaceBaseline(scope,signal);
        if(!isDeepStrictEqual(next,value)){value=next;yield {type:'replace',value};}
      }
    }
    archiveSession({sessionId,stopActivity=false},signal){
      return serializeArchive(async()=>{
        const request={sessionId};
        const unknown=()=>new RemoteError('session/not-found','Unknown Session',request);
        const active=activity=>new RemoteError('workspace/session-active','Session has active work',{sessionId,activity});
        if(!stopActivity){
          const state=await scope.workspace({type:'archive_activity',session:sessionId},signal);
          if(state.status==='unknown')throw unknown();
          if(state.status==='applied')return {archivedSessionIds:state.archivedSessionIds};
          const reported=await this.ctx.waterfall('workspace/session-activity',request,async()=>[]);
          const activity=mergeActivity(reported,state.activity);
          if(activity.length)throw active(activity);
        }
        const result=await scope.workspace({type:'archive',session:sessionId,stop_activity:stopActivity},signal);
        if(result.status==='unknown')throw unknown();
        if(result.status==='ready')throw active(result.activity);
        scope.workspaceMetadata?.archived(result.archivedSessionIds,sessionId);
        if(result.changed){
          if(stopActivity){
            try {await this.ctx.parallel('workspace/session-stop',request);}
            catch(error){this.ctx.logger.warn(`Cannot stop archived Session ${sessionId}: ${error}`);}
          }
          try {await this.ctx.parallel('workspace/session-archived',request);}
          catch(error){this.ctx.logger.warn(`Session ${sessionId} archived, but archive follow-up admission failed: ${error}`);}
        }
        return {archivedSessionIds:result.archivedSessionIds};
      });
    }
    unarchiveSession({sessionId},signal){
      return serializeArchive(async()=>{
        const state=await scope.workspace({type:'archive_activity',session:sessionId},signal);
        if(state.status==='applied')await this.ctx.parallel('workspace/session-unarchiving',{sessionId});
        const {archivedSessionIds}=await scope.workspace({type:'unarchive',session:sessionId},signal);
        scope.workspaceMetadata?.archived(archivedSessionIds);
        return {archivedSessionIds};
      });
    }
    pinSession({sessionId},signal){return setPin(sessionId,true,signal);}
    unpinSession({sessionId},signal){return setPin(sessionId,false,signal);}
    async initializeDefault(signal){
      const row=await scope.workspace({type:'default'},signal);
      return row ? {workspace:selected(row)} : undefined;
    }
    async create({path},signal){
      const {record,created}=await scope.workspace({type:'create',path},signal);
      return {workspace:selected(record), created};
    }
    async rename({workspaceId,title},signal){
      const row=await scope.workspace({type:'rename',id:workspaceId,title},signal);
      return {workspace:selected(row)};
    }
    async delete({workspaceId},signal){
      if (!nativeId.test(workspaceId) || !await scope.workspace({type:'delete',id:workspaceId},signal))
        throw workspaceNotFound(workspaceId);
      scope.workspaceMetadata?.remove(workspaceId);
      return {deleted:true};
    }
    async insertBefore({workspaceId,beforeWorkspaceId},signal){
      // Native Workspace identities use opaque lowercase hex. Other DSH strings
      // cannot name a registration; preserve DSH's business error at this seam.
      const unknown=[workspaceId,beforeWorkspaceId].find(id=>id!==undefined&&!nativeId.test(id));
      if(unknown!==undefined)throw workspaceNotFound(unknown);
      const result=await scope.workspace({type:'insert_before',id:workspaceId,before:beforeWorkspaceId},signal);
      if(result.status==='unknown')throw workspaceNotFound(result.id);
      scope.workspaceMetadata?.reorder(result.ids);
      return {workspaceIds:result.ids};
    }
    async insertSessionBefore({workspaceId,sessionId,beforeSessionId},signal){
      if(!nativeId.test(workspaceId))throw workspaceNotFound(workspaceId);
      const result=await scope.workspace({type:'insert_session_before',id:workspaceId,session:sessionId,before:beforeSessionId},signal);
      if(result.status==='unknown')throw workspaceNotFound(workspaceId);
      if(result.status==='invalid_member')throw new RemoteError('workspace/move-invalid','Session or anchor is not in this Workspace',
        {workspaceId,sessionId,...beforeSessionId===undefined?{}:{beforeSessionId}});
      return {workspace:selected(result.record)};
    }
  };
}
