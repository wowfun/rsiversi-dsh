import {randomUUID} from 'node:crypto';

/** Queue management before requesting capture exclusion. Nested calls retain the owner. */
export function managedBoundary(Manager,market) {
  return class extends Manager {
    setPluginEnabled(...args){return market().mutate(()=>super.setPluginEnabled(...args));}
    setBundleEnabled(...args){return market().mutate(()=>super.setBundleEnabled(...args));}
    removeBundle(...args){return market().mutate(()=>super.removeBundle(...args));}
    setVersionExemption(...args){return market().mutate(()=>super.setVersionExemption(...args));}
  };
}

const summary=result=>({application:result.application,changed:result.changed,stage:result.stage,
  target:result.target,bundle:result.bundle,enabled:result.enabled,restartReason:result.restartReason,
  ...(result.restored?{restored:true}:{}),
  ...(result.error?{error:{code:result.error.code,diagnostic:String(result.error.diagnostic??'').slice(0,4096)}}:{}),
  ...(result.warnings?.length?{warnings:result.warnings.slice(0,32).map(value=>String(value).slice(0,512))}:{}),
  ...(result.pendingBuilds?{pendingBuilds:result.pendingBuilds}:{}),
});

/** Port of DSH plugin-manager/tools: its manager remains the mutation owner;
 * RSI owns per-call approval and releasing the producing request before apply. */
export function managementTools({defineTool},boundary) {
  const operations=new Map();
  const output={schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]};
  const present=kind=>args=>{
    const label={list_plugins:'List plugins',list_bundles:'List bundles',operation_status:'Plugin operation status',
      install_bundle:'Install bundle',remove_bundle:'Remove bundle',cancel_install:'Cancel installation',
      set_plugin:args.enabled===undefined?'Set plugin':args.enabled?'Enable plugin':'Disable plugin',
      set_bundle:args.enabled===undefined?'Set bundle':args.enabled?'Enable bundle':'Disable bundle'}[args.action];
    return {card:'generic',title:label+(args.target===undefined?'':' '+args.target),kind,rawInput:args};
  };
  return {inject:['tools','pluginManager'],apply(ctx){
    ctx.tools.register(defineTool({
      name:'plugin_inspect',
      description:'Read plugins, bundles and recent management operation results in the current profile. Use exact identifiers from these lists with plugin_manager. Pending is not applied; unknown operations must not be automatically replayed.',
      parameters:{
        action:{type:'string',required:true,enum:['list_plugins','list_bundles','operation_status']},
        target:{type:'string',description:'Operation ID for operation_status; omit to inspect recent operations after a lost reply.'},
        offset:{type:'number',description:'For list actions: zero-based integer offset, at least 0; defaults to 0.'},
        limit:{type:'number',description:'For list actions: integer page size from 1 to 100; defaults to 25.'},
      },
      output,
      async execute(args,exec){
        exec.signal.throwIfAborted();
        if(args.action==='operation_status')return JSON.stringify(args.target===undefined
          ?{operations:[...operations.values()].map(row=>row.receipt)}
          :operations.get(args.target)?.receipt??{
            application:'unknown',operation:args.target,nextStep:'Inspect the selected and active plugins; do not automatically replay the operation.',
          });
        const manager=ctx.pluginManager;
        if(args.action==='list_plugins'||args.action==='list_bundles'){
          const offset=args.offset??0,limit=args.limit??25;
          if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid list page');
          const all=await (args.action==='list_plugins'?manager.listPlugins():manager.listBundles());
          const entries=all.slice(offset,offset+limit).map(({meta,...entry})=>({ ...entry,
            ...('rows' in entry?{rows:entry.rows.map(({meta,...row})=>row)}:{}),
          }));
          return JSON.stringify({entries,total:all.length,nextOffset:offset+entries.length<all.length?offset+entries.length:null});
        }
        throw Error('Unknown inspection action');
      },
      presentCall:present('read'),
    }));
    const tool=defineTool({
      name:'plugin_manager',
      description:'Change plugins in the current profile. Changes affect all its sessions and installed code runs with Host authority. Use plugin_inspect first for exact identifiers. Mutations return pending with an operation ID; after this response batch settles, plugin_inspect operation_status reports the result. Native full-access permission or per-call approval is required. Installation can execute explicitly approved build scripts. cancel_install accepts an install operation ID and reports cancellation status; cancelling the Turn alone does not cancel an accepted mutation.',
      parameters:{
        action:{type:'string',required:true,enum:['set_plugin','set_bundle','install_bundle','remove_bundle','cancel_install']},
        target:{type:'string',required:true,description:'Exact entry ID, bundle name, install specification, or install operation ID to cancel.'},
        enabled:{type:'boolean',description:'Required for set operations; installation defaults to enabled.'},
        approvedBuilds:{type:'array',items:{type:'string'},description:'Package names explicitly approved by the user to run install scripts.'},
        registry:{type:'string',description:'Registry selected by the user.'},
      },
      output,
      async execute(args,exec){
        exec.signal.throwIfAborted();
        const manager=ctx.pluginManager;
        if(!args.target)throw Error('target is required');
        if(args.action==='cancel_install')return JSON.stringify({operation:args.target,...await manager.cancelInstall(args.target)});
        if(['set_plugin','set_bundle'].includes(args.action)&&typeof args.enabled!=='boolean')throw Error('enabled is required');
        const operation=randomUUID(),origin={session:exec.agent?.id,call:exec.callId};
        let invoke;
        switch(args.action){
          case 'set_plugin':invoke=()=>manager.setPluginEnabled(args.target,args.enabled);break;
          case 'set_bundle':invoke=()=>manager.setBundleEnabled(args.target,args.enabled);break;
          case 'install_bundle':invoke=()=>manager.installBundle(args.target,{requestId:operation,enabled:args.enabled??true,
            ...(args.approvedBuilds?{approvedBuilds:args.approvedBuilds}:{}),...(args.registry?{registry:args.registry}:{})});break;
          case 'remove_bundle':invoke=()=>manager.removeBundle(args.target);break;
          default:throw Error('Unknown management action');
        }
        if(operations.size===64){
          const oldest=[...operations].find(([,row])=>row.settled);
          if(!oldest)throw Error('Management operations are at capacity');
          operations.delete(oldest[0]);
        }
        const receipt={application:'pending',operation,origin,
          nextStep:'After this response batch settles, call plugin_inspect operation_status with this operation ID.'};
        const row={receipt,settled:false};operations.set(operation,row);
        // The manager's boundary owns this work after its accepted Tool returns.
        // It does not inherit the soon-to-be-released view's cancellation token.
        boundary.detach(()=>Promise.resolve().then(invoke)).then(result=>{row.receipt={operation,origin,...summary(result)};},error=>{
          row.receipt={application:'unknown',operation,origin,diagnostic:String(error.message??error).slice(0,4096),
            nextStep:'Inspect the selected and active plugins before issuing another mutation.'};
        }).finally(()=>{row.settled=true;});
        return JSON.stringify(receipt);
      },
      presentCall:present('other'),
    });
    tool.requiresFullAccess=true;
    ctx.tools.register(tool);
  }};
}
