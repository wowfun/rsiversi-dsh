import {AsyncLocalStorage} from 'node:async_hooks';
import {relative,resolve} from 'node:path';

const runtime='@deepseek-ai/dsh-subagent';

export function loaderEntry(ctx) {
  for(let fiber=ctx?.fiber;fiber;){
    if(fiber.entry)return fiber.entry;
    const parent=fiber.parent.fiber;
    if(parent===fiber)return;
    fiber=parent;
  }
}

/** Keep the initiating Loader entry across the original manager's asynchronous factory call. */
export function workbenchSubagents(Runtime,caller,scope) {
  const starting=new AsyncLocalStorage();
  return {
    Runtime:class extends Runtime {
      listDescendants(id,signal) {
        return scope.withCaller(async()=>{
          const [released,native]=await Promise.all([super.listDescendants(id,signal),scope.subagents.listDescendants(id,signal)]);
          return mergeDescendants(id,released,native);
        },signal);
      }
      async startActivation(spec) {
        const ctx=this[caller],entry=loaderEntry(ctx);
        if(!entry)throw Error('Subagent activation requires a Cordis plugin entry');
        const start={ctx,plugin:entry.options.name,parent:spec.parent,name:spec.name,childId:spec.childId,cwd:spec.cwd};
        try {return await scope.withPluginParent(spec.parent.id,()=>starting.run(start,()=>super.startActivation(spec)),spec.signal);}
        finally {start.closed=true;}
      }
    },
    creation(owner,options) {
      const meta=options.meta;
      if(meta?.origin!=='subagent'||!meta.parentSession)return;
      const start=starting.getStore();
      const entry=loaderEntry(owner);
      if(!start||start.closed||entry?.options.name!==runtime){
        if(meta.isSeeded||options.seed?.length||options.parentSource)return;
        if(!entry)throw Error('Direct subagent creation requires a Cordis plugin entry');
        return {parent:meta.parentSession,plugin:entry.options.name,task_name:options.sessionId,
          ...(meta.cwd===undefined?{}:{cwd:meta.cwd})};
      }
      if(start.created!==undefined||meta.parentSession!==start.parent.id||
          (start.childId!==undefined&&start.childId!==options.sessionId))return;
      start.ctx.fiber.assertActive();
      start.created=options.sessionId;
      const args={parent:start.parent.id,plugin:start.plugin,task_name:start.name??options.sessionId};
      if(start.cwd!==undefined){
        const current=owner.workingDirectory.get(start.parent.session);
        const cwd=resolve(current,start.cwd);
        if(relative(current,cwd)!=='')args.cwd=cwd;
      }
      return args;
    },
    configuring(id) {
      const start=starting.getStore();
      return start?.created===id&&!start.closed;
    },
  };
}

// The DSH catalog includes external runs and their names. The Host also owns native and program children.
function mergeDescendants(root,released,native) {
  if(!native.length)return released;
  const known=new Set(released.map(row=>row.id));
  const extra=native.filter(row=>!known.has(row.id));
  if(!extra.length)return released;
  const children=new Map();
  for(const row of [...released,...extra]){
    let group=children.get(row.parentId);
    if(!group)children.set(row.parentId,group=[]);
    group.push(row);
  }
  const result=[],stack=[...(children.get(root)??[])].reverse();
  while(stack.length){
    const row=stack.pop(),direct=children.get(row.id);
    result.push(direct&&row.kind==='child'&&!row.hasChildren?{...row,hasChildren:true}:row);
    if(direct)for(let i=direct.length-1;i>=0;i--)stack.push(direct[i]);
  }
  return result;
}
