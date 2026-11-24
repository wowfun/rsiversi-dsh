import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const hostServices=new Set(['dsh-workspace','dsh-typert-loader','dsh-config-editor','dsh-settings','dsh-api-settings-controller','dsh-agent-preset-registry',
  'dsh-host-directory-picker-auto','dsh-host-open-in-app','dsh-host-plugin-inventory','dsh-commands','dsh-session-title','dsh-session-stats','dsh-session-turn-outline','dsh-storage',
  'dsh-storage-json','dsh-storage-domain','dsh-schedule','dsh-skill','dsh-skill-office','dsh-attachment-local','dsh-session-query-sqlite','dsh-message-feedback','dsh-command-feedback',
  'dsh-cordis-host-runner','dsh-subprocess-local','dsh-sandbox-local','dsh-sandbox-policy','dsh-fs-sandbox',
  'dsh-bash-sandbox','dsh-pwsh-sandbox','dsh-shell-env','dsh-jobs-local','dsh-action-cards'].map(name=>'@deepseek-ai/'+name));
const managerServices=new Set(['@deepseek-ai/dsh-creation-recommendations','@deepseek-ai/dsh-plugin-recommendations']);

/** Project the native Session's preset and mount its packaged skills in Agent scope. */
export async function provideWorkbenchPresets(ctx,modules,boot,load) {
  const web=modules.directory('@deepseek-ai/dsh-web-app');
  const manifest=JSON.parse(await readFile(join(web,'package.json'),'utf8'));
  const patches=new Set(manifest.dsh.bundle.patch),configs=new Map();
  const name='@deepseek-ai/dsh-skill-filesystem';
  const [{interpolate},filesystem,{agentPresetProjectionDefinition}]=await Promise.all([
    load('@deepseek-ai/cordis-plugin-loader'),load(name),load('@deepseek-ai/dsh-agent-preset-registry'),
  ]);
  const selection=await ctx.sessionProjections.register(agentPresetProjectionDefinition);
  function configFor(preset){
    const patch=`./presets/${preset}.patch.yml`;
    if(!patches.has(patch))return;
    if(!configs.has(preset)){
      const file=join(web,patch);
      const rows=boot.composeEntries([boot.loadOverlayPatches('rsi-dsh',file)]);
      const definition=rows.find(row=>row.config?.id===preset);
      const provider=definition?.config.plugins.find(row=>row.name===name&&row.disabled!==true);
      const config=provider&&interpolate({ctx,baseUrl:pathToFileURL(file).href},provider.config);
      configs.set(preset,config&&{...config,includeDefaultRoots:false,watch:false});
    }
    return configs.get(preset);
  }
  ctx.on('agent/created',async ({agent})=>{
    let provider,active;
    const select=preset=>{
      const config=configFor(preset);
      if(config===active)return;
      active=config;
      const retired=provider?.dispose();
      provider=config?agent.ctx.plugin(filesystem,config):undefined;
      return Promise.all([retired,provider?.await()]);
    };
    agent.ctx.on('session/event',(session,event)=>{
      if(session===agent.session&&event.type==='agent-preset/selected')return select(event.data.agentPreset);
    });
    await select(selection.stateOf(agent.session));
  });
}

/** Use the released app's ordered client entries and published dsh.client
 * declarations. A backend requiring a missing service remains pending; third
 * party bundle activation still requires its actual Fiber to be active. */
export async function workbenchProfile(modules,boot,state,{importer=false,language=false}={}) {
  const patches=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'].map(name=>
    boot.loadOverlayPatches('rsi-dsh',join(modules.directory(name),'cordis.patch.yml')));
  const composed=boot.composeEntries(patches);
  const rows=[], clientOnly=new Set();
  for(const entry of composed) {
    if(!entry.name || entry.disabled===true) continue;
    const parts=entry.name.split('/');
    const name=parts.slice(0,entry.name.startsWith('@')?2:1).join('/');
    if(name!==entry.name) continue;
    // Its DSH journal setters cannot change the native Turn's permissions.
    if(name==='@deepseek-ai/dsh-client-ui-permission-presets') continue;
    const manifest=JSON.parse(await readFile(join(modules.directory(name),'package.json'),'utf8'));
    const client=manifest.dsh?.client?.platform==='web';
    const optionalHost=importer&&managerServices.has(name)||language&&name==='@deepseek-ai/dsh-session-title-first-prompt-llm';
    if(!client && !hostServices.has(name) && !optionalHost) continue;
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
  rows.push({id:'web',name:'@deepseek-ai/dsh-web-app',config:{openBrowser:false,printUrl:false}});
  return {rows,clientOnly};
}
