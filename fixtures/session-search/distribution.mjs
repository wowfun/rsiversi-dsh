import {cohortModules} from '../market/cohort-modules.mjs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Resolve the installed cohort and its published search patch, without pinning source hashes. */
export async function searchDistribution(cohort) {
  const modules=await cohortModules(cohort),{load}=modules;
  const directory=modules.directory('@deepseek-ai/dsh-experimental-session-search');
  const manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
  const boot=await load('@deepseek-ai/dsh-app-boot');
  const patches=boot.loadOverlayPatches('session-search-acceptance',join(directory,manifest.dsh.bundle.patch));
  return {modules,load,patches,version:manifest.version};
}
