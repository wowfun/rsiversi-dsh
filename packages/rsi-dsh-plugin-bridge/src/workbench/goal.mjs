function append(state,time,change) {
  return state.session.adoptObserved({type:'goal/change',seq:state.session.seq,time,
    data:{kind:'goal/change',version:1,...change}});
}

function snapshot(state,time,operation,goal,publishedAt) {
  const prior=state.goal;
  const event=append(state,time,{operation,goal,roundsStarted:prior?.roundsStarted??0,
    createdAt:prior?.createdAt??publishedAt,updatedAt:Math.max(prior?.updatedAt??publishedAt,publishedAt)});
  state.goal=event.data;
  return event;
}

function clear(state,time,publishedAt) {
  const prior=state.goal;
  const event=append(state,time,{operation:'clear',cleared:{id:prior.goal.id,revision:prior.goal.revision+1},
    clearedAt:Math.max(prior.updatedAt,publishedAt)});
  state.goal=undefined;
  return event;
}

/** Branches share the last immutable state until a Goal changes or one of its inputs enters a Step. */
export function observeGoal(state,{goal:{current:native,command},time}) {
  const publishedAt=command?.published_at_ms??time;
  if(!native)return state.goal&&clear(state,time,publishedAt);
  let appended;
  if(state.goal?.goal.id!==native.id) {
    if(state.goal&&state.goal.goal.phase!=='complete')clear(state,time,publishedAt);
    state.goal=undefined;
    appended=snapshot(state,time,'create',{id:native.id,revision:1,objective:native.objective.trim(),
      phase:'active',maxGoalRounds:native.max_rounds},publishedAt);
  }
  const current=state.goal.goal;
  if(command?.action==='edit')return snapshot(state,time,'edit',{...current,revision:current.revision+1,
    objective:native.objective.trim(),maxGoalRounds:native.max_rounds},publishedAt);
  const phase=native.phase==='completed'?'complete':native.phase;
  if(phase===current.phase&&command?.action!=='resume')return appended;
  const operation={active:'resume',paused:'pause',blocked:'block',complete:'complete'}[phase];
  if(!operation)throw Error('Unknown native Goal phase');
  const {blockedReason,...previous}=current;
  return snapshot(state,time,operation,{...previous,revision:previous.revision+1,phase,
    ...(phase==='blocked'?{blockedReason:{code:native.block_code??'rsi-goal',message:native.reason?.trim()||'The Host blocked the Goal.'}}:{})},publishedAt);
}

export function goalMessage(state,message,source) {
  const current=state.goal;
  if(source.domain.id!=='rsi.goal'||!current||current.goal.id!==source.owner||current.goal.phase!=='active')return message;
  const round=current.roundsStarted+1;
  state.goal={...current,roundsStarted:round};
  return {...message,source:{kind:'goal',goalId:source.owner,revision:current.goal.revision,round}};
}
