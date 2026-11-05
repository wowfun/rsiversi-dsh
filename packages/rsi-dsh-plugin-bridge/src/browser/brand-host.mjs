import {readFile} from 'node:fs/promises';

export function apply(ctx) {
  ctx.inject(['webServer'],async scope=>{
    const data=await readFile(new URL('../../assets/logo.svg',import.meta.url));
    scope.effect(()=>scope.webServer.register({kind:'exact',path:'/rsi-brand/logo.svg',handler(req,res) {
      if (req.method!=='GET' && req.method!=='HEAD') {res.writeHead(405).end();return;}
      res.writeHead(200,{'content-type':'image/svg+xml','content-length':data.length,'x-content-type-options':'nosniff'});
      res.end(req.method==='HEAD'?undefined:data);
    }}),'RSI brand asset');
  });
}
