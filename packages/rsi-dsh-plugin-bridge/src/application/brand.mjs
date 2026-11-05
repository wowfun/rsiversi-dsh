import {randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const brandModule='rsi-dsh-plugin-bridge';
async function matchesFile(target,bytes) {
  let offset=0;
  try {
    // Read at most one byte beyond the expected content to detect a longer file.
    for await(const chunk of createReadStream(target,{end:bytes.length})) {
      if(!chunk.equals(bytes.subarray(offset,offset+chunk.length)))return false;
      offset+=chunk.length;
    }
  } catch(error) {
    if(error.code==='ENOENT')return false;
    throw error;
  }
  return offset===bytes.length;
}

async function publishFile(target,bytes) {
  if(await matchesFile(target,bytes))return;
  const temporary=target+'.'+randomUUID();
  try {
    await writeFile(temporary,bytes,{flag:'wx'});
    try {await rename(temporary,target);}
    catch(error) {
      if(process.platform!=='win32'||!['EACCES','EPERM'].includes(error.code)) throw error;
      await chmod(target,0o600);
      await rename(temporary,target);
    }
  } finally {await rm(temporary,{force:true});}
}
export async function publishBrand(directory,logo,official) {
  const source=new URL('../browser/',import.meta.url);
  const browser=join(directory,'src/browser');
  await mkdir(browser,{recursive:true});
  await mkdir(join(directory,'assets'),{recursive:true});
  const client=await readFile(new URL('brand.client.js',source),'utf8');
  const dependencies=new Set(['@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-ui-sidebar']);
  let registration='';
  if(official) {
    for(const dependency of official.inject) dependencies.add(dependency);
    // Capture the published module's ordinary loader registration. Each
    // document selects its factory before any brand occupies the single slots.
    registration=`let originalBrand;
      (function(window){\n${await readFile(official.client,'utf8')}\n})({
        __ModuleLoader__:{load(definition){ originalBrand=definition; }}
      });\n`;
  }
  await publishFile(join(browser,'brand.client.js'),Buffer.from(`{\n${registration}${client}\n}\n`));
  await publishFile(join(browser,'brand-host.mjs'),await readFile(new URL('brand-host.mjs',source)));
  await publishFile(join(directory,'assets/logo.svg'),await readFile(logo));
  await publishFile(join(directory,'package.json'),Buffer.from(JSON.stringify({name:brandModule,version:'0.1.0',
    type:'module',exports:{'.':'./src/browser/brand-host.mjs','./client':'./src/browser/brand.client.js','./package.json':'./package.json'},
    dsh:{client:{platform:'web',inject:[...dependencies]}}},null,2)));
  return join(browser,'brand-host.mjs');
}
