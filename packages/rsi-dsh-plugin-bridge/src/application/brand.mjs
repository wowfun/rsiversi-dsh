import {randomUUID} from 'node:crypto';
import {chmod,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const brandModule='rsi-dsh-plugin-bridge';
async function publishAsset(source,target) {
  const temporary=target+'.'+randomUUID();
  try {
    await writeFile(temporary,await readFile(source),{flag:'wx'});
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
  await writeFile(join(browser,'brand.client.js'),`{\n${registration}${client}\n}\n`);
  await publishAsset(new URL('brand-host.mjs',source),join(browser,'brand-host.mjs'));
  await publishAsset(logo,join(directory,'assets/logo.svg'));
  await writeFile(join(directory,'package.json'),JSON.stringify({name:brandModule,version:'0.1.0',
    type:'module',exports:{'.':'./src/browser/brand-host.mjs','./client':'./src/browser/brand.client.js','./package.json':'./package.json'},
    dsh:{client:{platform:'web',inject:[...dependencies]}}},null,2));
  return join(browser,'brand-host.mjs');
}
