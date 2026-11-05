import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runtimePayloads,splitPayloads} from './layout.mjs';
import {writePayloadFiles} from '../archive/payload.mjs';

export const digest = bytes=>createHash('sha256').update(bytes).digest('hex');
export const json = value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
export async function writeShards(destination,groups,version,target,signal) {
  const artifacts=[],locations={};
for(const [owner,packages] of groups) {
  const parts=owner==='runtime'?runtimePayloads(packages):splitPayloads(packages);
  for(const [i,part] of parts.entries()) {
    const name='rsi-dsh-'+(owner==='runtime'?'runtime':digest(owner).slice(0,16))+'-'+i;
    const dir=join(destination,name); await mkdir(dir);
    const data=await writePayloadFiles(part.flatMap(pkg=>pkg.files),join(dir,'payload.rsi'),signal);
    const bytes=json({format:2,name,version,target:target,dependencies:[],requires:[],
      files:[{path:'payload.rsi',bytes:data.bytes,digest:data.digest,executable:false}],
      exports:{runtime:{kind:'payload_tree',path:'payload.rsi'}}});
    await writeFile(join(dir,'package.json'),bytes);
    for(const pkg of part) locations[pkg.location] = {package:name,version:pkg.version,dependencies:pkg.dependencies};
    artifacts.push({name,owner,files:data.files,bytes:data.bytes,payloadDigest:data.digest,manifestDigest:digest(bytes)});
  }
}
  return {artifacts,locations};
}
