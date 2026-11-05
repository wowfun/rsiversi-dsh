// Opt-in source development. Only the launcher is admitted to this fixture
// store. Final acceptance must use installed runtime and plugin payloads.
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {writePayloadFiles} from '../../packages/rsi-dsh-cordis/src/archive/payload.mjs';
import {digest,json} from '../../packages/rsi-dsh-cordis/src/release/artifacts.mjs';
import {runtimeEnvironment} from '../../packages/rsi-dsh-cordis/src/runtime/node.mjs';

const [bin,home,document,stage,base]=process.argv.slice(2).map(path=>resolve(path));
await mkdir(home,{recursive:true});
const source=join(home,'dev-package');await mkdir(source,{recursive:true});
const receipt=JSON.parse(await readFile(join(base,'receipt.json')));
const layout=join(base,receipt.selection.name,'layout.json');
const entry=fileURLToPath(new URL('../../packages/rsi-dsh-plugin-bridge/src/application/process.mjs',import.meta.url));
const carrier=new URL('../../packages/rsi-dsh-plugin-bridge/src/application/entry.mjs',import.meta.url).href;
const argv=[layout,...receipt.artifacts.flatMap(row=>[row.name,stage])];
const body=Buffer.from(`import {appendFileSync} from 'node:fs';
const trace=${JSON.stringify(join(home,'private-process-trace.log'))};
function mark(message){appendFileSync(trace,Date.now()+' '+message+'\\n');}
mark('entry');
process.on('uncaughtExceptionMonitor',err=>mark('uncaught '+err.stack));
process.on('exit',code=>mark('exit '+code));
const write=process.stderr.write.bind(process.stderr);
process.stderr.write=function(chunk,...args){mark(String(chunk).slice(-1000));return write(chunk,...args);};
process.argv.push(...${JSON.stringify(argv)});
const {serveApplication}=await import(${JSON.stringify(carrier)});
serveApplication(process.stdin,process.stdout,process.argv[2],process.argv.slice(2),new URL(${JSON.stringify(pathToFileURL(entry).href)}));
mark('peer listening');`);
const file=join(source,'entry.mjs');await writeFile(file,body);
const tree=await writePayloadFiles([{path:'entry.mjs',source:file,bytes:body.length}],join(source,'runtime.rsi'));
const recipe=json({format:1,cwd:{payload:'runtime',path:''},arguments:[{kind:'path',location:{payload:'runtime',path:'entry.mjs'}},{kind:'generation'}]});
await writeFile(join(source,'process.json'),recipe);
const packageName='local-market-development';
const manifest=json({format:2,name:packageName,version:'1',target:'portable',dependencies:[],
  requires:[{name:'rsi.extension.process',version:1}],files:[
    {path:'runtime.rsi',bytes:tree.bytes,digest:tree.digest,executable:false},
    {path:'process.json',bytes:recipe.length,digest:digest(recipe),executable:false}],
  exports:{runtime:{kind:'payload_tree',path:'runtime.rsi'},application:{kind:'process_extension',path:'process.json'}}});
await writeFile(join(source,'package.json'),manifest);
const config=join(home,'config/rsi'),state=join(home,'state/rsi');
const options=['--config-home',config,'--state-home',state,'--cache-home',join(home,'cache/rsi')];
const cli=(...args)=>execFileSync(bin,[...options,...args],{encoding:'utf8',windowsHide:true,cwd:home});
try {await readFile(join(config,'rsi.toml'));} catch(error) {if(error.code!=='ENOENT')throw error;cli('config','init');}
cli('plugin','install','--local',source);
const target=join(config,'host-profiles/dev');await mkdir(target,{recursive:true});
const environment={...runtimeEnvironment(),PATH:process.env.PATH,HOME:home,USERPROFILE:home,DSH_HOME:home};
await writeFile(join(target,'host.profile.toml'),`format = 1
[[steps]]
kind = 'plugin'
id = 'dev-market'
plugin = 'rsi.web.application'
[steps.config]
profile = 'dev'
routes = ['/document','/plugins']
source = {kind='directory',path=${JSON.stringify(document)}}
importer = {package='${packageName}',export='import',program=${JSON.stringify(process.execPath)}}
[steps.config.process]
package = '${packageName}'
digest = '${digest(manifest)}'
export = 'application'
program = ${JSON.stringify(process.execPath)}
environment = {${Object.entries(environment).map(([k,v])=>JSON.stringify(k)+'='+JSON.stringify(v)).join(',')}}
`);
await writeFile(join(config,'rsi.toml'),"format = 1\n[service]\nkind = 'catalog'\nid = 'dev'\n");
await writeFile(join(home,'launch-private.log'),cli('web','--no-open','--port','0','--assets',document));
