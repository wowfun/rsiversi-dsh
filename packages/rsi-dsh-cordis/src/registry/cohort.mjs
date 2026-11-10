import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

/** PackageStore owns this installed tree. Select service identities from it,
 * including resource-only packages, without resolving executable entry points. */
export async function installedPeers(root) {
  const names=(await readdir(join(root,'node_modules/@deepseek-ai')))
    .filter(name=>!name.startsWith('.')).sort().map(name=>'@deepseek-ai/'+name);
  const top=new Set(await readdir(join(root,'node_modules')));
  names.push(...['react','react-dom','zod'].filter(name=>top.has(name)));
  const packages=new Map();
  for(const name of names) {
    const manifest=JSON.parse(await readFile(join(root,'node_modules',name,'package.json'),'utf8'));
    packages.set(name,manifest);
  }
  return packages;
}

export async function packPeers(root,packages,archive,tar,signal) {
  const dependencies={};
  for(const name of packages.keys()) {
    signal.throwIfAborted();
    const target=join(archive,createHash('sha256').update(name).digest('hex')+'.tgz');
    await tar.c({gzip:true,file:target,cwd:join(root,'node_modules',name),prefix:'package',
      filter:path=>!path.split(/[\\/]/).includes('.rsi-namespace-pin')},['.']);
    dependencies[name]='file:'+target.replaceAll('\\','/');
  }
  return dependencies;
}
