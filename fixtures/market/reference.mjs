// Opt-in upstream control. Its temporary DSH profile is not an RSI session store.
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {runtimeEnvironment} from '../../packages/rsi-dsh-cordis/src/runtime/node.mjs';
import {buildBrand} from '../../scripts/build-brand.mjs';

const [rootInput, reportInput, brandingRoot] = process.argv.slice(2);
if (!rootInput || !reportInput) throw new Error('Expected release stage and report directory');
const root=resolve(rootInput), report=resolve(reportInput), home=await mkdtemp(join(tmpdir(),'rsi-dsh-market-control-'));
const profile=join(home,'profiles','web');
await mkdir(profile,{recursive:true}); await mkdir(report,{recursive:true});
await writeFile(join(profile,'package.json'),JSON.stringify({name:'rsi-market-control', private:true,
  dependencies:{dshmarket:'1.73.8','dsh-better-sidebar':'0.28.2'},
  dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dshmarket','dsh-better-sidebar']}}}));
await writeFile(join(profile,'cordis.yml'),'[]\n');
const rows=[{insert:[
  {id:'community-index',name:'@deepseek-ai/dsh-plugin-market'},
  {id:'community-discover',name:'@deepseek-ai/dsh-client-ui-plugin-market'},
]}];
if (brandingRoot) {
  const brand=join(home,'brand');await buildBrand(resolve(brandingRoot),brand);
  rows.push({id:'ui-brand-official',disabled:true},{insert:[
    {id:'rsi-brand',name:join(brand,'src/browser/brand-host.mjs').replaceAll('\\','/')},
  ]});
}
await writeFile(join(profile,'cordis.patch.yml'),JSON.stringify(rows));
await symlink(join(root,'node_modules'),join(profile,'node_modules'),process.platform==='win32'?'junction':'dir');
const child=spawn(process.execPath,[join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'web','--no-open','--port','0'],{
  cwd:home, windowsHide:true, env:{...runtimeEnvironment(),HOME:home,USERPROFILE:home,DSH_HOME:home,PATH:process.env.PATH},
  stdio:['ignore','pipe','pipe']});
// Keep the one-use launch address out of shared test output.
const log=[];
let queue=Promise.resolve();
function record(bytes) {
  if(log.length<4096) log.push(bytes.toString());
  queue=queue.then(()=>writeFile(join(report,'reference-private.log'),log.join('')));
}
child.stdout.on('data',record);child.stderr.on('data',record);
await writeFile(join(report,'reference-process.json'),JSON.stringify({pid:child.pid,home}));
child.on('exit',async code=>{await queue; process.exitCode=code??1;});
for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>child.kill());
