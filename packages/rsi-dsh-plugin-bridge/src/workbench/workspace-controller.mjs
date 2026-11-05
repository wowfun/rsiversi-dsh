import {once} from 'node:events';
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
  async function baseline(signal) {
    const items=[];
    let after=null,bytes=0;
    do {
      const page=await scope.workspace({type:'list',after},signal);
      bytes+=Buffer.byteLength(JSON.stringify(page.items));
      if(bytes>4*1024*1024)throw new Error('Workspace catalog exceeds response capacity');
      items.push(...page.items);
      after=page.next;
    }while(after);
    const {groups,members}=await scope.workspace({type:'membership'},signal);
    const published=new Set(members.map(row=>row.session));
    const byWorkspace=new Map(),archives=[],pins=[];
    for(const member of members.sort((a,b)=>compareDecimal(b.last_activity_ms,a.last_activity_ms)||(a.session<b.session?1:a.session>b.session?-1:0))){
      if(member.archived)archives.push(member);
      if(member.pinned)pins.push(member);
      const group=groups[member.group],rows=byWorkspace.get(group)??[];
      if(rows.length===0)byWorkspace.set(group,rows);
      rows.push(member);
    }
    for(const draft of await scope.drafts(signal)){
      if(published.has(draft.id))continue;
      const rows=byWorkspace.get(draft.workspace)??[];
      rows.unshift({session:draft.id,last_activity_ms:draft.updatedAt});
      byWorkspace.set(draft.workspace,rows);
    }
    return {items:items.map(row=>{
      if(row.created==null)throw new Error('Workspace has no recorded creation time');
      const members=byWorkspace.get(row.id)??[];
      const createdAt=new Date(row.created).toISOString();
      const lastActivity=members.reduce((latest,member)=>Math.max(latest,Number(member.last_activity_ms)),row.created);
      const updatedAt=new Date(lastActivity).toISOString();
      return {workspaceId:row.id,path:row.path,title:row.title??row.path.split(/[/\\]/).filter(Boolean).at(-1)??row.path,
        createdAt,updatedAt,sessionIds:members.map(m=>m.session)};
    }),archivedSessionIds:archives.sort((a,b)=>compareDecimal(a.partition_revision??"0",b.partition_revision??"0")||
      (a.session<b.session?-1:a.session>b.session?1:0)).map(row=>row.session),pinnedSessionIds:pins.sort((a,b)=>compareDecimal(b.partition_revision??"0",a.partition_revision??"0")).map(row=>row.session)};
  }
  function compareDecimal(a,b){
    return a.length-b.length||(a<b?-1:a>b?1:0);
  }
  async function setPin(sessionId,pinned,signal){
    const result=await scope.workspace({type:'set_pin',session:sessionId,pinned},signal);
    if(result.status==='unknown')throw new RemoteError('session/not-found','Unknown Session',{sessionId});
    if(result.status==='archived')throw new RemoteError('gateway/bad-request','Cannot pin an archived Session',{});
    return {pinnedSessionIds:result.pinnedSessionIds};
  }
  async function selected(id,signal){
    const value=(await baseline(signal)).items.find(item=>item.workspaceId===id);
    if(!value)throw new Error('Workspace unavailable to caller');
    return {workspace:value};
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
      let value=await baseline(signal);
      yield {type:'baseline',value};
      while(!signal.aborted){
        if(!change.aborted)await once(change,'abort',{signal});
        change=scope.workspaceChange();
        const next=await baseline(signal);
        if(!isDeepStrictEqual(next,value)){value=next;yield {type:'replace',value};}
      }
    }
    archiveSession({sessionId,stopActivity=false},signal){
      return serializeArchive(async()=>{
        const request={sessionId};
        const unknown=()=>new RemoteError('session/not-found','Unknown Session',request);
        if(!stopActivity){
          const state=await scope.workspace({type:'archive_activity',session:sessionId},signal);
          if(state.status==='unknown')throw unknown();
          if(state.status==='applied')return {archivedSessionIds:state.archivedSessionIds};
          const reported=await this.ctx.waterfall('workspace/session-activity',request,async()=>[]);
          const activity=mergeActivity(reported,state.activity);
          if(activity.length)throw new RemoteError('workspace/session-active','Session has active work',{sessionId,activity});
        }
        const result=await scope.workspace({type:'archive',session:sessionId},signal);
        if(result.status==='unknown')throw unknown();
        if(result.changed&&stopActivity){
          const live=this.ctx.get('agents')?.get(sessionId)?.status==='running';
          const stops=[this.ctx.parallel('workspace/session-stop',request),
            scope.workspace({type:'stop_archive_activity',session:sessionId,stop_root:!live},signal)];
          for(const stop of await Promise.allSettled(stops)){
            if(stop.status==='rejected')this.ctx.logger.warn(`Cannot stop archived Session ${sessionId}: ${stop.reason}`);
          }
        }
        return {archivedSessionIds:result.archivedSessionIds};
      });
    }
    unarchiveSession({sessionId},signal){
      return serializeArchive(async()=>{
        const {archivedSessionIds}=await scope.workspace({type:'unarchive',session:sessionId},signal);
        return {archivedSessionIds};
      });
    }
    pinSession({sessionId},signal){return setPin(sessionId,true,signal);}
    unpinSession({sessionId},signal){return setPin(sessionId,false,signal);}
    async initializeDefault(signal){
      const row=await scope.workspace({type:'default'},signal);
      return row?selected(row.id,signal):undefined;
    }
    async create({path},signal){
      const {record,created}=await scope.workspace({type:'create',path},signal);
      return {...await selected(record.id,signal),created};
    }
    async rename({workspaceId,title},signal){
      const row=await scope.workspace({type:'rename',id:workspaceId,title},signal);
      return selected(row.id,signal);
    }
    async delete({workspaceId},signal){
      if(!await scope.workspace({type:'delete',id:workspaceId},signal))throw new Error('Workspace no longer registered');
      return {deleted:true};
    }
  };
}
