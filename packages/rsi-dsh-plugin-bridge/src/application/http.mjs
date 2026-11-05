import {timingSafeEqual} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {SidebarBodyError} from './sessions.mjs';

// Wrap the public route seats. Cordis still owns ordering, matching, index
// transforms, disposal, and termination of upgraded sockets.
export async function provideHttp(ctx,load,key,sessionScope) {
  const {WebServer} = await load('@deepseek-ai/dsh-host-webserver');
  const {HostConnectionService,API_PATH} = await load('@deepseek-ai/dsh-client-connection');
  const expected = Buffer.from(key);
  function authenticated(req) {
    const value = req.headers instanceof Headers ? req.headers.get('x-rsi-upstream-key') : req.headers['x-rsi-upstream-key'];
    return typeof value === 'string' && value.length === 64 && Buffer.byteLength(value) === expected.length &&
      timingSafeEqual(Buffer.from(value),expected);
  }
  function guarded(handler) {
    return async (req,res) => {
      if (!authenticated(req)) {res.writeHead(403).end(); return;}
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
        return scoped(allowed=>sessionScope.respond(res,()=>handler(allowed,res)));
      }
      return handler(req,res);
    };
  }
  function resource(read) {
    return async (request,peer)=>{
      if(peer!==undefined)return read(request,peer);
      if(!authenticated(request))return new Response(null,{status:403});
      if(!sessionScope)return read(request);
      let scoped;
      try {scoped=await sessionScope.prepare(request,request.headers.get('x-rsi-upstream-request'));}
      catch {return new Response(null,{status:403});}
      return scoped(()=>read(request));
    };
  }
  function documentRequest(request) {
    const url=new URL(request.url);
    if(url.pathname!=='/document'&&!url.pathname.startsWith('/document/'))return request;
    url.pathname=url.pathname.slice('/document'.length)||'/';
    return new Request(url,request);
  }
  function mount(register,route) {
    const release=register(route);
    try {
      const alias='resource' in route ? {resource:(request,peer)=>route.resource(documentRequest(request),peer)} : {handler(req,...rest) {
        req.url=req.url.slice('/document'.length);
        return route.handler(req,...rest);
      }};
      const mounted=register({...route,...alias,path:'/document'+route.path});
      return ()=>{mounted();release();};
    } catch(error) {release();throw error;}
  }
  class PrivateServer extends WebServer {
    register(route) {
      const seat='resource' in route ? {resource:resource(route.resource)} : {handler:guarded(route.handler)};
      return mount(value=>super.register(value),{...route,...seat});
    }
    registerFallback(handler) {
      if(typeof handler!=='function') {
        const read=resource(handler.resource);
        return super.registerFallback({resource:(request,peer)=>read(documentRequest(request),peer)});
      }
      const read=guarded(handler);
      return super.registerFallback((req,res) => {
        if (req.url.startsWith('/document/')) req.url = req.url.slice('/document'.length);
        return read(req,res);
      });
    }
    registerUpgrade(route) {
      return mount(value=>super.registerUpgrade(value),{...route,async handler(req,socket,head) {
        if (!authenticated(req)) {socket.destroy(); return;}
        if(sessionScope) {
          let scoped;
          try {scoped=await sessionScope.prepare(req);}
          catch {socket.destroy();return;}
          return scoped(allowed=>{
            // A raw upgraded socket emits from the earlier TCP accept context.
            // Keep subsequent WS frames on the same authorized request.
            const emit=socket.emit;
            socket.emit=AsyncLocalStorage.bind(emit);
            socket.once('close',()=>{socket.emit=emit;});
            return route.handler(allowed,socket,head);
          });
        }
        return route.handler(req,socket,head);
      }});
    }
  }
  await (await ctx.plugin(PrivateServer,{host:'127.0.0.1',port:0})).await();
  class Connection extends HostConnectionService {
    isTrusted(request) {return authenticated(request);}
  }
  const connection = new Connection(ctx,[],{
    isAuthenticated:authenticated,authenticateApi:()=>undefined,
    authorizeIndex(req,res) {
      if (authenticated(req)) return true;
      res.writeHead(403); res.end(); return false;
    },
    authenticatedUrl:base => base,
  });
  const carrier = connection.createSharedFetchHandler(API_PATH);
  ctx.effect(() => ctx.webServer.register({kind:'prefix',path:API_PATH,async handler(req,res) {
    const admission = connection.admit(req);
    if ('rejection' in admission) {res.writeHead(admission.rejection).end(); return;}
    const abort = new AbortController();
    res.once('close',()=>abort.abort());
    const request = new Request(new URL(req.url,'http://'+req.headers.host),{
      method:req.method,headers:req.headers,signal:abort.signal,
      ...(!['GET','HEAD'].includes(req.method) ? {body:ReadableStream.from(req.iterator({destroyOnReturn:false})),duplex:'half'} : {}),
    });
    let response;
    try {response = await carrier.fetch(request,admission.peer);}
    finally {
      // A handler can reject before reading an upload. Release its adapter
      // without destroying IncomingMessage's response socket, then discard.
      if(!request.body?.locked)await request.body?.cancel();
      req.resume();
    }
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if (response.body) await pipeline(Readable.fromWeb(response.body),res);
    else res.end();
  }}));
  return connection;
}
