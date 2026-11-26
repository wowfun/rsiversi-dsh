import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {buildPolicy} from './build-policy.mjs';
import {join} from 'node:path';
import {readProfileManifest} from './profile-files.mjs';
import {withCleanup} from './cleanup.mjs';

// Cordis invokes service methods through a Proxy, which cannot access #private fields.
const installations=Symbol('managed package installations'),lifecycle=Symbol('managed package lifetime');

/** DSH management semantics with independently prepared Store candidates. */
export function managedPackages(Manager,market,{parseInstallSpec,classifyInstallFailure}) {
  return class extends Manager {
    [installations]=new Map();
    constructor(ctx,config){
      super(ctx,config);
      const lifetime=this[lifecycle]={ctx,abort:new AbortController(),operations:new Set(),waitMs:config.lockWaitMs??120000};
      ctx.effect(()=>async()=>{lifetime.abort.abort();await Promise.allSettled([...lifetime.operations]);},'staged package installations');
    }
    async replacement(spec) {
      const parsed=parseInstallSpec(spec);
      const name=parsed.kind==='registry'?parsed.name:parsed.kind==='path'
        ?(await readProfileManifest(join(parsed.path,'package.json'),{})).name:undefined;
      return name===undefined?undefined:(await this.listBundles()).find(row=>
        row.name===name && row.installed && row.availability==='profile' && row.removable);
    }
    async inspect(spec,options,signal) {
      const result=await super.inspect(spec,options,signal);
      if(result.status!=='refused' || result.problem!=='already-installed')return result;
      const previous=await this.replacement(spec);
      if(!previous)return result;
      const parsed=parseInstallSpec(spec);
      const {normalizeRegistry}=await import(pathToFileURL(market().modules.entry('@deepseek-ai/dsh-plugin-manager/registry')));
      const selected=options?.registry===undefined?(await this.registries()).registry:options.registry;
      return {status:'accepted',kind:parsed.kind,name:previous.name,bundle:true,
        registry:selected===null?null:normalizeRegistry(selected),replacement:true};
    }
    installBundle(spec,options={}) {
      const lifetime=this[lifecycle],current={requestId:options.requestId,phase:'preparing',abort:new AbortController()};
      const signal=AbortSignal.any([current.abort.signal,lifetime.abort.signal]);
      const result={application:'failed',changed:false,stage:'install',target:spec,enabled:options.enabled!==false};
      const operationId=randomUUID();
      const emit=(name,data)=>lifetime.ctx.emit(name,data);
      const announce=(phase,attempt)=>{if(options.requestId!==undefined)emit('plugin-manager/install-state',{requestId:options.requestId,phase,...(attempt?{attempt}:{})});};
      const operation=phase=>{void lifetime.ctx.parallel('plugin-manager/operation',{
        id:operationId,reason:'install',time:new Date().toISOString(),phase,stage:result.stage,target:result.bundle??spec,
        ...(phase==='settled'?{application:result.application,changed:result.changed,...(result.error?{errorCode:result.error.code}:{})}:{})
      }).catch(()=>{});};
      current.work=market().exclusive(async()=>{
        const {profile,modules}=market();
        const load=name=>import(pathToFileURL(modules.entry(name)));
        const [atomic,registry,boot]=await Promise.all([
          load('@deepseek-ai/dsh-atomic-write'),load('@deepseek-ai/dsh-plugin-manager/registry'),load('@deepseek-ai/dsh-app-boot'),
        ]);
        const yaml=createRequire(modules.entry('@deepseek-ai/dsh-plugin-manager'))('yaml');
        return atomic.withFileLock(join(profile,'package.json'),async()=>{
          signal.throwIfAborted();operation('started');
          if(!spec.trim()||spec.startsWith('-'))throw Object.assign(new Error('invalid-spec'),{code:'invalid-spec'});
          const parsed=parseInstallSpec(spec);
          const known=parsed.kind==='registry'?parsed.name:parsed.kind==='path'?(await readProfileManifest(join(parsed.path,'package.json'),{})).name:undefined;
          const dependencies=boot.readProfileManifest('dsh',profile).dependencies??{};
          if(known!==undefined && Object.hasOwn(dependencies,known)){
            const existing=(await this.listBundles()).find(row=>row.name===known&&row.installed);
            if(existing&&!existing.removable)throw Object.assign(new Error('not-removable'),{code:'not-removable'});
          }
          if(options.approvedBuilds){await buildPolicy(profile,yaml,atomic,{approve:options.approvedBuilds});result.approvedBuilds=options.approvedBuilds;}
          const plan=registry.registryPlan(options.registry,await this.registries());
          result.registries=[];
          let candidate;
          for(const [index,selected] of plan.entries()){
            signal.throwIfAborted();result.registries.push(selected);
            announce('installing',{registry:selected,index:index+1,total:plan.length});
            const run={jobId:randomUUID(),argv:['application.stage',spec],cwd:profile,
              ...(options.requestId===undefined?{}:{requestId:options.requestId})};
            let output='';
            const log={write:text=>{output=(output+text).slice(-8192);emit('plugin-manager/install-log',{
              ...run,stream:'stderr',text});}};
            let failure;
            try {candidate=await market().prepare(spec,signal,selected,log,options.expected);}
            catch(error){failure=error;log.write(String(error.message??error));}
            result.packageResult={exitCode:failure?1:0,output};
            emit('plugin-manager/install-log',{...run,stream:'stdout',text:'',exitCode:signal.aborted?null:result.packageResult.exitCode});
            if(candidate)break;
            if(signal.aborted)throw failure;
            const kind=classifyInstallFailure({log:output});result.packageResult.kind=kind;
            const failedAt=registry.attributeFailure(kind,output,parsed);
            if(failedAt!=='other')result.failedAt=failedAt;
            if(failedAt==='registry'&&index<plan.length-1)continue;
            result.pendingBuilds=await buildPolicy(profile,yaml,atomic,{output});
            throw failure;
          }
          await withCleanup(async()=>{
            Object.assign(result,await market().commitBundle(candidate,options.enabled!==false,()=>{
              current.phase='applying';announce('applying');
            },signal));
          },()=>candidate.dispose());
          if(result.application==='applied')delete result.failedAt;
          return result;
        },{waitMs:lifetime.waitMs,signal});
      },signal).catch(error=>{
        if((error===signal.reason||error.cause===signal.reason)&&signal.aborted&&current.phase!=='applying')result.application='cancelled';
        else result.error={code:error.code??'operation-error',diagnostic:String(error.message??error)};
        return result;
      }).finally(()=>{
        operation('settled');emit('plugin-manager/changed',{reason:'install'});
        lifetime.operations.delete(current.work);
        if(this[installations].get(current.requestId)===current)this[installations].delete(current.requestId);
      });
      lifetime.operations.add(current.work);
      if(current.requestId!==undefined)this[installations].set(current.requestId,current);
      return current.work;
    }
    async cancelInstall(id) {
      const current=this[installations].get(id);
      if(!current)return {status:'not-running'};
      if(current.phase==='applying')return {status:'too-late'};
      this[lifecycle].ctx.emit('plugin-manager/install-state',{requestId:id,phase:'cancelling'});
      current.abort.abort();const result=await current.work;
      if(result.application!=='cancelled')throw new Error('Installation cancellation cleanup was not confirmed: '+(result.error?.diagnostic??result.application));
      return {status:'cancelled'};
    }
    waitForInstall(id) {return this[installations].get(id)?.work??null;}
    removeBundle(name) {return market().transaction(()=>super.removeBundle(name),{stage:'remove',target:name});}
    async updateBundle(name,version,options) {
      const previous=(await this.listBundles()).find(row=>row.name===name);
      if(!previous?.installed || !previous.removable)return {from:previous?.version??'',to:version,step:'check',
        result:{application:'failed',changed:false,stage:'install',target:name,error:{code:'not-removable'}}};
      const result=await this.installBundle(options?.spec??name+'@'+version,{
        ...options,enabled:previous.enabled,saveExact:true,expected:{name,version},
      });
      return {from:previous.version,to:version,step:'install',result};
    }
  };
}
