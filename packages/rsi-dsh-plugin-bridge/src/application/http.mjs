import {timingSafeEqual} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {isIP} from 'node:net';
import {SidebarBodyError} from './sessions.mjs';
import {serveShareEntry} from './share-entry.mjs';

// Wrap the public route seats. Cordis still owns ordering, matching, index
// transforms, disposal, and termination of upgraded sockets.
export async function provideHttp(ctx,load,key,sessionScope,refreshModelSession) {
  const {WebServer} = await load('@deepseek-ai/dsh-host-webserver');
  const inProcess = new AsyncLocalStorage();
  const publicRequest = new AsyncLocalStorage();
  const projectedSockets = new WeakSet();
  const expected = Buffer.from(key);
  function nativeOwner(req) {
    return (req.headers instanceof Headers ? req.headers.get('x-rsi-upstream-owner') : req.headers['x-rsi-upstream-owner']) === '1';
  }
  function authenticated(req,name='x-rsi-upstream-key') {
    const value = req.headers instanceof Headers ? req.headers.get(name) : req.headers[name];
    return typeof value === 'string' && value.length === 64 && Buffer.byteLength(value) === expected.length &&
      timingSafeEqual(Buffer.from(value),expected);
  }
  function guarded(handler) {
    return async (req,res,peer) => {
      if(sessionScope) {
        let scoped;
        try {
          scoped=await sessionScope.prepare(req);
        }
        catch(error) {
          if(res.headersSent) {res.destroy();return;}
          const badBody=error instanceof SidebarBodyError;
          res.writeHead(badBody?400:403,{'content-type':'application/json'}).end(JSON.stringify({ok:false,
            error:{code:badBody?'bad-request':'forbidden',message:String(error.message ?? error).slice(0,256)}}));
          return;
        }
        return scoped(allowed=>sessionScope.respond(res,()=>handler(allowed,res,peer)));
      }
      return handler(req,res,peer);
    };
  }
  function resource(read) {
    return async (request,peer)=>{
      if(inProcess.getStore() || !sessionScope)return read(request,peer);
      let scoped;
      try {scoped=await sessionScope.prepare(request,request.headers.get('x-rsi-upstream-request'));}
      catch {return new Response(null,{status:403});}
      return scoped(()=>read(request,peer));
    };
  }
  function documentPath(path) {
    if(path.startsWith('/document/'))return path.slice('/document'.length);
    if(path==='/document'||path.startsWith('/document?'))return '/'+path.slice('/document'.length);
    return path;
  }
  function withPublicPeer(req,run) {
    const origin=req.headers['x-rsi-upstream-origin'],peer=req.headers['x-rsi-upstream-peer'];
    if(origin===undefined&&peer===undefined)return run();
    if(typeof peer!=='string'||typeof origin!=='string')throw Error('Missing native listener coordinates');
    const split=peer.lastIndexOf(':'),address=peer.slice(0,split).replace(/^\[|\]$/g,''),port=Number(peer.slice(split+1));
    const family=isIP(address);
    if(!family||!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid native listener coordinates');
    const socket=req.socket;
    if(!projectedSockets.has(socket)){
      for(const key of ['remoteAddress','remoteFamily','remotePort']){
        const physical=socket[key];
        Object.defineProperty(socket,key,{configurable:true,get:()=>publicRequest.getStore()?.[key]??physical});
      }
      projectedSockets.add(socket);
    }
    return publicRequest.run({origin,remoteAddress:address,remotePort:port,remoteFamily:'IPv'+family},run);
  }
  let instance;
  class PrivateServer extends WebServer {
    constructor(scope,config){super(scope,config);instance=this;}
    getOrigin(){return publicRequest.getStore()?.origin??super.getOrigin();}
    readResource(request,peer) {
      const url=new URL(request.url);
      const path=documentPath(url.pathname);
      if(path!==url.pathname){url.pathname=path;request=new Request(url,request);}
      return inProcess.run(true,()=>super.readResource(request,peer));
    }
    register(route) {
      const seat='resource' in route ? {resource:resource(route.resource)} : {handler:guarded(route.handler)};
      return super.register({...route,...seat});
    }
    registerFallback(fallback) {
      if(typeof fallback!=='function' && 'resource' in fallback) {
        return super.registerFallback({...fallback,resource:resource(fallback.resource)});
      }
      const route=typeof fallback==='function'?{handler:fallback}:fallback;
      return super.registerFallback({...route,handler:guarded(route.handler)});
    }
    registerUpgrade(route) {
      const handler=async(req,socket,head,peer)=>{
        if (!authenticated(req) || !nativeOwner(req)) {socket.destroy(); return;}
        req.url=documentPath(req.url);
        if(sessionScope) {
          let scoped;
          try {scoped=await sessionScope.prepare(req);}
          catch {socket.destroy();return;}
          return scoped(allowed=>withPublicPeer(req,()=>{
            // A raw upgraded socket emits from the earlier TCP accept context.
            // Keep subsequent WS frames on the same authorized request.
            const emit=socket.emit;
            socket.emit=AsyncLocalStorage.bind(emit);
            socket.once('close',()=>{socket.emit=emit;});
            return route.handler(allowed,socket,head,peer);
          }));
        }
        return withPublicPeer(req,()=>route.handler(req,socket,head,peer));
      };
      const auth=typeof route.auth==='function'?facts=>{
        if(!authenticated(facts) || !nativeOwner(facts))return 'deny';
        return withPublicPeer(facts,()=>{
          if(facts.url.pathname===route.path)return route.auth(facts);
          const url=new URL(facts.url);url.pathname=route.path;
          return route.auth({...facts,url});
        });
      }:route.auth;
      const release=super.registerUpgrade({...route,handler,auth});
      try {
        const mounted=super.registerUpgrade({...route,handler,auth,path:'/document'+route.path});
        return ()=>{mounted();release();};
      } catch(error){release();throw error;}
    }
  }
  await (await ctx.plugin(PrivateServer,{host:'127.0.0.1',port:0,
    compression:'gzip',compressionLevel:1,compressionThresholdBytes:1024})).await();
  if(instance?.server)instance.server.keepAliveTimeout=0;
  if(refreshModelSession){
    const [{WebSocketServer},{modelFieldRoute}]=await Promise.all([load('ws'),import('../workbench/deepseek-fields.mjs')]);
    const route=modelFieldRoute(ctx,WebSocketServer,sessionScope,refreshModelSession,req=>
      !req.headers.origin && !req.headers['x-rsi-upstream-key'] && authenticated(req,'x-rsi-model-key')?'anonymous':'deny');
    ctx.effect(()=>WebServer.prototype.registerUpgrade.call(ctx.webServer,route));
  }
  ctx.on('webserver/request',(req,res,next)=>{
    if(!authenticated(req)){res.writeHead(403).end();return;}
    req.url=documentPath(req.url);
    if(!nativeOwner(req))return serveShareEntry(req,res);
    return withPublicPeer(req,next);
  });
  ctx.inject(['connection','connection.authentication'],scope=>{
    const owner=scope.connection.createPeer({principal:{kind:'owner'}});
    scope.connection.authentication.register({authenticate:req=>nativeOwner(req)&&authenticated(req)?owner:undefined});
  });
}
