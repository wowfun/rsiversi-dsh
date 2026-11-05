import {AsyncLocalStorage} from 'node:async_hooks';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {nativeWorkingDirectory} from '../session/working-directory.mjs';
import {requestPublication} from './request-publication.mjs';
import {applicationInbox} from './inbox.mjs';
import {applicationActivities} from './activities.mjs';
import {submissionContent} from '../agent/file-input.mjs';

export class SidebarBodyError extends Error {}

/** The synchronous DSH lookup is scoped to a native-authorized request.
 * An unknown Session must never trigger the sidebar's cwd/process fallback. */
export function applicationSessions(send,{capture,owner,agent,attached,select,decorate}={}) {
  const scope=new AsyncLocalStorage();
  const activities=applicationActivities(scope,owner);
  let workspaceChange;
  const lanes=new Map();
  async function inSessions(ids,run) {
    const keys=[...ids].sort(),prior=keys.map(id=>lanes.get(id));
    const {promise,resolve}=Promise.withResolvers();
    for(const id of keys)lanes.set(id,promise);
    try {await Promise.all(prior);return await run();}
    finally {resolve();for(const id of keys)if(lanes.get(id)===promise)lanes.delete(id);}
  }
  function call(method,args,signal) {
    const lifetime=scope.getStore()?.signal;
    return send(method,args,lifetime?(signal?AbortSignal.any([lifetime,signal]):lifetime):signal);
  }
  function activeRequest() {
    const active=scope.getStore(),request=!active?.released&&active?.request;
    if(!request)throw new Error('Session access requires an active native request');
    return request;
  }
  function writablePublication(active) {
    if(!active||active.released)return;
    const response=active.response;
    if(response&&(response.headersSent||response.writableEnded||response.destroyed))return;
    if(active.publication)return active.publication.accepting?active.publication:undefined;
    if(response)return active.publication=requestPublication(response);
  }
  const workingDirectory=nativeWorkingDirectory(session=>{
    const active=scope.getStore();
    return agent?.(session?.id)?.session===session ||
      active!==undefined&&!active.released&&(active===session||active.agent?.session===session||active.views?.get(session?.id)===session);
  },value=>agent?.(value?.id)===value||scope.getStore()?.agent===value);
  const sessions={get(id) {
    const owned=agent?.(id);if(owned)return owned.session;
    const active=scope.getStore();
    if (!active || active.released) throw new Error('Session outside this request');
    if(active.views?.has(id))return active.views.get(id);
    if(active.id===id)return active.agent?.session??active;
    if(active.sidebar)throw new Error('Session outside this request');
  }, list:()=>attached?.()??[]};
  async function prepare(req,request=req.headers['x-rsi-upstream-request']) {
    const url=new URL(req.url,'http://localhost');
    if (!url.pathname.startsWith('/sidebar/') || url.pathname.startsWith('/sidebar/bundle/') ||
        url.pathname==='/sidebar/bundle') return handler=>scope.run({request},()=>handler(req));
    let id=url.searchParams.get('sessionId'), cwd=url.searchParams.get('cwd'), input=req;
    let otherIds=[];
    if(url.pathname.startsWith('/sidebar/api/') && req.method==='POST') {
      const chunks=[];let length=0;
      for await(const chunk of req.iterator({destroyOnReturn:false})) {
        length+=chunk.length;
        if(length>1024*1024) {
          req.resume();
          throw new SidebarBodyError('request body too large');
        }
        chunks.push(chunk);
      }
      const bytes=Buffer.concat(chunks);
      const text=bytes.toString('utf8');
      let value;
      try {value=text.trim() ? JSON.parse(text) : {};}
      catch {throw new SidebarBodyError('request body is not valid JSON');}
      if(value?.sessionId && id && value.sessionId!==id) throw new Error('Ambiguous Session');
      otherIds=[value?.childId,value?.rootSessionId].filter(key=>key!=null);
      id=value?.sessionId ?? id ?? otherIds[0]; cwd=value?.cwd ?? cwd;
      input=Object.assign(Readable.from([bytes]),{method:req.method,url:req.url,headers:req.headers,socket:req.socket});
    } else if(url.pathname.startsWith('/sidebar/html/')) {
      id=decodeURIComponent(url.pathname.slice('/sidebar/html/'.length).split('/')[0]);
    }
    if(id==null) {
      if(cwd || !url.pathname.startsWith('/sidebar/api/')&&!url.pathname.startsWith('/sidebar/ws/')) throw new Error('Session required');
      return handler=>scope.run({request,sidebar:true},()=>handler(input));
    }
    let header;
    const targets=new Set([id,...otherIds]);
    for(const target of targets) {
      const authorized=await call('application.session',{request,session_id:target});
      if(authorized?.id!==target||!authorized.cwd)throw new Error('Session workspace unavailable');
      if(target===id)header=authorized;
    }
    const active={id,header,request,views:new Map(),sidebar:true};
    return handler=>inSessions(targets,()=>scope.run(active,async()=>{
      if(capture)for(const target of targets)active.views.set(target,await capture(target));
      return handler(input);
    }));
  }
  async function* durablePages(signal,history=false) {
    const request=activeRequest();
    let after=null,bytes=0;
    do {
      signal?.throwIfAborted();
      const page=await call('application.sessions',{request,after,...(history?{history:true}:{})},signal);
      if(!history){
        bytes+=Buffer.byteLength(JSON.stringify(page.items));
        if(bytes>4*1024*1024)throw new Error('Session catalog exceeds response capacity');
      }
      yield page.items;
      after=page.next;
    } while(after);
  }
  async function list(signal) {
    // Observe unpublished identities first so promotion cannot fall between both catalogs.
    const heldDrafts=await drafts(signal),items=[];
    for await(const page of durablePages(signal))items.push(...page);
    const published=new Set(items.map(row=>row.id));
    const rows=items.concat(heldDrafts.filter(row=>!published.has(row.id)));
    return decorate?decorate(rows):rows;
  }
  async function prompt({sessionId,requestId,mode,content,attribution},signal) {
    if(!['queue','steer'].includes(mode)) throw new Error('Unknown prompt delivery mode');
    await submit(sessionId,{message_id:requestId,
      delivery:mode==='queue'?'next_turn':'steer',content:submissionContent(content),
      ...(attribution===undefined?{}:{attribution})},signal);
    return {accepted:true};
  }
  async function submit(sessionId,input,signal) {
    const request=activeRequest();
    const automatic=input.attribution && input.attribution.source.kind!=='user';
    const receipt=await call('application.submit',{request,session_id:sessionId,...input,...(automatic?{origin:'application'}:{})},signal);
    if(receipt.session_id!==sessionId||receipt.message_id!==input.message_id||
      !Number.isSafeInteger(receipt.accepted_control_seq)||receipt.accepted_control_seq<1)
      throw new Error('Invalid native mailbox receipt');
    return receipt;
  }
  async function history(session_id,operation,signal,parent_session_id) {
    const request=activeRequest();
    return call('application.history',{request,session_id,operation,...(parent_session_id?{parent_session_id}:{})},signal);
  }
  function releaseHistory(session_id,operation,_signal,parent_session_id) {
    if(!['model_close','seed_close'].includes(operation.type))throw Error('Only history resource release can outlive read cancellation');
    const request=activeRequest();
    return send('application.history',{request,session_id,operation,...(parent_session_id?{parent_session_id}:{})});
  }
  async function cancel({sessionId,keepInbox=true,inboxOnly=false},signal) {
    const request=activeRequest();
    const result=await call('application.cancel',{request,session_id:sessionId,keep_inbox:keepInbox,...(inboxOnly?{inbox_only:true}:{})},signal);
    if(result.session_id!==sessionId)throw new Error('Invalid native cancellation receipt');
    return {accepted:true};
  }
  function scoped(method,args,signal) {
    const request=activeRequest();
    return call(method,{request,...args},signal);
  }
  async function modelCatalog(signal){
    const groups=new Map(),failures=new Map();
    let after=null,defaultSelection;
    do {
      const page=await scoped('application.models',{after},signal);
      defaultSelection??={provider:page.default.deployment,model:page.default.model,
        ...(page.effort?{reasoningEffort:page.effort}:{})};
      for(const row of page.models){
        const {deployment:id,model}=row.route;
        if(row.failure){failures.set(id,{id,name:id,message:row.failure});continue;}
        let group=groups.get(id);
        if(!group){group={id,name:id,models:[]};groups.set(id,group);}
        group.models.push({id:model,name:model,...(row.efforts.length?{reasoning:{
          efforts:row.efforts.map(effort=>({id:effort,name:effort})),
          ...(row.default_effort?{defaultEffort:row.default_effort}:{})}}:{})});
      }
      after=page.next;
    }while(after);
    const available=[...groups.values()].filter(group=>!failures.has(group.id));
    return {default:defaultSelection,routableProviders:available.map(group=>group.id),groups:available,failures:[...failures.values()]};
  }
  const tree=(id,signal)=>scoped('application.descendants',{session_id:id},signal);
  async function selectModel({sessionId,provider,model,reasoningEffort},signal){
    if(select)return select({sessionId,provider,model,reasoningEffort},signal);
    const {selected}=await scoped('application.model.select',{session_id:sessionId,request_id:randomUUID(),
      selection:{model:{deployment:provider,model},...(reasoningEffort===undefined?{}:{reasoning_effort:reasoningEffort})}},signal);
    return {selected:{provider:selected.model.deployment,model:selected.model.model,
      ...(selected.reasoning_effort==null?{}:{reasoningEffort:selected.reasoning_effort})}};
  }
  async function drafts(signal){
    const items=[];let after=null;
    do{
      const page=await scoped('application.workspaces',{operation:{type:'drafts',after}},signal);
      items.push(...page.items);
      if(items.length>64)throw new Error('Device draft capacity exceeded');
      after=page.next;
    }while(after);
    return items;
  }
  async function create({workspaceId,cwd,sessionId,agentPreset,fork},signal) {
    const result=await scoped('application.create',fork?{fresh:sessionId??'session-'+randomUUID(),fork}:
      {fresh:'session-'+randomUUID(),requested:sessionId,workspace:workspaceId,cwd,preset:agentPreset},signal);
    return result;
  }
  const subagents={
    async listChildren(id,signal) {
      return (await tree(id,signal)).filter(row=>row.depth===1).map(row=>({
        id:row.id,createdAt:row.created_at,mode:row.program_owned?'unknown':'continuable',label:row.task}));
    },
    async listDescendants(id,signal) {
      const rows=await tree(id,signal),parents=new Set(rows.map(row=>row.parent));
      return rows.map(row=>{
        const identity={id:row.id,parentId:row.parent,depth:row.depth};
        if(row.program_owned||row.activity==='unknown')return {...identity,kind:'diagnostic',reason:row.program_owned?'unsupported':'unavailable'};
        return {...identity,kind:'child',mode:'continuable',label:row.task,
          activity:row.activity==='running'?'running':'inactive',hasChildren:parents.has(row.id)};
      });
    },
  };
  async function retainDraft(id,signal) {
    const key=randomUUID();let releasing;
    const release=()=>releasing??=activities.run(stop=>scoped('application.inbox',{
      session_id:id,operation:{type:'release_draft',key}},stop));
    try {
      const held=await activities.run(stop=>scoped('application.inbox',{
        session_id:id,operation:{type:'retain_draft',key}},stop),signal);
      if(typeof held!=='boolean')throw Error('Invalid native draft ownership receipt');
      return held?release:async()=>{};
    } catch(error) {
      // The native owner may have been retained before its reply was lost.
      await release().catch(()=>{});throw error;
    }
  }
  return {sessions,subagents,prepare,list,drafts,storedPages:signal=>durablePages(signal,true),waitDirectory:(open,signal)=>scoped('application.directory.wait',{open},signal),
    workspaceChange:()=>(workspaceChange??=new AbortController()).signal,
    invalidateWorkspaces(){const before=workspaceChange;workspaceChange=undefined;before?.abort();},
    create,prompt,submit,history,releaseHistory,cancel,workingDirectory,modelCatalog,selectModel,
    runOwned:activities.run,observeOwned:activities.observe,retainDraft,close:activities.close,
    inbox:applicationInbox((id,operation,signal)=>scoped('application.inbox',{session_id:id,operation},signal)),
    command:(id,operation,signal)=>scoped('application.command',{session_id:id,operation},signal),
    stage(operation) {
      const active=scope.getStore(),publication=writablePublication(active);
      if(!publication)throw Error(active?.response?'Cannot stage a native write after response publication':'Native write requires an active publication');
      return publication.stage(operation);
    },
    publish(operation) {
      const publication=writablePublication(scope.getStore());
      if(publication)return publication.stage(operation);
      return activities.run(signal=>operation(signal));
    },
    async respond(response,run) {
      const active=scope.getStore();
      if(!active||active.released)throw Error('Application request has retired');
      active.response=response;
      try {await run();if(active.publication)await active.publication.finish();}
      catch(error) {
        if(!active.publication)throw error;
        await active.publication.fail(error);
      } finally {
        active.released=true;
        active.response=undefined;
        if(active.publication)active.publication=undefined;
      }
    },
    authorize:(id,signal)=>scoped('application.session',{session_id:id},signal),
    interactions:(id,operation,signal)=>scoped('application.interactions',{session_id:id,operation},signal),
    async withToolAgent(agent,run){
      const execute=async()=>{
        const view={...scope.getStore(),id:agent.id,header:agent.session.header,agent};
        return scope.run(view,async()=>{
          try {
            const result=await run();await view.publication?.finish();return result;
          }catch(error){view.publication?.fail(error);throw error;}
          finally{view.released=true;delete view.agent;}
        });
      };
      return owner?activities.run(execute):execute();
    },
    fork:(id,turn,signal)=>scoped('application.create',{fresh:'session-'+randomUUID(),
      fork:{source_session_id:id,point:{kind:'through_turn',turn_id:turn},turns:'all'}},signal),
    workspace:(operation,signal)=>scoped('application.workspaces',{operation},signal),
    lookupAgent(id,activate) {
      const request=activeRequest(),active=scope.getStore();
      if(active.agentLookup?.id===id)return active.agentLookup.value;
      const value=call('application.actor',{request,session_id:id}).then(()=>
        agent?.(id)??activities.run(signal=>activate(id,signal)));
      active.agentLookup={id,value};
      return value;
    },
    terminal:(id,operation,signal)=>scoped('application.terminal',{session_id:id,operation},signal),
    waitTerminal:(id,key,signal)=>scoped('application.terminal.wait',{session_id:id,key},signal),
    releaseTerminal:attachment=>scoped('application.terminal.release',{attachment})};
}
