import {copyFile,mkdir,mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';

// Bind the small browser handoff to the same worker/build family as the
// selected RSI release. The authenticated destination owns the original DSH DOM.
export async function buildMarketDocument(base,out,rsi) {
  const receipt=JSON.parse(await readFile(join(base,'rsi-build.json'),'utf8'));
  const files=Object.keys(receipt.bootstrap ?? {});
  if (!files.includes('index.html') || !files.includes('app.js')) throw new Error('Expected a paired RSI document');
  const temporary=await mkdtemp(join(dirname(out),'.rsi-document-'));
  const staged=join(temporary,'document');
  try {
    await mkdir(staged);
    await writeDocument(staged,temporary,base,rsi,receipt,files);
    await rename(staged,out);
  } finally {
    await rm(temporary,{recursive:true,force:true});
  }
}

async function writeDocument(out,temporary,base,rsi,receipt,files) {
  for(const file of files) {
    if (file!== 'app.js' && file!=='index.html') await copyFile(join(base,file),join(out,file));
  }
  await writeFile(join(out,'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RSIversi</title><script type="module" src="/app.js"></script><body><p role="status">Opening RSIversi…</p></body></html>');
  await writeFile(join(out,'app.js'), `const fragment=location.hash;
history.replaceState(null,'',location.pathname+location.search);
const ticket=/^#rsi-launch=([0-9a-f]{64})$/.exec(fragment)?.[1];
const status=document.querySelector('[role=status]');
try {
  const headers={'x-rsi-csrf':'1'};
  if(ticket) headers['x-rsi-launch-ticket']=ticket;
  const response=await fetch('/api/v2/browser-bootstrap',{method:'POST',credentials:'same-origin',headers});
  if(!response.ok) throw new Error('Browser authentication failed ('+response.status+')');
  status.textContent='Preparing the workbench…';
  const original=new URLSearchParams(location.search).get('brand')==='original';
  location.replace('/document/'+(original?'?brand=original':''));
} catch(error) {status.setAttribute('role','alert');status.textContent=String(error.message ?? error);}`);
  const descriptor=join(temporary,'assets.json');
  await writeFile(descriptor,JSON.stringify({files:await readdir(out),trusted_inline_styles:true}));
  const check=spawnSync('cargo',['run','--locked','-q','-p','rsi-web-assets','--example','check_bundle','--',out,'--write-pairing',
    receipt.family_sha256,JSON.stringify(receipt.desktop_bridge),'--document',descriptor],{cwd:rsi,stdio:'inherit',windowsHide:true});
  if(check.status!==0) throw new Error('Market document pairing failed');
}
if(import.meta.main) await buildMarketDocument(...process.argv.slice(2).map(path=>resolve(path)));
