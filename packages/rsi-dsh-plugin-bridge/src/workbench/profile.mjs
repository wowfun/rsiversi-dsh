import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';

const hostServices=new Set(['dsh-typert-loader','dsh-config-editor','dsh-settings','dsh-api-settings-controller',
  'dsh-host-open-in-app','dsh-host-plugin-inventory','dsh-commands','dsh-session-title','dsh-storage',
  'dsh-storage-json','dsh-storage-domain','dsh-schedule','dsh-attachment-local','dsh-session-query-sqlite','dsh-message-feedback',
  'dsh-cordis-host-runner','dsh-subprocess-local','dsh-sandbox-local','dsh-sandbox-policy',
  'dsh-bash-sandbox','dsh-pwsh-sandbox','dsh-shell-env','dsh-jobs-local'].map(name=>'@deepseek-ai/'+name));

/** Use the released app's ordered client entries and published dsh.client
 * declarations. A backend requiring a missing service remains pending; third
 * party bundle activation still requires its actual Fiber to be active. */
export async function workbenchProfile(modules,boot,state) {
  const patches=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'].map(name=>
    boot.loadOverlayPatches('rsi-dsh',join(modules.directory(name),'cordis.patch.yml')));
  const composed=boot.composeEntries(patches);
  const rows=[], clientOnly=new Set();
  for(const entry of composed) {
    if(!entry.name || entry.disabled===true) continue;
    const parts=entry.name.split('/');
    const name=parts.slice(0,entry.name.startsWith('@')?2:1).join('/');
    if(name!==entry.name) continue;
    const manifest=JSON.parse(await readFile(join(modules.directory(name),'package.json'),'utf8'));
    const client=manifest.dsh?.client?.platform==='web';
    if(!client && !hostServices.has(name)) continue;
    if(name==='@deepseek-ai/dsh-client-connection')rows.push({id:entry.id,name});
    else if(name==='@deepseek-ai/dsh-storage-json')rows.push({...entry,config:{...entry.config,root:join(state,'storages')}});
    else if(name==='@deepseek-ai/dsh-attachment-local')rows.push({...entry,config:{...entry.config,dshHome:state}});
    else if(name==='@deepseek-ai/dsh-sandbox-policy'){
      // The application launches in a leased package, outside any user workspace.
      const workspaceRoot=join(state,'shell-workspace');
      await mkdir(workspaceRoot,{recursive:true,mode:0o700});
      rows.push({...entry,config:{...entry.config,workspaceRoot}});
    }
    else rows.push(entry);
    // The module table observes the original Loader fiber and publishes its
    // client face independently of the backend service becoming available.
    if(client) clientOnly.add(entry.id);
  }
  rows.push({id:'web',name:'@deepseek-ai/dsh-web-app',config:{openBrowser:false,printUrl:false}},
    {id:'discover',name:'@deepseek-ai/dsh-client-ui-plugin-market'});
  return {rows,clientOnly};
}
