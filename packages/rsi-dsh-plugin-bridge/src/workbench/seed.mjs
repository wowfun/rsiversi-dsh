import {randomUUID} from 'node:crypto';
import {forkSnapshot} from '../session/fork.mjs';
import {observeFact,restoreMapping} from '../history/history.mjs';
import {historyReader,readHistory} from '../history/pages.mjs';
import {SessionFacade} from '../session/session.mjs';

export async function projectFacts(session,mapping,fetch,through,signal,llm,observed){
  return factProjector(session,mapping,fetch,through,signal,llm,observed)(through);
}

export function factProjector(session,mapping,fetch,horizon,signal,llm,observed){
  const identity={session_id:session.id};
  const advance=historyReader(fetch,identity,mapping.factCursor,horizon,signal);
  let page;
  const readFact=async seq=>{
    const retained=page[seq-page[0]?.seq];
    if(retained?.seq===seq)return retained;
    let fact;
    await readHistory(fetch,identity,seq-1,seq,value=>{fact=value;},signal);
    if(fact?.seq!==seq)throw new Error('Referenced Fact is unavailable');
    return fact;
  };
  return async through=>{
    session.begin();
    try{
      mapping.factCursor=await advance(through,async (fact,facts)=>{
        page=facts;
        try {
          await observeFact(session,mapping,fact,readFact,llm);
          observed?.(fact);
        } finally {page=undefined;}
      });
    }finally{session.end();}
  };
}

export async function inheritedSession(ctx,api,llm,call,release,header,signal){
  const key=randomUUID(),rows=await call({type:'seed_open',key});
  try{
    if(!rows.length||rows.at(-1).child!==header.id)throw new Error('Incomplete native history selection');
    let canonical;
    for(const [interval,row] of rows.entries()){
      if(row.after!==0)throw new Error('This selective fork needs its omitted projection checkpoint');
      if(canonical&&canonical.header.id!==row.parent)throw new Error('Discontinuous native fork history');
      const parent=canonical??{header:{version:4,id:row.parent,createdAt:row.parent_time,isSeeded:false},
        mapping:restoreMapping(null),events:[],inheritedEventCount:0};
      const session=new SessionFacade(ctx,api,parent,false);
      const fetch=(_method,{after_seq,through_seq,offset})=>
        call({type:'seed_read',key,interval,after_seq,through_seq,offset});
      await projectFacts(session,parent.mapping,fetch,row.through,signal,llm);
      canonical=forkSnapshot({...parent,events:session.snapshotEvents()},{
        header:row.child===header.id?{...header,parentSession:row.parent}:
          {version:4,id:row.child,createdAt:row.child_time,parentSession:row.parent},
        afterFact:0,throughFact:row.through,includeInherited:true,
      },ctx.sessionProjections,api);
    }
    return canonical;
  }finally{await release({type:'seed_close',key});}
}
