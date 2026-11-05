import {randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join, relative, resolve} from 'node:path';
import {packageLocation} from '../../../rsi-dsh-cordis/src/release/layout.mjs';

export async function readJson(path,fallback) {
  try {return JSON.parse(await readFile(path,'utf8'));}
  catch (error) {if(error.code==='ENOENT') return fallback;throw error;}
}
export async function save(path,value) {
  const temporary=path+'.'+randomUUID()+'.tmp';
  try {await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await rename(temporary,path);}
  finally {await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

const profileTextLimit=1024*1024;
async function boundedText(path) {
  const chunks=[];
  let size=0;
  try {
    for await(const chunk of createReadStream(path)) {
      size+=chunk.length;
      if(size>profileTextLimit) throw new Error('Profile state exceeds capacity');
      chunks.push(chunk);
    }
  } catch(error) {if(error.code==='ENOENT')return undefined;throw error;}
  return Buffer.concat(chunks).toString('utf8');
}
export async function publishReleaseAgeDefault(profile) {
  const path=join(profile,'.npmrc'),line='minimum-release-age=0\n';
  const entry=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(!entry){
    await writeFile(path,line,{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    return;
  }
  if(!entry.isFile()||entry.nlink>1||!(entry.mode&0o222)||entry.size>profileTextLimit)return;
  const config=await boundedText(path);
  if(config!==undefined&&!/^\s*minimum-release-age\s*=/im.test(config)){
    await writeFile(path,(config&&!config.endsWith('\n')?'\n':'')+line,{flag:'a'});
  }
}
export async function buildDecisions(profile,modules) {
  const policy=await boundedText(join(profile,'pnpm-workspace.yaml'));
  if(policy===undefined)return {};
  const parser=createRequire(modules.entry('@deepseek-ai/dsh-plugin-manager'))('yaml');
  const document=parser.parse(policy,{maxAliasCount:0});
  return Object.fromEntries(Object.entries(document?.allowBuilds??{})
    .filter(([name,value])=>typeof value==='boolean' && !/[*?]/.test(name)));
}
export async function readSelections(path) {
  const text=await boundedText(path);
  if(text===undefined) return {installed:{},preparing:[]};
  const journal=JSON.parse(text);
  if(!journal || !journal.installed || typeof journal.installed!=='object' || Array.isArray(journal.installed)
    || !Array.isArray(journal.preparing)) throw new Error('Invalid host selection journal');
  for(const name of [...Object.keys(journal.installed),...journal.preparing]) {
    if(packageLocation('node_modules/'+name)!==name) throw new Error('Invalid host selection name');
  }
  for(const row of Object.values(journal.installed)) if(row!==null &&
    (!/^rsi-dsh-selection-[a-z0-9-]+$/.test(row?.package) || !/^[a-f0-9]{64}$/.test(row?.digest) ||
      typeof row.version!=='string' || !row.version.length || row.version.length>256)) throw new Error('Invalid host selection');
  return journal;
}

export async function linkProfilePackage(profile,name,root,publish) {
  const link=join(profile,'node_modules',name);
  let current;
  try {current=await readlink(link);}
  catch(error) {
    if(error.code==='EINVAL') throw new Error('Profile package view collides with '+name,{cause:error});
    if(error.code!=='ENOENT') throw error;
  }
  if(current!==undefined) {
    if(relative(resolve(dirname(link),current),root)==='') {
      publish?.(name,root);
      return;
    }
    await unlink(link);
    publish?.(name,undefined);
  } else await mkdir(dirname(link),{recursive:true});
  await symlink(root,link,process.platform==='win32'?'junction':'dir');
  publish?.(name,root);
}

export async function unlinkProfilePackage(profile,name,publish) {
  if(packageLocation('node_modules/'+name)!==name) throw new Error('Invalid removed plugin name');
  const link=join(profile,'node_modules',name);
  const old=await lstat(link).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(old && !old.isSymbolicLink()) throw new Error('Removed package view is not a managed link: '+name);
  if(old) await unlink(link);
  publish?.(name,undefined);
}
