import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Extract the original shell composition, including its platform conditions,
 * from the installed web preset for a focused compatibility run. */
export async function shellPreset(cohort,preset) {
  const require=createRequire(join(cohort,'package.json'));
  const boot=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
  const directory=dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json'));
  const patches=boot.loadOverlayPatches('shell-acceptance',join(directory,'presets',preset+'.patch.yml'));
  const entries=boot.composeEntries([patches]).find(row=>row.config?.id===preset).config.plugins;
  const ids=preset==='standard'?['tool-bash','tool-pwsh']:['persistent-shell'];
  return ids.map(id=>{
    const entry=entries.find(row=>row.id===id);
    if(!entry)throw new Error('Missing '+id+' in the '+preset+' release preset');
    return entry;
  });
}
