import {randomUUID} from 'node:crypto';
import {modelProjection} from '../history/model-history.mjs';
import {FollowReads} from './follow-reads.mjs';

async function modelBatch(call,key){
  const parts=[];let offset=0,total,revision;
  for(;;){
    const page=await call({type:'model_next',key});
    if(typeof page.json!=='string'||page.offset!==offset||page.next_offset!==offset+Buffer.byteLength(page.json)||
      page.next_offset<=offset||!Number.isSafeInteger(page.total_bytes)||page.total_bytes>36*1024*1024+2||
      page.next_offset>page.total_bytes||total!==undefined&&(total!==page.total_bytes||revision!==page.revision))
      throw new Error('Invalid native model fragment');
    parts.push(page.json);offset=page.next_offset;total=page.total_bytes;revision=page.revision;
    if(offset===total)return {events:JSON.parse(parts.join('')),complete:page.complete,status:page.status.state};
  }
}

/** One physical DSH follow reads durable events and transient model data independently. */
export async function* followAssistant(view,llm,signal,snapshot){
  const {session,call,advance}=view;
  let revision=0,cursor={control_seq:view.controlThrough??0,fact_seq:view.through},active,opening=true;
  let after=session.seq;
  const reads=new FollowReads(),stop=new AbortController();
  const lifetime=AbortSignal.any([signal,stop.signal]);
  const wait=()=>reads.watch('durable',view.wait?view.wait(cursor,after,lifetime):call({type:'wait',cursor},lifetime));
  const baseline=()=>({revision,...(active?{activeAttempt:{...active.identity,nextIndex:active.index,
    stream:active.projection.stream.snapshot()}}:{})});
  async function start(){
    const mapping=view.mapping,current=mapping.model;
    if(current?.startedAt==null)return;
    const key=randomUUID(),identity={attemptId:current.effectId,turn:mapping.turn,step:mapping.step,
      startedAfterSeq:current.startedAfterSeq};
    await call({type:'model_open',key,effect:current.effectId});
    const attempt={key,identity,index:0,frames:[],projection:null};
    attempt.projection=modelProjection(llm,current.startedAt,({time,chunk})=>{
      const frame={type:'chunk',attemptId:identity.attemptId,revision:++revision,index:attempt.index++,time,chunk};
      if(!opening)attempt.frames.push(frame);
    });
    active=attempt;reads.watch('model',modelBatch(call,key));
    return {type:'start',...identity,revision:++revision};
  }
  async function close(){
    if(active)await view.releaseModel(active.key);
    active=undefined;reads.forget('model');
  }
  try{
    wait();
    await start();
    if(!active){opening=false;after=session.seq;yield await snapshot(baseline(),true);}
    while(!signal.aborted){
      const next=await reads.next();
      if(next.source==='model'){
        const batch=next.value;
        for(const [time,event] of batch.events)active.projection.accept(time,event);
        if(opening&&batch.complete){opening=false;after=session.seq;yield await snapshot(baseline());}
        for(const frame of active.frames.splice(0))yield {type:'assistant-stream',frame};
        if(!batch.complete||batch.status==='streaming')reads.watch('model',modelBatch(call,active.key));
        continue;
      }
      cursor=next.value;
      const first=after;
      const committed=await advance(cursor.fact_seq,active?.identity.attemptId,cursor.control_seq);
      const events=session.snapshotEvents(first);after=session.seq;
      const ended=active&&view.mapping.model?.effectId!==active.identity.attemptId;
      if(!opening&&ended&&committed) {
        const stream=llm.expandAssistantStream(session.eventAt(committed.seq).data.stream);
        if(stream.length<active.index)throw Error('Committed assistant stream lost its live prefix');
        while(active.index<stream.length){
          const {time,chunk}=stream[active.index];
          yield {type:'assistant-stream',frame:{type:'chunk',attemptId:active.identity.attemptId,
            revision:++revision,index:active.index++,time,chunk}};
        }
      }
      let end;
      if(ended){
        const frame={type:'end',attemptId:active.identity.attemptId,revision:++revision,index:active.index,
          outcome:committed??{kind:'abandoned'}};
        await close();
        end={type:'assistant-stream',frame};
      }
      if(!opening){
        for(const event of events){
          yield {type:'event',event};
          if(end&&event.seq===committed?.seq){yield end;end=undefined;}
        }
        if(end)yield end;
      }
      if(!active){
        const frame=await start();
        if(frame&&!opening)yield {type:'assistant-stream',frame};
      }
      if(opening&&!active){opening=false;after=session.seq;yield await snapshot(baseline());}
      wait();
    }
  }finally{stop.abort();await close();}
}

/** Original Agent observers receive the retained prefix as ordinary dense frames. */
export async function* followAgentAssistant(view,llm,signal) {
  const snapshot=assistantStream=>({type:'snapshot',assistantStream});
  for await(const entry of followAssistant(view,llm,signal,snapshot)) {
    if(entry.type!=='snapshot'){yield entry;continue;}
    yield {type:'snapshot'};
    const active=entry.assistantStream.activeAttempt;if(!active)continue;
    const {attemptId,turn,step}=active;
    yield {type:'assistant-stream',frame:{type:'start',attemptId,turn,step}};
    const stream=llm.expandAssistantStream(active.stream);
    if(stream.length!==active.nextIndex)throw Error('Assistant prefix changed its chunk count');
    for(const [index,{time,chunk}] of stream.entries())
      yield {type:'assistant-stream',frame:{type:'chunk',attemptId,index,time,chunk}};
  }
}
