import {randomUUID} from 'node:crypto';
import {commandReceipt} from '../session/command-receipts.mjs';
import {validatePermissionEvent} from '../session/session.mjs';

const fields={
  'permission/preset':['preset','preset'],
  'sandbox/mode':['sandbox','mode'],
  'approval/policy':['approval','policy'],
};

/** Project one atomic Host selection into the changed upstream knobs in their original order. */
export function observePermission(state,event,hasLocalRequest) {
  const previous=state.permission;
  const next=event.permission;
  for(const [type,[field,key]] of Object.entries(fields)){
    if(next[field]===previous?.[field])continue;
    const appended=state.session.adoptObserved({type,seq:state.session.seq,time:event.time,data:{[key]:next[field]}});
    const id=next.request_id&&next.request_id+'/'+field;
    if(id&&hasLocalRequest?.(id))state.origins.set(appended.seq,{permissionOperation:id});
  }
  state.permission={...next,controlSeq:event.seq};
}

/** The header knobs may already have been presented when a native Session was first opened. */
export function restoredPermissionSeed(document) {
  if(!document)return;
  const seed={};
  for(const event of document.events){
    if(!Object.hasOwn(fields,event.type))continue;
    const field=fields[event.type];
    if(!event.data||document.operations.some(op=>op.seq===event.seq)||Object.hasOwn(seed,field[0]))break;
    seed[field[0]]=event.data[field[1]];
    if(seed.sandbox&&seed.approval)return seed;
  }
}

/** Synchronous Session.append completes only after native authority accepts the selected pair. */
export function appendPermission(ctx,presets,record,scope,type,data,opts) {
  validatePermissionEvent(type,data,opts);
  if(Object.keys(opts).some(key=>key!=='ignorable')||(opts.ignorable!==undefined&&opts.ignorable!==true))
    throw Error('Invalid permission event metadata');
  const {journal,meta,source}=record.owner;
  const observed=source.current.permission;
  const previous=(record.permission?.controlSeq??0)>(observed?.controlSeq??0)?record.permission:observed;
  const [field,key]=fields[type];
  const prior=previous??{sandbox:meta.sandbox??ctx.get('shell')?.sandboxMode,approval:meta.plugin_child_depth===undefined?'ask':'never'};
  let selected={preset:prior.preset??'custom',sandbox:prior.sandbox,approval:prior.approval};
  if(type==='permission/preset'){
    if(!presets)throw Error('Session permission presets are unavailable');
    const {sandbox,approval}=presets.resolve(data.preset);
    selected={preset:data.preset,sandbox,approval};
  }else selected[field]=data[key];
  let id;
  if(!previous||selected.preset!==prior.preset||selected.sandbox!==prior.sandbox||selected.approval!==prior.approval){
    const cut=meta.selection_cursor;
    const latest=Math.max(cut.control_seq??0,record.controlSeq??0,previous?.controlSeq??0);
    const expected=cut.kind==='draft'&&!latest?{kind:'draft',revision:cut.revision}:{kind:'durable',control_seq:latest};
    id=randomUUID();
    const {control,receipt}=scope.commitControl(record.id,{type:'execute',command:'rsi.permission.select',
      request_id:id,expected_revision:expected,arguments:selected});
    commandReceipt({id,invocation:{command:control.command,request_id:id,expected_revision:control.expected_revision,arguments:selected}},receipt);
    record.controlSeq=receipt.outcome.control_seq;
    record.permission={...selected,controlSeq:record.controlSeq,request_id:id,
      remaining:type==='permission/preset'?new Set(['sandbox','approval'].filter(knob=>previous?.[knob]!==selected[knob])):undefined};
  }else if(previous===record.permission&&previous?.remaining?.delete(field)){
    id=previous.request_id;
  }
  const operation=id&&id+'/'+field;
  if(operation)return journal.accept(operation,type,data,opts,Date.now());
  return journal.appendPermission(type,data,opts);
}

/** An existing native session brings its creation-time sandbox to its first workbench attachment. */
export function seedNativePermission(ctx,record){
  const owner=record.owner;
  if(!owner?.meta?.sandbox||owner.journal.session.lastEvent('sandbox/mode'))return;
  const service=ctx.get('permissionPresets',false);
  const sandbox=owner.meta.sandbox;
  const approval=owner.meta.plugin_child_depth===undefined?'ask':'never';
  const preset=service?.names.find(name=>{
    if(name==='auto')return false;
    const spec=service.resolve(name);
    return spec.sandbox===sandbox&&spec.approval===approval;
  });
  if(preset)owner.journal.appendPermission('permission/preset',{preset});
  owner.journal.appendPermission('sandbox/mode',{mode:sandbox});
  owner.journal.appendPermission('approval/policy',{policy:approval});
  owner.source.current.permission={preset,sandbox,approval};
  owner.journal.scheduleFlush();
}
