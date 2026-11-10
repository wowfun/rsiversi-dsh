import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Resolve the installed cohort and its published search patch, without pinning source hashes. */
export async function searchDistribution(cohort) {
  const require=createRequire(join(cohort,'package.json'));
  const modules={entry:name=>require.resolve(name),directory:name=>dirname(require.resolve(name+'/package.json'))};
  const load=name=>import(pathToFileURL(modules.entry(name)));
  const directory=modules.directory('@deepseek-ai/dsh-experimental-session-search');
  const manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
  const boot=await load('@deepseek-ai/dsh-app-boot');
  const patches=boot.loadOverlayPatches('session-search-acceptance',join(directory,manifest.dsh.bundle.patch));
  return {modules,load,patches,version:manifest.version};
}
