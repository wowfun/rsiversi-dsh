import {randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, readlink, rename, symlink, unlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {packageLocation} from '../../../rsi-dsh-cordis/src/release/layout.mjs';

export async function readProfileManifest(path,fallback) {
  const text=await boundedText(path);
  return text===undefined?fallback:JSON.parse(text);
}
export async function save(path,value,limit=profileTextLimit) {
  const text=JSON.stringify(value,null,2)+'\n';
  if(Buffer.byteLength(text)>limit)throw new Error(`${basename(path)} exceeds profile capacity (${limit} bytes)`);
  await writeAtomic(path,text);
}
async function writeAtomic(path,value) {
  const temporary=path+'.'+randomUUID()+'.tmp';
  try {await writeFile(temporary,value,{flag:'wx',mode:0o600});await rename(temporary,path);}
  finally {await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

const profileTextLimit=1024*1024;
async function boundedBytes(path,limit=profileTextLimit) {
  const chunks=[];
  let size=0;
  try {
    for await(const chunk of createReadStream(path)) {
      size+=chunk.length;
      if(size>limit) throw new Error(`${basename(path)} exceeds profile capacity (${limit} bytes)`);
      chunks.push(chunk);
    }
  } catch(error) {if(error.code==='ENOENT')return undefined;throw error;}
  return Buffer.concat(chunks);
}
export async function boundedText(path,limit) {return (await boundedBytes(path,limit))?.toString('utf8');}

const recoveryLimits={'package.json':profileTextLimit,'cordis.yml':profileTextLimit,
  'cordis.patch.yml':profileTextLimit,'pnpm-lock.yaml':16*1024*1024};
const recoveryFiles=Object.keys(recoveryLimits);
const recoveryLimit=Object.values(recoveryLimits).reduce((total,limit)=>total+Math.ceil(limit/3)*4,profileTextLimit);
const selectionLimit=128;
const recoveryPath=path=>path+'.recovery';
export async function discardRecovery(path) {
  await unlink(recoveryPath(path)).catch(error=>{
    if(error.code!=='ENOENT')console.warn('Profile recovery snapshot cleanup pending:',String(error.message??error).slice(0,500));
  });
}
export async function captureRecovery(path,profile,managed=true) {
  const snapshot={id:randomUUID(),files:await captureProfileFiles(profile,managed)};
  await save(recoveryPath(path),snapshot,recoveryLimit);
  return {...snapshot,touched:[]};
}
export async function saveSelections(path,installed,rollback=null) {
  const journal={format:3,installed,rollback:rollback===null?null:{id:rollback.id,touched:rollback.touched}};
  validateSelections(journal);
  await save(path,journal,profileTextLimit);
  if(rollback===null)await discardRecovery(path);
}
export async function captureProfileFiles(profile,managed=true) {
  return Object.fromEntries(await Promise.all((managed?recoveryFiles:['package.json']).map(async name=>
    [name,(await boundedBytes(join(profile,name),recoveryLimits[name]))?.toString('base64')??null])));
}
export async function restoreProfileFiles(profile,files) {
  for(const [name,value] of Object.entries(files)) {
    const path=join(profile,name);
    if(value===null)await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
    else await writeAtomic(path,typeof value==='string'?Buffer.from(value,'base64'):value);
  }
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
function validateSelections(journal) {
  if(journal?.format!==3)throw new Error('Unsupported host selection journal format (expected 3); existing state was left unchanged');
  if(!journal.installed || typeof journal.installed!=='object' || Array.isArray(journal.installed)
    || journal.rollback!==null && (!Array.isArray(journal.rollback?.touched)||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(journal.rollback.id)))
    throw new Error('Invalid host selection journal');
  if(Object.keys(journal.installed).length>selectionLimit || (journal.rollback?.touched.length??0)>selectionLimit)
    throw new Error('Profile journal exceeds selection capacity');
  for(const name of [...Object.keys(journal.installed),...(journal.rollback?.touched??[])]) {
    if(packageLocation('node_modules/'+name)!==name) throw new Error('Invalid host selection name');
  }
  for(const row of Object.values(journal.installed)) if(
    !/^rsi-dsh-selection-[a-z0-9-]+$/.test(row?.package) || !/^[a-f0-9]{64}$/.test(row?.digest) ||
      typeof row.version!=='string' || !row.version.length || row.version.length>256) throw new Error('Invalid host selection');
}
function validateRecoveryFiles(files) {
  if(!files || typeof files!=='object' || Array.isArray(files))throw new Error('Invalid Profile recovery files');
  const names=Object.keys(files);
  if(!(names.length===1&&names[0]==='package.json') &&
    !(names.length===recoveryFiles.length&&recoveryFiles.every(name=>Object.hasOwn(files,name))))
    throw new Error('Invalid Profile recovery files');
  for(const [name,value] of Object.entries(files)) {
    if(value===null)continue;
    const limit=recoveryLimits[name];
    if(typeof value!=='string'||value.length>Math.ceil(limit/3)*4)throw new Error('Invalid Profile recovery file: '+name);
    const decoded=Buffer.from(value,'base64');
    if(decoded.length>limit||decoded.toString('base64')!==value)throw new Error('Invalid Profile recovery bytes: '+name);
    files[name]=decoded;
  }
}
export async function readSelections(path) {
  const bytes=await boundedBytes(path);
  if(bytes===undefined)return {format:3,installed:{},rollback:null};
  const journal=JSON.parse(bytes);
  validateSelections(journal);
  if(journal.rollback) {
    const snapshotBytes=await boundedBytes(recoveryPath(path),recoveryLimit);
    if(snapshotBytes===undefined)throw new Error('Missing Profile recovery snapshot');
    const snapshot=JSON.parse(snapshotBytes);
    if(snapshot?.id!==journal.rollback.id)throw new Error('Profile recovery snapshot does not match its journal');
    validateRecoveryFiles(snapshot.files);
    journal.rollback.files=snapshot.files;
  }
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
