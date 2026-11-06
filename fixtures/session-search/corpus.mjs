/** Identical public DSH v4 logs for both providers; no native database mutation. */
export function searchCorpus({sessions=12,events=24,cwd='/search-workspace'}={}) {
  return Array.from({length:sessions},(_,index)=>({
    header:{version:4,id:'search-'+index,createdAt:index+1,isSeeded:false,
      cwd:index===sessions-1?cwd+'-other':cwd,...(index===1?{parentSession:'search-0'}:{})},
    events:Array.from({length:events},(_,seq)=>messageEvent(seq,'archive needle session'+index+' event'+seq)),
  }));
}

export function messageEvent(seq,text) {
  return {type:'user/message',seq,time:seq+1,data:{id:'message:'+seq+':'+text,role:'user',content:[{type:'text',text}],source:{kind:'user'}},surfaceOp:'append'};
}
