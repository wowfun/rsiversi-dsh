import {readFile,stat} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {workerData} from 'node:worker_threads';
import {Peer} from '../../../rsi-dsh-cordis/src/runtime/transport.mjs';
import {installReleaseResolver} from '../../../rsi-dsh-cordis/src/release/resolver.mjs';
import {createApplication} from './application.mjs';
import {leasedPluginPackages} from './package-metadata.mjs';
import {provideHttp} from './http.mjs';
import {importRelease} from '../../../rsi-dsh-cordis/src/release/import.mjs';
import {createMarketProfile} from '../market/market-profile.mjs';
import {linkProfilePackage} from '../market/profile-files.mjs';
import {applicationSessions} from './sessions.mjs';
import {workspaceController} from '../workbench/workspace-controller.mjs';
import {sessionController} from '../workbench/session-controller.mjs';
import {jobController} from '../workbench/job-controller.mjs';
import {workbenchProfile} from '../workbench/profile.mjs';
import {packageCommand} from '../market/package-command.mjs';
import {brandModule,publishBrand} from './brand.mjs';
import {moveRegistryCache,profileState,registryCache,viewNpm} from '../../../rsi-dsh-cordis/src/registry/npm-install.mjs';
import {replayableInstalls} from '../market/install-receipts.mjs';
import {workbenchHistory} from '../workbench/history.mjs';
import {sessionJournalStore} from '../session/session-journal-store.mjs';
import {workbenchPersistence} from '../workbench/persistence.mjs';
import {workbenchAgents} from '../workbench/agents.mjs';
import {terminalController} from '../terminal/controller.mjs';
import {applicationTools} from '../tools/application-tools.mjs';
import {workbenchInteractions} from '../workbench/interactions.mjs';
import {watchWorkbenchCatalog} from '../workbench/catalog.mjs';

