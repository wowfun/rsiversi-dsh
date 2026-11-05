import {setTimeout as delay} from 'node:timers/promises';
import {FollowReads} from '../workbench/follow-reads.mjs';

export async function* attachTerminal(scope,controller,session,key,input,window,signal) {
  const {terminal,catalog}=await controller.binding(session,key,signal);
  const stop=new AbortController(),active=AbortSignal.any([signal,stop.signal]);
  const operate=async(type,fields={})=>{
    const reply=await scope.terminal(session,{type:'operate',operation:{type,terminal:terminal.id,...fields}},active);
    return reply.value;
  };
  const attached=await operate('attach');
  const attachment=attached.id,uplink=input[Symbol.asyncIterator]();
  let cursor=0,stream=attached.stream_epoch,sequence=0,commands=0,writes=0;
  let status=attached.terminal,first=true;
  const writable=(terminal=status)=>terminal.phase.state==='running'&&terminal.controller===attachment;
  const info=()=>controller.info(session,key,status,catalog);
  const reads=new FollowReads();
  const read=()=>reads.watch('output',operate('read',{attachment,stream_epoch:stream,cursor}));
  const next=()=>reads.watch('input',uplink.next());
  async function write(command) {
    const bytes=Array.from(Buffer.from(command.data));
    if(!bytes.length)return;
    const identity={epoch:status.controller_epoch,sequence:++writes};
    let receipt=await operate('input',{attachment,bytes,...identity});
    while(receipt.result.state==='pending') {
      await delay(20,undefined,{signal:active});
      receipt=await operate('receipt',identity);
    }
    if(receipt.result.state!=='accepted'||receipt.result.bytes!==bytes.length)
      throw new Error('Terminal input was not completely acknowledged');
  }
  try {
    if(status.phase.state==='running' && status.controller!==attachment)
      status=await operate('takeover',{attachment});
    read();
    while(!active.aborted) {
      const item=await reads.next();
      if(item.source==='output') {
        const page=item.value,prior=status;
        cursor=page.next_cursor;stream=page.stream_epoch;status=page.terminal;
        if(first){
          yield {type:'snapshot',sequence,screen:page.text,info:info(),writable:writable(),...(window?{inputWindow:window}:{})};
          next();
          first=false;
        } else {
          // Native resize and follower overflow replace the VT screen. The
          // Remote generation stays attached; its client accepts a single snapshot.
          const data=page.reset?'\x1bc'+page.text:page.text;
          if(data)yield {type:'output',sequence:++sequence,data};
          if(status.size.rows!==prior.size.rows||status.size.columns!==prior.size.columns||
            status.phase.state!==prior.phase.state||status.phase.exit_code!==prior.phase.exit_code||
            writable()!==writable(prior))yield {type:'state',info:info(),writable:writable()};
        }
        if(status.phase.state!=='running'&&!page.text)return;
        read();
      } else {
        const {value:command,done}=item.value;
        if(done)continue;
        if(command.sequence!==++commands)throw new Error('Terminal input sequence has a gap');
        let refusal;
        if(!writable())refusal=status.phase.state==='running'?'read-only':'not-running';
        else try {
          if(command.type==='write')await write(command);
          else if(command.type==='resize') {
            status=await operate('resize',{attachment,epoch:status.controller_epoch,size:{rows:command.rows,columns:command.cols}});
            yield {type:'state',info:info(),writable:writable()};
          } else throw new Error('Unsupported terminal input');
        } catch(error) {
          status=(await controller.binding(session,key,active)).terminal;
          if(writable())throw error;
          refusal=status.phase.state==='running'?'read-only':'not-running';
        }
        yield {type:'ack',sequence:command.sequence,...(refusal?{refusal}:{})};
        next();
      }
    }
  } finally {
    stop.abort();
    try {await uplink.return?.();}
    finally {await scope.releaseTerminal(attachment);}
  }
}
