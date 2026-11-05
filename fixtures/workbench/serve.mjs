import { startFixtureProvider } from './provider.mjs';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentPreset } from '../../scripts/agent-preset.mjs';

const [rsi, packages, assets, report] = process.argv.slice(2).map(value => resolve(value));
await mkdir(report, {recursive:true});
const { startService } = await import(pathToFileURL(join(rsi,'fixtures/rsi/web-product/service.mjs')));
const provider = await startFixtureProvider(report);
const endpoint=`http://127.0.0.1:${provider.address().port}`;
const receipt=JSON.parse(await readFile(join(packages,'receipt.json'),'utf8'));
const digest=receipt.artifacts.find(artifact=>artifact.name==='rsi-dsh-plugin-bridge').digest;
const service=await startService({binary:join(rsi,'target/debug/rsi.exe'),assets,report,developmentHttp:true,
  configure:async ({config,run})=>{
    run(['plugin','install','--local',join(packages,'rsi-dsh-cordis'),join(packages,'rsi-dsh-plugin-bridge')], {timeout:300_000});
    let processPackage = 'rsi-dsh-plugin-bridge', processDigest = digest;
    if (process.env.RSI_DSH_IMPORT_FIXTURE === '1') {
      const fixture = resolve('fixtures/import-plugin');
      const result = run(['plugin','install','--importer','rsi-dsh-plugin-bridge/import','--program',process.execPath,fixture], {timeout:600_000});
      const resolution = JSON.parse(result.stdout);
      const candidates = Object.entries(resolution.packages).filter(([name]) => name.startsWith('dsh-import-'));
      if (candidates.length !== 1) throw new Error('Importer must publish one immutable selection');
      [processPackage] = candidates[0]; processDigest = candidates[0][1].digest;
      await writeFile(join(report,'imported.json'),JSON.stringify({name:processPackage,digest:processDigest,fixture},null,2));
    }
    const host=join(config,'host-profiles/fixture/host.profile.toml');
    const original=await readFile(host,'utf8');
    await writeFile(host,original.replace(/endpoint = "[^"]+"/,`endpoint = "${endpoint}"`));
    const settings=JSON.parse(await readFile(join(config,'settings.json'),'utf8'));
    settings['rsi.agent-presets']={default:'dsh-fixture'};
    await writeFile(join(config,'settings.json'),JSON.stringify(settings));
    const preset=join(config,'agent-presets/dsh-fixture'); await mkdir(preset,{recursive:true});
    await writeFile(join(preset,'agent.profile.toml'),agentPreset(processPackage,processDigest,process.execPath));
    const app=join(config,'application-profiles/dsh-workbench'); await mkdir(app,{recursive:true});
    const source=await readFile(join(packages,'rsi-dsh-plugin-bridge/application.profile.toml'),'utf8');
    await writeFile(join(app,'application.profile.toml'),source.replace('host_profile = "standard"','host_profile = "fixture"'));
  }});
let launch;
try { launch=service.run(['run','dsh-workbench','--port','0','--no-open'], {timeout:330_000}); }
catch(error) { await service.close(); provider.close(); throw error; }
const url=launch.stdout.trim().split('\n').find(line=>line.startsWith('rsi web: '))?.slice('rsi web: '.length);
if(!url) throw new Error('No packaged workbench launch URL');
const control=http.createServer(async (request,response)=>{
  if(request.url!=='/stop'||request.method!=='POST'){response.writeHead(404).end();return;}
  response.end('closing');
  try { service.run(['web','stop']); await service.close(); }
  finally { provider.close();control.close(); }
});
control.listen(0,'127.0.0.1'); await once(control,'listening');
const ready={url,control:`http://127.0.0.1:${control.address().port}/stop`,source:'installed package',package:digest,workspace:service.workspace};
await writeFile(join(report,'ready.json'),JSON.stringify(ready,null,2));
console.log(`Installed workbench ready (${digest}); private launch details are in the report directory.`);
