import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

function approvalCard(row) {
  const {review}=row;
  const toolName=row.action.startsWith('run tool ')?row.action.slice(9):row.action;
  if(!review)return {toolName,reason:row.reason};
  const location=review.execution?.binding.location;
  const target=location&&location.kind!=='local'?' · '+JSON.stringify(location):'';
  const argumentsText=JSON.stringify(review.arguments);
  const detail=[row.reason,review.sandbox,review.cwd+target,argumentsText].filter(Boolean).join(' · ');
  const english='Run '+toolName+'? '+detail;
  return {toolName,reason:english,displayReason:{en:english,zh:'允许运行 '+toolName+'？ '+detail}};
}

function questionCard(row) {
  const reviewLabels=row.review?.choices.map((choice,i)=>String(i+1)+'. '+choice.label);
  return {questions:row.questions.map(q=>({id:q.id,question:q.prompt,
    options:(reviewLabels??q.options).map(label=>({label})),multiSelect:false}))};
}

function questionAnswer(row,reply) {
  const answers=reply?.answers;
  if(!Array.isArray(answers)||answers.length!==row.questions.length)throw Error('Incomplete DSH question answer');
  const ordered=row.questions.map(q=>{
    const value=answers.find(answer=>answer.id===q.id);
    if(!value||!Array.isArray(value.selected)||value.selected.length>1)throw Error('Invalid DSH question selection');
    return value;
  });
  if(row.review){
    const selected=ordered[0].selected[0];
    const index=questionCard(row).questions[0].options.findIndex(choice=>choice.label===selected);
    if(index<0)throw Error('Closed review requires a displayed choice');
    return {answers:[],review:{binding:row.review.binding,choice_id:row.review.choices[index].id,feedback:ordered[0].custom??null}};
  }
  return {answers:ordered.map(({custom,selected})=>custom?.trim()||selected[0])};
}

async function snapshot(next) {
  let encoded='',offset=0,total;
  do {
    const part=await next();
    if(!Number.isSafeInteger(part.total_bytes)||part.total_bytes>33*1024*1024||
      (total!==undefined&&total!==part.total_bytes)||part.offset!==offset||
      part.next_offset!==offset+Buffer.byteLength(part.json)||part.next_offset<=offset||part.next_offset>part.total_bytes)
      throw Error('Invalid native interaction snapshot');
    encoded+=part.json;offset=part.next_offset;total=part.total_bytes;
  }while(offset<total);
  return JSON.parse(encoded);
}

/** DSH owns the browser Peer, card, waterfall and reply correlation. */
export function workbenchInteractions(ctx,scope,{scopeTarget}){
  const groups=new Map();
  async function ask(group,stop,session,kind,row){
    const agent={id:session,ctx};
    const card=kind==='approval'?approvalCard(row):questionCard(row);
    const event=kind==='approval'?'approval/request':'user-questions/request';
    const reply=await ctx.waterfall(scopeTarget(agent,agent),event,{...card,agent,signal:stop.signal},()=>Promise.resolve(undefined));
    if(stop.signal.aborted||reply===undefined)return;
    let operation;
    if(kind==='approval'){
      if(reply!=='allowed-once'&&reply!=='rejected')return;
      operation={type:'approval',owner:row.subject.session_id,id:row.id,decision:reply==='allowed-once'?'allow_once':'deny'};
    }else{
      operation={type:'question',id:row.id,answer:questionAnswer(row,reply)};
    }
    for(const view of group.views){
      if(view.signal.aborted)continue;
      try{await view.call(operation,view.signal);return;}
      catch(error){if(!view.signal.aborted)throw error;}
    }
  }
  function reconcile(group,session,rows){
    const visible=new Set();
    for(const [kind,items] of [['approval',rows.approvals],['question',rows.questions]]){
      for(const row of items){
        const owner=kind==='approval'?row.subject.session_id:row.session_id;
        const id=JSON.stringify([kind,owner,row.id]);
        visible.add(id);
        if(group.pending.has(id))continue;
        const stop=new AbortController();
        group.pending.set(id,stop);
        void ask(group,stop,session,kind,row).catch(error=>{
          if(!stop.signal.aborted)console.error('DSH interaction delivery:',error.message);
        });
      }
    }
    for(const [id,stop] of group.pending)if(!visible.has(id)){group.pending.delete(id);stop.abort();}
  }
  async function read(group,session,view){
    const key=randomUUID(),{signal,call}=view;
    await call({type:'open',key},signal);
    try{
      while(!signal.aborted){
        const rows=await snapshot(()=>call({type:'next',key},signal));
        if(!signal.aborted)reconcile(group,session,rows);
      }
    }finally{await call({type:'close',key}).catch(()=>{});}
  }
  async function run(group,session) {
    while(group.views.size){
      const view=group.views.values().next().value;
      try{await read(group,session,view);}
      catch(error){if(!view.signal.aborted)view.failed(error);}
      finally{group.views.delete(view);}
    }
    if(groups.get(session)===group)groups.delete(session);
    for(const stop of group.pending.values())stop.abort();
  }
  async function observe(session,signal){
    signal.throwIfAborted();
    let group=groups.get(session);
    const first=!group;
    if(first){group={views:new Set(),pending:new Map()};groups.set(session,group);}
    const ended=Promise.withResolvers();
    const view={signal,call:AsyncLocalStorage.bind((op,stop)=>scope.interactions(session,op,stop)),failed:ended.reject};
    group.views.add(view);
    const remove=()=>{group.views.delete(view);ended.resolve();};
    signal.addEventListener('abort',remove,{once:true});
    if(first)void run(group,session);
    try{await ended.promise;}
    finally{signal.removeEventListener('abort',remove);group.views.delete(view);}
  }
  return {observe};
}
