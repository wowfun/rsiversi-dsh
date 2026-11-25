export function workspaceView(row, sessionIds = row.sessions ?? []) {
  if (row.created == null) throw new Error('Workspace has no recorded creation time');
  return {
    workspaceId: row.id, path: row.path, title: row.title,
    createdAt: new Date(row.created).toISOString(), updatedAt: new Date(row.updated ?? row.created).toISOString(), sessionIds,
  };
}

export async function readWorkspaceBaseline(scope,signal,header) {
  const items=[];
  let after=null,order;
  do {
    const page=await scope.workspace({type:'list',after},signal);
    if(after===null)order=new Map(page.order.map((id,index)=>[id,index]));
    items.push(...page.items);
    after=page.next;
  }while(after);
  items.sort((a,b)=>order.get(a.id)-order.get(b.id));
  const drafts = new Map(header || !items.length ? [] : (await scope.drafts(signal)).map(draft => [draft.id, draft]));
  const byWorkspace = new Map(), archives = [], pins = [];
  do {
    const page=await scope.workspace({type:'membership',after,headers:!!header},signal);
    for (const member of page.members) {
      drafts.delete(member.session);
      if (member.archived) archives.push(member);
      if (member.pinned) pins.push(member);
      if (member.workspace == null) continue;
      let rows = byWorkspace.get(member.workspace);
      if (!rows) byWorkspace.set(member.workspace, rows = []);
      rows.push(member);
      if(header)await header(member.header);
    }
    after=page.next;
  }while(after);
  for(const rows of byWorkspace.values())rows.sort((a,b)=>a.account_position-b.account_position);
  for (const draft of drafts.values()) {
    if (draft.workspace == null) continue;
    let rows = byWorkspace.get(draft.workspace);
    if (!rows) byWorkspace.set(draft.workspace, rows = []);
    rows.unshift({session:draft.id});
  }
  const workspaces = items.map(row => {
    const members = byWorkspace.get(row.id) ?? [];
    return workspaceView(row, members.map(member => member.session));
  });
  return {items:workspaces,
    archivedSessionIds:archives.sort((a,b)=>compareDecimal(a.partition_revision??"0",b.partition_revision??"0")||
    (a.session<b.session?-1:a.session>b.session?1:0)).map(row=>row.session),pinnedSessionIds:pins.sort((a,b)=>
      compareDecimal(b.partition_revision??"0",a.partition_revision??"0")||compareDecimal(b.last_activity_ms,a.last_activity_ms)||
      (a.session<b.session?1:a.session>b.session?-1:0)).map(row=>row.session)};
}
function compareDecimal(a,b){
  return a.length-b.length||(a<b?-1:a>b?1:0);
}

/** One in-memory read model for trusted plugins. Native registration and Session
 * stores own the records. Reading a Workspace never materializes a transcript. */
export function workbenchWorkspaceRegistry(scope,headerOf) {
  let entries=new Map(),headers=new Map(),order=[],archives=[],pins=[],revision=0,refreshing;
  function findOrCreate(id){
    let entry=entries.get(id);
    if(!entry){
      entry={row:undefined,entity:Object.freeze({
        id,get path(){return entry.row.path;},get title(){return entry.row.title;},
        get createdAt(){return entry.row.createdAt;},get updatedAt(){return entry.row.updatedAt;},
        get sessionIds(){return entry.row.sessionIds.filter(session=>headers.has(session));},
        getSessionHeaders(){
          const members=[];
          for(const id of entry.row.sessionIds){const header=headers.get(id);if(header)members.push(header);}
          return members;
        },
      })};
      entries.set(id,entry);
    }
    return entry;
  }
  async function read(signal){
    for(;;){
      const start=revision;
      const fresh=new Map();
      const baseline=await readWorkspaceBaseline(scope,signal,async meta=>{
        fresh.set(meta.id,headers.get(meta.id)??Object.freeze(await headerOf(meta)));
      });
      if(start!==revision)continue;
      headers=fresh;
      const next=new Map();
      for(const row of baseline.items){
        const entry=findOrCreate(row.workspaceId);
        entry.row=row;next.set(row.workspaceId,entry);
      }
      entries=next;order=[...entries.keys()];archives=baseline.archivedSessionIds;pins=baseline.pinnedSessionIds;
      return;
    }
  }
  const service={
    get:id=>entries.get(id)?.entity,
    list:()=>order.map(id=>entries.get(id).entity),
    get archivedSessionIds(){return [...archives];},get pinnedSessionIds(){return [...pins];},
  };
  return {
    service,
    refresh(signal){
      return refreshing??=scope.observeOwned(read,signal).finally(()=>{refreshing=undefined;});
    },
    record(row){
      revision++;
      if(!entries.has(row.workspaceId))order.unshift(row.workspaceId);
      findOrCreate(row.workspaceId).row=row;
      return row;
    },
    attach(workspaceId,header,updatedAt){
      const entry=entries.get(workspaceId);
      if(!entry||!header||headers.has(header.id)&&entry.row.sessionIds.includes(header.id))return;
      revision++;headers.set(header.id,Object.freeze({...header}));
      if(!entry.row.sessionIds.includes(header.id))entry.row={...entry.row,
        updatedAt:updatedAt===undefined?entry.row.updatedAt:new Date(updatedAt).toISOString(),
        sessionIds:[header.id,...entry.row.sessionIds]};
    },
    remove(id){revision++;entries.delete(id);order=order.filter(item=>item!==id);},
    reorder(ids){revision++;order=ids.filter(id=>entries.has(id));},
    archived(ids,sessionId){revision++;archives=[...ids];if(sessionId)pins=pins.filter(id=>id!==sessionId);},
    pinned(ids){revision++;pins=[...ids];},
  };
}
