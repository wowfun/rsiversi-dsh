/** Preserve a native stable prefix; open-tail content is reference text, never Facts. */
export function nativeForkSeed(parent,seed,source) {
  const local=event=>event.data?.rsi?.session===parent;
  const end=seed.findLastIndex(event=>event.type==='turn/end'&&local(event));
  const start=seed.findLastIndex((event,index)=>index>end&&event.type==='turn/start'&&local(event));
  if(start>=0)return {point:{kind:'before_turn',turn_id:seed[start].data.rsi.turn},
    context:openTurnContext(seed.slice(start))};
  if(end>=0)return {point:{kind:'through_turn',turn_id:seed[end].data.rsi.turn}};
  for(let seq=0;source&&seq<source.seq;seq++){
    const event=source.eventAt(seq);
    if(event.type==='turn/start'&&local(event))return {point:{kind:'before_turn',turn_id:event.data.rsi.turn}};
  }
  throw Error('Seeded creation requires a native source Turn');
}

function textBlocks(message,type='text') {
  return (message?.content??[]).filter(block=>block.type===type).map(block=>block.text??'').join('');
}

function openTurnContext(events) {
  const lines=[],calls=new Map();
  for(const event of events){
    const data=event.data;
    if(event.type==='user/message') {
      const text=textBlocks(data.message??data);
      if(text)lines.push('User input:\n'+text);
    }else if(event.type==='assistant/message'){
      for(const [kind,label] of [['text','Assistant output so far'],['reasoning','Reasoning so far']]){
        const text=textBlocks(data.message,kind);if(text)lines.push(label+':\n'+text);
      }
    }else if(event.type==='assistant/attempt'){
      const chunks={text:'',reasoning:''};
      for(const entry of data.stream??[]){
        if(entry.type==='text-chunks')chunks.text+=entry.texts.join('');
        if(entry.type==='reasoning-chunks')chunks.reasoning+=entry.texts.join('');
        if(entry.type==='chunk'&&entry.chunk?.type==='text-delta')chunks.text+=entry.chunk.text;
        if(entry.type==='chunk'&&entry.chunk?.type==='reasoning-delta')chunks.reasoning+=entry.chunk.text;
      }
      for(const [kind,text] of Object.entries(chunks))if(text)lines.push('Unfinished attempt '+kind+':\n'+text);
    }else if(event.type==='tool/call'){
      calls.set(data.callId,{name:data.name,args:data.arguments});
    }else if(event.type==='tool/result'){
      const id=data.message?.source?.callId??data.message?.toolCallId,call=calls.get(id);
      lines.push('Tool '+(call?.name??'result')+(data.error||data.message?.isError?' (failed)':'')+
        (call?' — arguments: '+call.args:'')+'\nResult: '+textBlocks(data.message).slice(0,2000));
      calls.delete(id);
    }
  }
  for(const call of calls.values())lines.push('Tool '+call.name+' (executing) — arguments: '+call.args);
  if(!lines.length)return undefined;
  const text=lines.join('\n\n');
  return 'Parent session in-progress turn (reference only):\n\n'+
    (text.length>8000?text.slice(0,8000)+'\n[Snapshot truncated]':text);
}
