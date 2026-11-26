import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';

const hostServices=new Set(['dsh-workspace','dsh-typert-loader','dsh-config-editor','dsh-settings','dsh-api-settings-controller','dsh-agent-loop','dsh-agent-preset-registry','dsh-agent-preset',
  'dsh-host-directory-picker-auto','dsh-host-open-in-app','dsh-host-plugin-inventory','dsh-commands','dsh-goal','dsh-session-title','dsh-session-stats','dsh-session-turn-outline','dsh-token-meter','dsh-storage',
  'dsh-storage-json','dsh-storage-domain','dsh-schedule','dsh-skill','dsh-skill-office','dsh-office-kit','dsh-attachment-local','dsh-session-query-sqlite','dsh-message-feedback','dsh-command-feedback',
  'dsh-cordis-host-runner','dsh-subprocess-local','dsh-sandbox-local','dsh-sandbox-policy','dsh-fs-sandbox',
  'dsh-bash-sandbox','dsh-pwsh-sandbox','dsh-shell-env','dsh-jobs-local','dsh-action-cards',
  'dsh-user-questions','dsh-permission-presets','dsh-web','dsh-web-fetch-http','dsh-ptc-runtime-node',
  'dsh-subagent','dsh-subagent-spawn-in-process','dsh-tool-subagent/model-selection-settings'].map(name=>'@deepseek-ai/'+name));
const managerServices=new Set(['@deepseek-ai/dsh-creation-recommendations','@deepseek-ai/dsh-plugin-recommendations']);

/** Preserve scoped workbench contributions declared by the packaged native counterpart. */
export async function packagedPresetPlugins(ctx,rows,load,{tools=false,importer=false}={}) {
  const definitions=rows.filter(row=>row.name==='@deepseek-ai/dsh-agent-preset');
  const {interpolate}=await load('@deepseek-ai/cordis-plugin-loader');
  function contributions(entries) {
    return entries.flatMap(entry=>{
      if(entry.disabled===true)return [];
      if(entry.name==='cordis:group'&&Array.isArray(entry.config)){
        const config=contributions(entry.config);
        return config.length?[{...entry,config}]:[];
      }
      if(entry.name==='@deepseek-ai/dsh-skill-filesystem'){
        const config=interpolate({ctx,baseUrl:ctx.baseUrl},entry.config);
        return [{...entry,config:{...config,includeDefaultRoots:false,watch:false}}];
      }
      if(tools && (entry.name==='@deepseek-ai/dsh-tool-schedule' || entry.name==='@deepseek-ai/dsh-tool-skill'
        || importer && entry.name==='@deepseek-ai/dsh-plugin-manager/tools'))return [entry];
      return ['@deepseek-ai/dsh-compaction-basic','@deepseek-ai/dsh-command-compact'].includes(entry.name)?[entry]:[];
    });
  }
  return preset=>contributions(definitions.find(row=>row.config.id===preset)?.config.plugins??[]);
}

/** Use the released app's ordered client entries and published dsh.client
 * declarations. A backend requiring a missing service remains pending; third
 * party bundle activation still requires its actual Fiber to be active. */
export async function workbenchProfile(modules,boot,state,{importer=false,language=false}={}) {
  const patches=await Promise.all(['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'].map(async name=>{
    const dir=modules.directory(name);
    const {dsh}=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
    return boot.bundlePatchPaths(dir,dsh.bundle).flatMap(file=>boot.loadOverlayPatches('rsi-dsh',file));
  }));
  const composed=boot.composeEntries(patches);
  const rows=[], clientOnly=new Set();
  for(const entry of composed) {
    if(!entry.name || entry.disabled===true) continue;
    const name=entry.name;
    if(name==='@deepseek-ai/dsh-web-app'){
      rows.push({id:entry.id,name,config:{openBrowser:false,printUrl:false}});
      continue;
    }
    // Client declarations belong to package roots. Host entries may select a public subpath.
    const root=name.split('/').length===(name.startsWith('@')?2:1);
    const client=root&&JSON.parse(await readFile(join(modules.directory(name),'package.json'),'utf8')).dsh?.client?.platform==='web';
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
  return {rows,clientOnly};
}
