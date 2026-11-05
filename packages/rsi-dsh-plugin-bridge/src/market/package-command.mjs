import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {createConnection,createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Peer} from '../../../rsi-dsh-cordis/src/runtime/transport.mjs';

/** DSH's ProfilePnpmInvocation launches this command for official Discover.
 * The very same managed operation is also available to dshmarket in-process. */
export async function packageCommand(profile,runtime) {
  const dir=await mkdtemp(join(tmpdir(),'rsi-market-command-'));
  const endpoint=process.platform==='win32'?'\\\\.\\pipe\\rsi-market-'+randomUUID():join(dir,'command.sock');
  const generation=randomBytes(32).toString('hex'), sockets=new Set();
  const server=createServer(socket=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
    const peer=new Peer({input:socket,output:socket,generation,onClose:()=>socket.destroy(),
      handler:async(method,{cwd,args},signal)=>{
        if(method!=='package.run' || resolve(cwd)!==resolve(profile) || !Array.isArray(args)) throw new Error('Invalid managed package command');
        const handle=runtime.runPlugin(args,cwd,signal);
        async function forward(stream,name) {
          for await(const chunk of stream) {
            const bytes=Buffer.from(chunk);
            for(let offset=0;offset<bytes.length;offset+=32*1024)
              await peer.request('package.output',{name,data:bytes.subarray(offset,offset+32*1024).toString('base64')},{signal});
          }
        }
        const [result]=await Promise.all([handle.done,forward(handle.stdout,'stdout'),forward(handle.stderr,'stderr')]);
        return result;
      }});
  });
  try {server.listen(endpoint);await once(server,'listening');}
  catch(error){server.close();await rm(dir,{recursive:true,force:true});throw error;}
  return {invocation:{command:process.execPath,args:[fileURLToPath(import.meta.url),endpoint],
    env:{RSI_DSH_PACKAGE_GENERATION:generation}},
    async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}};
}
if(import.meta.main) {
  const [endpoint,...args]=process.argv.slice(2), socket=createConnection(endpoint);
  await once(socket,'connect');
  const peer=new Peer({input:socket,output:socket,generation:process.env.RSI_DSH_PACKAGE_GENERATION,onClose:()=>socket.destroy(),
    handler:async(method,{name,data})=>{
      if(method!=='package.output' || !['stdout','stderr'].includes(name)) throw new Error('Invalid package output');
      const stream=name==='stdout'?process.stdout:process.stderr;
      if(!stream.write(Buffer.from(data,'base64'))) await once(stream,'drain');
      return null;
    }});
  try {
    const result=await peer.request('package.run',{cwd:process.cwd(),args});
    process.exitCode=result.exitCode;
  } finally {peer.close();socket.destroy();}
}
