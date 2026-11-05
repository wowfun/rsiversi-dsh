import {randomUUID} from 'node:crypto';
import {PassThrough} from 'node:stream';

function packageArgs(args) {
  const words=[],flags=[];
  let registry;
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==='--registry'||arg.startsWith('--registry=')||arg.startsWith('--config.registry=')) {
      registry=arg==='--registry'?args[++i]:arg.slice(arg.indexOf('=')+1);
      if(!registry || registry.startsWith('-')) throw new Error('Missing npm registry');
    } else if(arg.startsWith('-')) flags.push(arg);
    else words.push(arg);
  }
  const [action,...specs]=words;
  return {action,specs,flags,registry};
}

export function packageRunners({view, manager, selections, serialize, install, remove, restoreManifest}) {
  function run(args,_invokingDirectory,signal) {
    const stop=new AbortController();
    const combined=signal ? AbortSignal.any([signal,stop.signal]) : stop.signal;
    const stdout=new PassThrough(),stderr=new PassThrough();
    const execute=async()=>{
      try {
        combined.throwIfAborted();
        const {action,specs,flags:options,registry}=packageArgs(args);
        if(action==='view' && view && specs.length>1 && options.includes('--json') &&
          options.every(arg=>arg==='--json' || arg==='--config.fetch-retries=0')) {
          const [spec,...fields]=specs;
          stdout.write(JSON.stringify(await view(spec,fields,registry,combined))+'\n');
          return {exitCode:0,signal:null};
        }
        if(action==='install'&&!specs.length&&options.every(arg=>['-w','--no-frozen-lockfile','--config.minimum-release-age=0','--reporter=ndjson'].includes(arg))) {
          await restoreManifest(combined,registry,stderr);
          return {exitCode:0,signal:null};
        }
        if(!['add','remove'].includes(action) || specs.length!==1 || options.some(arg=>!['-w','--reporter=ndjson','--save-exact','--force','--config.minimum-release-age=0'].includes(arg)))
          throw new Error('Unsupported managed package operation: '+args.join(' '));
        if (action==='add') await install(specs[0],combined,registry,stderr);
        else await remove(specs[0],combined);
        return {exitCode:0,signal:null};
      } catch(error) {stderr.write(String(error.message ?? error));return {exitCode:1,signal:combined.aborted?'SIGTERM':null};}
      finally {stdout.end();stderr.end();}
    };
    const done=args[0]==='view'?execute():serialize(execute);
    return {stdout,stderr,done,cancel:()=>stop.abort()};
  }
  function managed(args,_directory,signal) {
    // A portable restore materializes the manifest already written by the
    // original market. It owns the subsequent activation and restart policy.
    const {action,specs,flags,registry}=packageArgs(args);
    if(action==='install') return run(args,_directory,signal);
    // The market owns replacement, rollback and restart decisions. The
    // published Plugin Manager's installBundle rejects installed packages.
    const target=specs[0];
    const existing=action==='add' && specs.length===1
      ? Object.entries(selections()).find(([name,row])=>row && target.startsWith(name+'@'))
      : undefined;
    if(existing && target!==existing[0]+'@'+existing[1].version) return run(args,_directory,signal);
    const stop=new AbortController(),stdout=new PassThrough(),stderr=new PassThrough();
    const control=signal?AbortSignal.any([signal,stop.signal]):stop.signal;
    const requestId=randomUUID();
    const done=(async()=>{
      const service=manager?.();
      const cancel=()=>{void service?.cancelInstall(requestId).catch(()=>{});};
      try {
        control.throwIfAborted();
        if(!service) throw new Error('DSH Plugin Manager is unavailable');
        if(specs.length!==1 || flags.some(value=>!['-w','--reporter=ndjson','--save-exact','--force','--config.minimum-release-age=0'].includes(value)))
          throw new Error('Unsupported DSH plugin operation: '+args.join(' '));
        control.addEventListener('abort',cancel,{once:true});
        let result;
        if(action==='add') {
          result=existing?await service.setBundleEnabled(existing[0],true):
            await service.installBundle(target,{requestId,enabled:true,saveExact:true,...(registry?{registry}:{})});
        }
        else if(action==='remove') result=await service.removeBundle(target);
        else throw new Error('Unsupported DSH plugin command: '+action);
        if(result.packageResult?.output) stdout.write(result.packageResult.output);
        if(result.error || result.packageResult && result.packageResult.exitCode!==0 || result.application==='failed' || result.application==='cancelled')
          throw new Error(result.error?.message ?? result.error?.code ?? result.packageResult?.output ?? 'DSH package operation failed');
        return {exitCode:0,signal:null};
      } catch(error) {stderr.write(String(error.message??error));return {exitCode:1,signal:control.aborted?'SIGTERM':null};}
      finally {control.removeEventListener('abort',cancel);stdout.end();stderr.end();}
    })();
    return {stdout,stderr,done,cancel:()=>stop.abort()};
  }
  return {
    packageRunner: {runPlugin: run},
    desktopPnpm: {runPlugin: managed, runExternalMarketPluginInstall: managed},
  };
}
