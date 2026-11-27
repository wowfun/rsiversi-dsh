const registryName='@deepseek-ai/dsh-deepseek-llm-api-extensions';
const logName='@deepseek-ai/dsh-session-log-deepseek';

/** The released registry owns fields and callbacks. Publish whether the native
 * adapter needs its request boundary at all, including after plugin retirement. */
export async function workbenchDeepSeekFields(modules,load,publish) {
  const [{default:Registry},log]=await Promise.all([load(registryName),load(logName)]);
  const names=new Set();
  let logEnabled,announced=false,pending;
  const active=()=>names.size>(names.has('dsh_session_log') && logEnabled?.get()===false ? 1 : 0);
  function sync() {
    if(!pending && announced!==active()){
      pending=Promise.resolve().then(async()=>{
        while(announced!==active()){
          const enabled=active();
          await publish(enabled);
          announced=enabled;
        }
      }).finally(()=>{pending=undefined;});
      // The Loader may emit without awaiting listeners; flush observes failures.
      pending.catch(()=>{});
    }
    return pending;
  }
  modules.set(registryName,class extends Registry {
    register(name,provider){
      const release=super.register(name,provider);
      const unwatch=this.ctx.effect(()=>{
        names.add(name);sync();
        return ()=>{names.delete(name);sync();};
      });
      return async()=>{await release();await unwatch();};
    }
  });
  modules.set(logName,{...log,async apply(ctx,config){
    logEnabled=config.enabled;
    ctx.on('loader/volatile-update',sync);
    ctx.effect(()=>()=>{if(logEnabled===config.enabled)logEnabled=undefined;});
    await log.apply(ctx,config);
    await sync();
  }});
  return {flush:sync};
}

/** Keep the acceptance closure on the same request socket until the native
 * provider receives headers. Abandoning the socket leaves its prefix pending. */
export function modelFieldRoute(ctx,WebSocketServer,scope,refresh,auth) {
  const server=new WebSocketServer({noServer:true,maxPayload:384*1024*1024,perMessageDeflate:false});
  ctx.effect(()=>()=>{for(const socket of server.clients)socket.terminate();server.close();});
  function connected(socket){
    const stop=new AbortController();
    socket.once('close',()=>stop.abort());
    socket.on('error',()=>socket.terminate());
    let phase='origin',origin,session,accept;
    async function frame(data,binary){
      if(phase==='origin'&&!binary){
        origin=JSON.parse(data);
        phase='body';return;
      }
      if(phase==='body'&&binary){
        phase='preparing';
        let decoded;
        const prepared=await scope.runOwned(async()=>{
          session=origin.sessionId && await refresh(origin.sessionId,origin.activeSession,stop.signal);
          if(session)scope.exposeSessionView(session);
          return ctx.get('deepseekLlmApiExtensions')?.prepare({
            get body(){
              if(data!==undefined){decoded=JSON.parse(data);data=undefined;}
              return decoded;
            },
            signal:stop.signal,
            ...(origin.sessionId==null?{}:{sessionId:origin.sessionId}),
            ...(origin.purpose==null?{}:{purpose:origin.purpose})});
        },stop.signal);
        let fields='{}';
        if(prepared){
          try{fields=JSON.stringify(prepared.fields);}
          catch{ctx.logger.warn('DeepSeek omitted application fields that could not be serialized');}
        }
        stop.signal.throwIfAborted();
        accept=fields==='{}'?undefined:prepared.accept;
        phase='prepared';
        socket.send(fields,{binary:true});
        if(!accept)socket.close();
        return;
      }
      if(phase==='prepared'&&accept&&!binary&&data.toString()==='accept'){
        phase='settling';
        await scope.runOwned(()=>{
          if(session)scope.exposeSessionView(session);
          return accept();
        },stop.signal);
        socket.send('ok');socket.close();
        return;
      }
      throw Error('Unexpected model field frame');
    }
    socket.on('message',(data,binary)=>{frame(data,binary).catch(()=>socket.terminate());});
  }
  return {path:'/rsi-model-fields',auth,handler:(req,socket,head)=>server.handleUpgrade(req,socket,head,connected)};
}
