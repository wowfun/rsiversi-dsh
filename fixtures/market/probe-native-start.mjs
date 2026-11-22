import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writePayloadFiles} from '../../packages/rsi-dsh-cordis/src/archive/payload.mjs';
import {digest,json} from '../../packages/rsi-dsh-cordis/src/release/artifacts.mjs';
import {runtimeEnvironment} from '../../packages/rsi-dsh-cordis/src/runtime/node.mjs';
import {homeOptions} from './home.mjs';

const [bin,home,document]=process.argv.slice(2).map(path=>resolve(path));
await mkdir(home,{recursive:false});
const source=join(home,'source');await mkdir(source);
const workspace=join(home,'workspace');await mkdir(workspace);
const files=[];
for(const [path,located] of [['entry.mjs','./small-process.mjs'],
  ...['transport','frames'].map(name=>[name+'.mjs','../../packages/rsi-dsh-cordis/src/runtime/'+name+'.mjs']),
  ...['application/sessions','application/activities','application/inbox','application/request-publication','application/native-publication',
    'agent/file-input','session/working-directory','request-body'].map(name=>['bridge/'+name+'.mjs','../../packages/rsi-dsh-plugin-bridge/src/'+name+'.mjs'])]) {
  const file=fileURLToPath(new URL(located,import.meta.url));files.push({path,source:file,bytes:(await stat(file)).size});
}
const tree=await writePayloadFiles(files,join(source,'runtime.rsi'));
const processDescriptor=json({format:1,cwd:{payload:'runtime',path:''},arguments:[
  {kind:'path',location:{payload:'runtime',path:'entry.mjs'}},{kind:'generation'}]});
await writeFile(join(source,'process.json'),processDescriptor);
const manifest=json({format:2,name:'sample-application',version:'1',target:'portable',
  dependencies:[],requires:[{name:'rsi.extension.process',version:2}],files:[
    {path:'runtime.rsi',bytes:tree.bytes,digest:tree.digest,executable:false},
    {path:'process.json',bytes:processDescriptor.length,digest:digest(processDescriptor),executable:false}],
  exports:{runtime:{kind:'payload_tree',path:'runtime.rsi',index_digest:tree.indexDigest},application:{kind:'process_extension',path:'process.json'}}});
await writeFile(join(source,'package.json'),manifest);
const config=join(home,'config/rsi');
const env={...runtimeEnvironment(),PATH:process.env.PATH,RSI_OPENAI_COMPATIBLE_API_KEY:'isolated-fixture-secret'};
function cli(...args) {
  return execFileSync(bin,[...homeOptions(home),...args],
    {cwd:home,env,encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:2*1024*1024});
}
cli('config','init');
await writeFile(join(config,'settings.json'),JSON.stringify({'rsi.agent':{default_model:{deployment:'fixture',model:'fixture-model'}}}));
const provider=createServer(async(req,res)=>{
  for await(const _chunk of req) {}
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[{delta:{role:'assistant',content:'Accepted fixture input.'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
});
provider.listen(0,'127.0.0.1');await once(provider,'listening');
try {
const profile=join(config,'host-profiles/probe');await mkdir(profile,{recursive:true});
await writeFile(join(config,'rsi.toml'),"format = 1\n[service]\nkind = 'catalog'\nid = 'probe'\n");
await writeFile(join(profile,'host.profile.toml'),`format = 1
[[steps]]
kind = 'plugin'
id = 'provider'
plugin = 'rsi.ai.provider.openai-compatible'
[steps.config]
deployment = 'fixture'
endpoint = 'http://127.0.0.1:${provider.address().port}'
path = '/v1/chat/completions'
allow_image_input = false
credential = {owner='rsi.ai.provider.openai-compatible',slot='default'}
[steps.config.language_models.fixture-model]
context_window_tokens = 2000000
default_output_reserve_tokens = 4096
max_output_reserve_tokens = 16384
[[steps]]
kind = 'plugin'
id = 'application'
plugin = 'rsi.web.application'
[steps.config]
profile = 'probe'
routes = ['/document']
source = {kind='directory',path='${document.replaceAll('\\','/')}'}
process = {package='sample-application',digest='${digest(manifest)}',export='application',program='${process.execPath.replaceAll('\\','/')}',environment={${Object.entries({...runtimeEnvironment(),RSI_SUBMISSION_PROBE_WORKSPACE:workspace}).map(([name,value])=>name+'='+JSON.stringify(value)).join(',')}}}
[[steps]]
kind = 'patch'
target = 'rsi-agent-workspace-context'
config_json = ${JSON.stringify(JSON.stringify({user_instruction_file:join(config,'AGENTS.md'),user_agent_roots:[join(config,'agents')],user_skill_roots:[join(config,'skills')]}))}
`);
cli('plugin','install','--local',source);
const installed=JSON.parse(await readFile(join(home,'data/rsi/packages/resolution.json'),'utf8'));
assert.equal(installed.packages['sample-application'].digest,digest(manifest));
const start=new URL(cli('web','--assets',document,'--no-open','--port','0').match(/https?:\/\/[^\s]+/)[0]);
  const response=await fetch(start.origin+'/api/v2/browser-bootstrap',{method:'POST',headers:{
    origin:start.origin,'x-rsi-csrf':'1','x-rsi-launch-ticket':start.hash.slice(12)}});
  const cookie=response.headers.get('set-cookie')?.split(';')[0];
  if(!cookie) throw new Error('Bootstrap status '+response.status);
  const result=await fetch(start.origin+'/document/',{headers:{cookie,'sec-fetch-site':'same-origin'},signal:AbortSignal.timeout(30000)});
  assert.equal(result.status,200,await result.text());
  const submission=await fetch(start.origin+'/document/submit',{method:'POST',headers:{cookie,origin:start.origin,'x-rsi-csrf':'1','sec-fetch-site':'same-origin'},signal:AbortSignal.timeout(120000)});
  const text=await submission.text();assert.equal(submission.status,200,text);
  const evidence={bootstrap:response.status,document:result.status,submission:JSON.parse(text),
    executable:{path:bin,sha256:digest(await readFile(bin))},
    sources:await Promise.all(files.map(async file=>({path:file.path,sha256:digest(await readFile(file.source))}))),
    package:digest(manifest)};
  await writeFile(join(home,'result.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
} finally {
  try {cli('host','stop');}
  finally {await new Promise(resolve=>provider.close(resolve));}
}
