import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {writeMarketServiceProfile} from '../../scripts/market-service-profile.mjs';

const [bin,home,shards,selection,document]=process.argv.slice(2).map(path=>resolve(path));
const config=join(home,'config/rsi'),state=join(home,'state/rsi');
await mkdir(home,{recursive:false});
const receipt=JSON.parse(await readFile(join(selection,'receipt.json'),'utf8'));
if(receipt.plugins.length || receipt.artifacts.some(row=>row.owner!=='runtime')) throw new Error('Expected a runtime-only selection');
const base=['--config-home',config,'--state-home',state,'--cache-home',join(home,'cache/rsi')];
function run(...args) {
  return execFileSync(bin,[...base,...args],{cwd:home,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
}
run('config','init');
const start=Date.now();
const installed=JSON.parse(run('plugin','install','--local',...receipt.artifacts.map(row=>join(shards,row.name)),
  ...[receipt.toolchain,receipt.selection,receipt.importer].map(row=>join(selection,row.name))));
const profile=join(config,'host-profiles/market');await mkdir(profile,{recursive:true});
await writeMarketServiceProfile({receipt:join(selection,'receipt.json'),document,state,profile:'market',output:join(profile,'host.profile.toml'),importer:true});
await writeFile(join(config,'rsi.toml'),"format = 1\n[service]\nkind = 'catalog'\nid = 'market'\n");
console.log(JSON.stringify({installed:Object.keys(installed.packages),elapsedMs:Date.now()-start}));
