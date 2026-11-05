import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

// A revision identifies a reusable reference build only in a clean checkout.
// Source archives and local edits are valid inputs and build without this cache.
export function sourceIdentity(root) {
  const git=args=>spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']});
  if(!existsSync(join(root,'.git'))) return {revision:null,cacheable:false};
  const head=git(['rev-parse','--verify','HEAD']);
  if(head.status!==0) return {revision:null,cacheable:false};
  const status=git(['status','--porcelain']);
  return {revision:head.stdout.trim(),cacheable:status.status===0 && !status.stdout.trim()};
}
