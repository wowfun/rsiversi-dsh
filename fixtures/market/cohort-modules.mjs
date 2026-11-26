import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Load fixture packages with the installed DSH host's public ESM resolver. */
export async function cohortModules(root) {
  const parent=pathToFileURL(join(root,'package.json')).href;
  const bootstrap=createRequire(parent).resolve('@deepseek-ai/dsh-app-boot');
  const {resolvePluginResource}=await import(pathToFileURL(bootstrap));
  const entry=name=>resolvePluginResource(name,parent);
  return {entry,load:name=>import(pathToFileURL(entry(name))),directory:name=>dirname(entry(name+'/package.json'))};
}
