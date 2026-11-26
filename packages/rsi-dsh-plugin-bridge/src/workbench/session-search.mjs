const messageTypes=['user/message','assistant/message'];
const filters=[{kind:'type',values:messageTypes},{kind:'surface',values:['current']}];

function snippet(text,maximum) {
  if(text.length<=maximum)return text;
  let count=0,end=0;
  for(const character of text){
    if(count++===maximum)break;
    end+=character.length;
  }
  return text.slice(0,end);
}

/** Adapt the scoped DSH query provider to the release's bounded sidebar RPC. */
export async function searchSessionMessages(provider,query,signal,{RemoteError,SessionQueryError,
  SESSION_SEARCH_RESULT_LIMIT:maximum,SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS:snippetLength}) {
  query=query.trim();
  if(!query||query.length>500||query.includes('\0'))
    throw new RemoteError('gateway/bad-request','Expected a nonempty search query of at most 500 UTF-16 code units without NUL',{});
  if(!provider)throw new RemoteError('gateway/internal','Session search provider is unavailable',{});
  try {
    signal.throwIfAborted();
    const records=await provider.listSessions(signal);
    signal.throwIfAborted();
    const visible=new Set();
    for(const {header} of records)if(header.cwd!==undefined)visible.add(header.id);
    if(!visible.size)return {items:[],hasMore:false};
    const items=new Map(),cursors=new Set();
    let cursor,limit=maximum;
    for(let calls=0;calls<100;calls++){
      signal.throwIfAborted();
      let page;
      try {
        page=await provider.searchSessions({query,eventFilters:filters,limit,...(cursor===undefined?{}:{cursor})},{signal});
      }catch(error){
        if(error instanceof SessionQueryError){
          if(cursor===undefined&&error.code==='SESSION_QUERY_INVALID_LIMIT'&&limit>1){
            limit=Math.floor(limit/2);continue;
          }
          if(cursor!==undefined&&error.code==='SESSION_QUERY_STALE_CURSOR'){
            items.clear();cursors.clear();cursor=undefined;continue;
          }
        }
        throw error;
      }
      signal.throwIfAborted();
      if(page.items.length>limit)throw Error('Session search exceeded the requested page size');
      if(page.nextCursor!==undefined&&cursors.has(page.nextCursor))throw Error('Session search repeated a continuation cursor');
      for(const {header,bestMatch} of page.items){
        const id=header.id;
        if(!visible.has(id)||items.has(id)||id!==bestMatch.sessionId||
          bestMatch.surface!=='current'||!messageTypes.includes(bestMatch.type))continue;
        if(items.size===maximum)return {items:[...items.values()],hasMore:true};
        items.set(id,{sessionId:id,snippet:snippet(bestMatch.snippet,snippetLength)});
      }
      cursor=page.nextCursor;
      if(cursor===undefined)return {items:[...items.values()],hasMore:false};
      cursors.add(cursor);
    }
    throw Error('Session search exceeded the 100-call work budget');
  }catch(error){
    signal.throwIfAborted();
    if(error instanceof SessionQueryError&&error.code==='SESSION_QUERY_ABORTED')
      throw new RemoteError('gateway/cancelled','session search was aborted',{});
    throw new RemoteError('gateway/internal',`session search failed: ${String(error)}`,{});
  }
}
