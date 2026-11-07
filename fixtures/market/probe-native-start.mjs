import {execFileSync} from 'node:child_process';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writePayloadFiles} from '../../packages/rsi-dsh-cordis/src/archive/payload.mjs';
import {digest,json} from '../../packages/rsi-dsh-cordis/src/release/artifacts.mjs';
import {runtimeEnvironment} from '../../packages/rsi-dsh-cordis/src/runtime/node.mjs';

const [bin,home,document]=process.argv.slice(2).map(path=>resolve(path));
await mkdir(home,{recursive:false});
const source=join(home,'source');await mkdir(source);
const files=[];
for(const [path,located] of [['entry.mjs','./small-process.mjs'],
  ...['transport','frames'].map(name=>[name+'.mjs','../../packages/rsi-dsh-cordis/src/runtime/'+name+'.mjs'])]) {
  const file=fileURLToPath(new URL(located,import.meta.url));files.push({path,source:file,bytes:(await stat(file)).size});
}
const tree=await writePayloadFiles(files,join(source,'runtime.rsi'));
const processDescriptor=json({format:1,cwd:{payload:'runtime',path:''},arguments:[
  {kind:'path',location:{payload:'runtime',path:'entry.mjs'}},{kind:'generation'}]});
await writeFile(join(source,'process.json'),processDescriptor);
const manifest=json({format:2,name:'sample-application',version:'1',target:'portable',
  dependencies:[],requires:[{name:'rsi.extension.process',version:1}],files:[
    {path:'runtime.rsi',bytes:tree.bytes,digest:tree.digest,executable:false},
    {path:'process.json',bytes:processDescriptor.length,digest:digest(processDescriptor),executable:false}],
  exports:{runtime:{kind:'payload_tree',path:'runtime.rsi',index_digest:tree.indexDigest},application:{kind:'process_extension',path:'process.json'}}});
await writeFile(join(source,'package.json'),manifest);
const config=join(home,'config/rsi');
function cli(...args) {
  return execFileSync(bin,['--config-home',config,'--state-home',join(home,'state/rsi'),'--cache-home',join(home,'cache/rsi'),...args],
    {cwd:home,encoding:'utf8',windowsHide:true});
}
cli('config','init');
const profile=join(config,'host-profiles/probe');await mkdir(profile,{recursive:true});
await writeFile(join(config,'rsi.toml'),"format = 1\n[service]\nkind = 'catalog'\nid = 'probe'\n");
await writeFile(join(profile,'host.profile.toml'),`format = 1
[[steps]]
kind = 'plugin'
id = 'application'
plugin = 'rsi.web.application'
[steps.config]
profile = 'probe'
routes = ['/document']
source = {kind='directory',path='${document.replaceAll('\\','/')}'}
process = {package='sample-application',digest='${digest(manifest)}',export='application',program='${process.execPath.replaceAll('\\','/')}',environment={${Object.entries(runtimeEnvironment()).map(([name,value])=>name+'='+JSON.stringify(value)).join(',')}}}
`);
cli('plugin','install','--local',source);
const start=new URL(cli('web','--assets',document,'--no-open','--port','0').match(/https?:\/\/[^\s]+/)[0]);
try {
  const response=await fetch(start.origin+'/api/v2/browser-bootstrap',{method:'POST',headers:{
    origin:start.origin,'x-rsi-csrf':'1','x-rsi-launch-ticket':start.hash.slice(12)}});
  const cookie=response.headers.get('set-cookie')?.split(';')[0];
  if(!cookie) throw new Error('Bootstrap status '+response.status);
  const result=await fetch(start.origin+'/document/',{headers:{cookie,'sec-fetch-site':'same-origin'},signal:AbortSignal.timeout(30000)});
  console.log(JSON.stringify({bootstrap:response.status,document:result.status,body:await result.text()}));
  if(!result.ok) process.exitCode=1;
} finally {cli('host','stop');}
