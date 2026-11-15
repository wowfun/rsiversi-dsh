import {join} from 'node:path';
import {boundedText} from './profile-files.mjs';

// Port of DSH plugin-manager/build-approval.ts for the supported registry/local
// importer. Approvals are operator policy, outside package compensation.
export async function buildPolicy(profile,yaml,atomic,{approve,output}) {
  const path=join(profile,'pnpm-workspace.yaml');
  const document=yaml.parseDocument(await boundedText(path)??'{}\n');
  if(document.errors[0])throw document.errors[0];
  if(!yaml.isMap(document.contents))throw new Error('pnpm-workspace.yaml must be a YAML mapping');
  const builds=document.get('allowBuilds');
  if(builds!==undefined&&!yaml.isMap(builds))throw new Error('allowBuilds must be a YAML mapping');
  yaml.visit(builds??null,(_key,node)=>{
    if(yaml.isAlias(node)||(yaml.isNode(node)&&node.anchor))throw new Error('allowBuilds must not contain YAML anchors or aliases');
  });
  const pending=()=>yaml.isMap(document.get('allowBuilds'))?document.get('allowBuilds').items.flatMap(({key,value})=>
    yaml.isScalar(key)&&typeof key.value==='string'&&!/[*?]/.test(key.value)&&yaml.isScalar(value)&&value.value==='set this to true or false'?[key.value]:[]):[];
  let changed=false;
  const current=pending(),added=[];
  if(approve){
    if(approve.some(name=>!current.includes(name)))throw Object.assign(new Error('stale-approval'),{code:'stale-approval'});
    for(const name of approve){document.setIn(['allowBuilds',name],true);changed=true;}
  }
  for(const name of (/\bIgnored build scripts: (.+)/.exec(output??'')?.[1]?.split(',')??[]).map(name=>name.trim())){
    if(name&&!/[*?]/.test(name)&&!document.hasIn(['allowBuilds',name])){
      document.setIn(['allowBuilds',name],'set this to true or false');changed=true;
      added.push(name);
    }
  }
  if(changed){
    const text=String(document);
    if(Buffer.byteLength(text)>1024*1024)throw new Error('Build policy exceeds profile capacity');
    await atomic.writeFileAtomic(path,text,{mode:0o600});
  }
  return [...current.filter(name=>!approve?.includes(name)),...added];
}