const [generation,layoutFile,...paths] = process.argv.slice(2);
if (!generation || !layoutFile || paths.length % 2) throw new Error('Invalid package launch');
for (const name of ['log','info','warn','debug']) console[name] = console.error;
const roots = new Map();
for (let i=0;i<paths.length;i+=2) roots.set(paths[i],paths[i+1]);
const npmRoot=roots.get('--npm');
roots.delete('--npm');
const layout = JSON.parse(await readFile(layoutFile,'utf8'));
let modules, app, opening, nativeSessions;
async function open({protocol,profile,key,owner,importer,timings=false,tools=false}) {
  const start=performance.now();
  if (protocol !== 12 || !/^[0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{64}$/.test(owner)) throw new Error('Invalid application.open');
  modules=installReleaseResolver(layout,roots,profile);
  const boot = await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-app-boot')));
  // DSH's own metadata and Typert loaders also use Node lookup from the
  // profile. This view holds links to the already leased release packages.
  for (const location of Object.keys(layout.locations)) {
    const name=location.slice('node_modules/'.length);
    if(name.includes('/node_modules/') || layout.plugins.includes(name) ||
      !(name.startsWith('@deepseek-ai/') || ['cordis','react','react-dom'].includes(name))) continue;
    await linkProfilePackage(profile,name,modules.directory(name),modules.setProfileLink);
  }
  let market;
  const {rows,clientOnly}=await workbenchProfile(modules,boot,profileState(profile));
  const official='@deepseek-ai/dsh-client-ui-brand-official';
  const manifest=JSON.parse(await readFile(join(modules.directory(official),'package.json'),'utf8'));
  const brand=await publishBrand(join(profile,'.rsi-brand'),new URL('../browser/rsiversi.svg',import.meta.url),
    {client:modules.entry(official+'/client'),inject:manifest.dsh.client.inject});
  const original=rows.findIndex(row=>row.name===official);
  if(original>=0) rows.splice(original,1,{id:'rsi-brand',name:brandModule});
  const applicationModules={...modules,entry:name=>name===brandModule?brand:modules.entry(name)};
  const base = [{insert:rows}];
  const refresh = async (candidate,bundles,options) => {
    const layers = [...bundles];
    const patch = join(profile,'cordis.patch.yml');
    const file = await stat(patch).catch(error => {if (error.code !== 'ENOENT') throw error;});
    if (file) {
      if (!file.isFile() || file.size > 1024*1024) throw new Error('Profile patch exceeds capacity');
      layers.push(boot.loadOverlayPatches('rsi-dsh',patch));
    }
    return candidate.reconcile(layers,options);
  };
  // RSI supplies the authenticated carrier. Its original JS client export
  // still resolves through the release layout for the browser module graph.
  const hostModules=new Map([['@deepseek-ai/dsh-client-connection',{inject:['connection'],apply(){}}]]);
  const setup=performance.now();
  let toolListener,retireToolOutcome,sessionScope;
  const candidate = await createApplication({modules:applicationModules,profile,hostModules,clientOnly,baseRows:base[0].insert,provide:async (ctx,load) => {
    const call=(method,args,signal)=>peer.request(method,args,{signal});
    let persistence,agents,history;
    const storage=sessionJournalStore(join(profileState(profile),'sessions'),await load('@deepseek-ai/dsh-atomic-write'),()=>ctx.emit('rsi/catalog-projection'));
    sessionScope=applicationSessions(call,{owner,agent:id=>agents?.get(id),attached:()=>agents?.sessions(),decorate:storage.decorate,
      select:(request,signal)=>history.selectModel(request,signal),
      capture:async(id,signal)=>agents?.get(id)?(await agents.refresh(id,signal)).session:persistence.capture(id,signal)});
    nativeSessions=sessionScope;
    const {TypertRemoteService,RemoteError}=await load('@deepseek-ai/dsh-typert-protocol');
    const interactions=workbenchInteractions(ctx,sessionScope,await load('@deepseek-ai/dsh-scope'));
    const api=Object.assign({},await load('@deepseek-ai/dsh-session'),await load('@deepseek-ai/dsh-session/surface'),await load('@deepseek-ai/dsh-util-values'));
    history=workbenchHistory({ctx,api,llm:await load('@deepseek-ai/dsh-llm'),read:sessionScope.history,release:sessionScope.releaseHistory,
      listChildren:sessionScope.subagents.listChildren,authorize:sessionScope.authorize,command:sessionScope.command,
      submit:sessionScope.submit,inbox:sessionScope.inbox,
      storage,creationMeta:(id,createdAt)=>agents?.creationMeta(id,createdAt),
      retireToolOutcome:(...args)=>retireToolOutcome?.(...args)});
    ctx.effect(()=>()=>history.close(),'flush application Session journals');
    persistence=workbenchPersistence(history,await load('@deepseek-ai/dsh-session-persistence'),sessionScope.storedPages);
    const {SessionTitleInvalidError}=await load('@deepseek-ai/dsh-session-title');
    const {Deque}=await load('@deepseek-ai/dsh-deque');
    hostModules.set('@deepseek-ai/dsh-api-session-controller',sessionController({TypertRemoteService,RemoteError,SessionTitleInvalidError,Deque},sessionScope,history,interactions,
      (id,signal)=>agents.ensure(id,signal)));
    hostModules.set('@deepseek-ai/dsh-api-workspace-controller',workspaceController(TypertRemoteService,sessionScope,RemoteError));
    const jobName='@deepseek-ai/dsh-api-job-controller';
    if(rows.some(row=>row.name===jobName))hostModules.set(jobName,jobController((await load(jobName)).default,history));
    const terminalName='@deepseek-ai/dsh-api-terminal-controller';
    const terminal=await load(terminalName);
    hostModules.set(terminalName,terminalController({TypertRemoteService,RemoteError},sessionScope,terminal.default.Config({})));
    ctx.provide('sessions',{...sessionScope.sessions,flush:session=>agents.flush(session)});
    ctx.provide('sessionPersistence',persistence);
    ctx.provide('workingDirectory',sessionScope.workingDirectory);
    ctx.provide('subagents',sessionScope.subagents);
    await provideHttp(ctx,load,key,sessionScope);
    await ctx.plugin(leasedPluginPackages(boot,modules));
    let packageManager;
    if (importer) {
      const state=profileState(profile);
      await moveRegistryCache(profile);
      const managerName='@deepseek-ai/dsh-plugin-manager';
      hostModules.set(managerName,await replayableInstalls((await load(managerName)).default,state,await load('@deepseek-ai/dsh-atomic-write')));
      market=await createMarketProfile({modules,profile,boot,state,
        inUse:graph=>candidate.usesPayload([...graph.roots].filter(([name])=>!roots.has(name)).map(([,dir])=>dir)),
        manager:()=>ctx.get('pluginManager'),
        view:async(spec,fields,registry,signal)=>{
          const selection=layout.toolchain;
          if(!selection) throw new Error('The application has no selected registry toolchain');
          const held=await call('application.payloads',{package:selection.name,digest:selection.digest,
            export:'runtime',dependency_export:'runtime'},signal);
          return viewNpm(join(held.profile,'node_modules/npm'),spec,fields,registry,registryCache(profile),signal);
        },
        call,reconcile:bundles=>refresh(candidate,bundles),active:id=>[...ctx.loader.entries()].some(entry=>
          (entry.id===id || entry.options.id===id) && entry.fiber?.state===ctx.loader.ctx.fiber.state)});
      ctx.provide('desktopProfiles',market.desktopProfiles);
      ctx.provide('desktopPnpm',market.desktopPnpm);
      ctx.provide('hmr',market.hmr);
      const command=await packageCommand(profile,market.packageRunner);
      ctx.effect(()=>()=>command.close(),'managed package command');
      packageManager=command.invocation;
      for(const [id,name] of [['plugin-manager','dsh-plugin-manager'],['plugin-market','dsh-plugin-market']]) {
        const selected={id,name:'@deepseek-ai/'+name};
        const index=base[0].insert.findIndex(row=>row.id===id);
        if(index===-1) base[0].insert.push(selected);else base[0].insert[index]=selected;
      }
    }
    ctx.provide('profileContext',{name:basename(profile),dir:profile,
      patchPath:join(profile,'cordis.patch.yml'),installAnchor:join(modules.directory('@deepseek-ai/dsh'),'package.json'),
      cwd:profile,home:dirname(profile),startedBundles:[],overlays:[],telemetryDisabledEnv:'1',packageManager});
    for (const name of ['dsh-session-projection','dsh-system-prompt','dsh-tools']) {
      const module = await load('@deepseek-ai/'+name);
      await ctx.plugin(module.default);
    }
    const agentApi=await load('@deepseek-ai/dsh-agent');
    await ctx.plugin(agentApi.AgentRegistry);
    agents=await workbenchAgents(ctx,sessionScope,history,await load('@deepseek-ai/dsh-scope'),agentApi,api.snapshotJsonValue);
    if(tools){
      base[0].insert.push({id:'tool-schedule',name:'@deepseek-ai/dsh-tool-schedule'});
      await (await ctx.plugin((await load('@deepseek-ai/dsh-user-approval')).default,{})).await();
      const {retireOutcome,...listener}=await applicationTools(ctx,{load,key,generation,directory:tools.outcomeDirectory,sessions:sessionScope,
        resolveAgent:(id,signal)=>sessionScope.runOwned(()=>agents.ensure(id,signal),signal)});
      toolListener=listener;retireToolOutcome=retireOutcome;
    }
  }});
  const composed=performance.now();
  try {
    const warnings=await refresh(candidate,market ? await market.layers(true) : [],{restore:true});
    for(const warning of warnings) console.warn('DSH profile:',warning);
    app = candidate;
    watchWorkbenchCatalog(app.ctx,sessionScope);
    return {protocol,port:app.ctx.webServer.port,prefixes:['/document','/plugins','/api','/sidebar','/dsh-market','/rsi-brand'],
      ...(toolListener?{tools:toolListener}:{}),
      ...(timings?{timings:{setup_ms:Math.round(setup-start),composition_ms:Math.round(composed-setup),reconcile_ms:Math.round(performance.now()-composed)}}:{})};
  } catch(error) {
    try {await candidate.close();}finally{await sessionScope?.close();}
    throw error;
  }
}
let closing;
function close() {
  return closing ??= (async () => {
    await opening?.catch(()=>{});
    // Plugin disposal can still cancel its native work. Retire the caller after Cordis drains.
    try {await app?.close();} finally {
      try{await nativeSessions?.close();}finally{modules?.close();}
    }
  })();
}
const peer = new Peer({port:workerData,generation,handler:async (method,args,signal) => {
  if (method==='extension.close') {await close();return null;}
  if (method==='package.import' && npmRoot && !opening && !closing) {
    opening=importRelease(layout,npmRoot,args,signal);
    return opening;
  }
  if (method!=='application.open' || opening || closing) throw new Error('Application operation unavailable');
  opening = open(args);
  return opening;
},onClose:close});
