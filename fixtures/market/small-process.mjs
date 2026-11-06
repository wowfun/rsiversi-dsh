// Isolate the native application lifecycle from npm graph verification.
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Peer} from './transport.mjs';
let key;
const server=createServer((req,res)=>{
  if(req.headers['x-rsi-upstream-key']!==key || !req.headers['x-rsi-upstream-request']) {res.writeHead(403).end();return;}
  res.writeHead(200).end('native application probe');
});
new Peer({input:process.stdin,output:process.stdout,generation:process.argv[2],handler:async(method,args)=>{
  if(method==='extension.hello') return {protocol:1};
  if(method==='extension.ping') return null;
  if(method==='extension.close') {server.close();return null;}
  if(method!=='application.open' || args.protocol!==8) throw new Error('Unknown application operation or protocol');
  key=args.key;
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {protocol:args.protocol,port:server.address().port,prefixes:['/document']};
},onClose:()=>{server.close();process.stdin.destroy();}});
