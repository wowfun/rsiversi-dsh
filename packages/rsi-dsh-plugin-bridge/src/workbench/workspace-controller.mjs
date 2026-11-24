import {once} from 'node:events';
import {readWorkspaceBaseline,workspaceView} from './workspace-registry.mjs';
import {isDeepStrictEqual} from 'node:util';

/** The process home belongs to the package cache. The picker displays the operator's home. */
export function hostHomePicker(Browse,home) {
  return class extends Browse {
    constructor(ctx,config) {
      super(ctx,config);
      const browse=super.capability();
      this.hostBrowse={...browse,list:async(path,signal)=>{
        const listing=await browse.list(path??home,signal);
        return {...listing,home};
      }};
    }
    capability(){return this.hostBrowse;}
  };
}

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

function workspaceChanges(previous,value,reader) {
  const frames=[];
  const reordered=value.items.length!==previous.items.length ||
    value.items.some((row,i)=>row.workspaceId!==previous.items[i].workspaceId);
  const missing=reordered?new Map(previous.items.map(row=>[row.workspaceId,row])):undefined;
  for(const [i,workspace] of value.items.entries()) {
    const before=missing?missing.get(workspace.workspaceId):previous.items[i];
    if(!isDeepStrictEqual(workspace,before))frames.push({type:'upsert',workspace});
    missing?.delete(workspace.workspaceId);
  }
  // The native cut is scoped. An absent ID can be a withdrawn grant; DSH's
  // remove frame permanently tombstones it, even if a later grant restores it.
  if(missing?.size)return [{type:'replace',value}];
  if(reordered)frames.push({type:'order',workspaceIds:value.items.map(row=>row.workspaceId)});
  if(!isDeepStrictEqual(value.archivedSessionIds,previous.archivedSessionIds))
    frames.push({type:'archived',archivedSessionIds:value.archivedSessionIds});
  if(!isDeepStrictEqual(value.pinnedSessionIds,previous.pinnedSessionIds))
    frames.push({type:'pinned',pinnedSessionIds:value.pinnedSessionIds});
  // Keep the filtered reader cut atomic across downstream backpressure.
  return reader && frames.length>1?[{type:'replace',value}]:frames;
}

/** Each physical follow starts with its caller's current Workspace baseline. */
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
    static inject=['typert','remoteAccess'];
    constructor(ctx){super(ctx,'workspaceController',{namespace:'workspace'});}
    [TypertRemoteService.init]() {
      this.ctx.typert.resources.register('workspace',{field:'workspaceId'});
    }
    async *follow(signal){
      const peer=this.ctx?.invocation?.peer;
      const reader=peer && peer.principal.kind!=='owner';
      const read=async()=>{
        if(!reader)return readWorkspaceBaseline(scope,signal);
        const value=await scope.observeOwned(stop=>readWorkspaceBaseline(scope,stop),signal);
        const access=this.ctx.remoteAccess;
        const sessions=ids=>ids.filter(id=>access.allows({kind:'session',id}));
        return {
          items:value.items.filter(row=>access.allows({kind:'workspace',id:row.workspaceId}))
            .map(row=>({...row,sessionIds:sessions(row.sessionIds)})),
          archivedSessionIds:sessions(value.archivedSessionIds),
          pinnedSessionIds:sessions(value.pinnedSessionIds),
        };
      };
      let change=scope.workspaceChange();
      let value=await read();
      yield {type:'baseline',value};
      while(!signal.aborted){
        if(!change.aborted)await once(change,'abort',{signal});
        change=scope.workspaceChange();
        const next=await read();
        const frames=workspaceChanges(value,next,reader);
        value=next;
        yield* frames;
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
      const result=await scope.workspace({type:'create',path},signal);
      if(result.status==='invalid_path')throw new RemoteError('workspace/invalid-path',
        `cannot create a Workspace at "${path}": ${result.message}`,{path});
      return {workspace:selected(result.record),created:result.created};
    }
    async rename({workspaceId,title},signal){
      title=title.trim();
      if(!title)throw new RemoteError('gateway/bad-request','Workspace rename requires a non-blank title',{});
      if(!nativeId.test(workspaceId))throw workspaceNotFound(workspaceId);
      const row=await scope.workspace({type:'rename',id:workspaceId,title},signal);
      if(row.status==='unknown')throw workspaceNotFound(workspaceId);
      if(row.status==='name_conflict')throw new RemoteError('workspace/name-conflict',`Workspace name '${title}' is already in use`,{name:title});
      if(row.status==='invalid_title')throw new RemoteError('gateway/bad-request',row.message,{});
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
