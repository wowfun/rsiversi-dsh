// Build an isolated npm installation from published packages or packed
// comparison artifacts. The running app never imports the source checkout.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runtimeEnvironment } from '../packages/rsi-dsh-cordis/src/runtime/node.mjs';

const { values, positionals } = parseArgs({
  options: { from: { type: 'string' }, 'runtime-only': { type: 'boolean' } },
  allowPositionals: true,
});
const [directory, version, npmEntry, marketVersion='1.73.11', sidebarVersion='0.30.1'] = positionals;
if (!directory || !npmEntry || !version)
  throw new Error('Expected isolated output directory, reference release, and absolute npm CLI');
const root = resolve(directory);
await mkdir(root, { recursive: true });
const cache=join(dirname(root),'npm-download-cache');
const npm=createRequire(resolve(npmEntry));
const packed = new Map();
if (values.from) {
  const files = (await readdir(values.from)).filter(name => name.endsWith('.tgz'));
  const pacote = npm('pacote');
  for (const file of files) {
    const path = resolve(values.from, file);
    const manifest = await pacote.manifest(path, { cache });
    if (packed.has(manifest.name)) throw new Error('Multiple packed versions of ' + manifest.name);
    packed.set(manifest.name, { manifest, url: pathToFileURL(path).href });
  }
}
const packages = Object.fromEntries(['dsh', 'dsh-client-web', 'dsh-client-modules',
  'dsh-client-ui-plugin-manager', 'dsh-client-ui-plugin-market', 'dsh-host-webserver',
  'dsh-api-terminal-controller'].map(name => ['@deepseek-ai/' + name, version]));
// Explicit root placements keep Arborist from filling an optional peer with a
// different release while resolving the two third-party bundles together.
async function publishedManifest(name, selected) {
  const local=packed.get(name);
  if(local) {
    if(local.manifest.version!==selected)throw new Error('Packed version differs: '+name);
    return local.manifest;
  }
  if(values.from && (name==='@deepseek-ai/dsh'||name.startsWith('@deepseek-ai/dsh-')))
    throw new Error('Missing packed comparison package: '+name);
  const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name) + '/' + encodeURIComponent(selected));
  if (!response.ok) throw new Error('Registry metadata unavailable: '+name+'@'+selected);
  const manifest=await response.json();
  if(manifest.version!==selected)throw Error('Expected exact published version: '+name+'@'+selected);
  return manifest;
}
const targets=values['runtime-only']?{}:{dshmarket:marketVersion,'dsh-better-sidebar':sidebarVersion};
const plugins=await Promise.all(Object.entries(targets).map(([name,v])=>publishedManifest(name,v)));
function select(name) {
  if (packed.has(name)) packages[name]=packed.get(name).manifest.version;
  else if (name.startsWith('@deepseek-ai/dsh-')) packages[name]=version;
}
for(const plugin of plugins) for(const name of Object.keys(plugin.peerDependencies??{})) select(name);
const read = new Set();
let cordisSpec;
while (true) {
  const batch = Object.keys(packages).filter(name => !read.has(name)).slice(0, 12);
  if (!batch.length) break;
  await Promise.all(batch.map(async name => {
    read.add(name);
    const manifest = await publishedManifest(name, packages[name]);
    if (name === '@deepseek-ai/dsh') cordisSpec = manifest.dependencies['@deepseek-ai/cordis'];
    for (const dependency of Object.keys({...manifest.dependencies, ...manifest.peerDependencies})) {
      if (manifest.peerDependenciesMeta?.[dependency]?.optional) continue;
      select(dependency);
    }
  }));
  if (Object.keys(packages).length > 512) throw new Error('Runtime dependency graph capacity');
}
const dependencies = { ...packages, '@deepseek-ai/cordis': cordisSpec, ...targets };
for(const name of Object.keys(dependencies)) {
  if(packed.has(name)) dependencies[name]=packed.get(name).url;
}
await writeFile(join(root, 'package.json'), JSON.stringify({name:'rsi-dsh-release-fixture', private:true, dependencies}, null, 2));
const home = join(root, '.home');
await mkdir(home, { recursive: true });
await writeFile(join(home, 'npmrc'), '');
await writeFile(join(home, 'global-npmrc'), '');
const child = spawn(process.execPath, [resolve(npmEntry), 'install', values['runtime-only']?'--strict-peer-deps':'--legacy-peer-deps', '--prefer-dedupe', '--ignore-scripts',
  '--bin-links=false', '--no-audit', '--no-fund', '--fetch-retries=1', '--registry=https://registry.npmjs.org/'], {
  cwd:root, windowsHide:true, stdio:'inherit', env:{ ...runtimeEnvironment(), HOME:home, USERPROFILE:home,
    npm_config_userconfig:join(home,'npmrc'), npm_config_globalconfig:join(home,'global-npmrc'), npm_config_cache:cache }
});
await new Promise((accept,reject) => {
  child.once('error',reject);
  child.once('exit',code => code === 0 ? accept() : reject(new Error('npm install failed: '+code)));
});
const lock = JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
if(values.from) {
  for(const name of Object.keys(dependencies)) {
    const archive=packed.get(name);
    if(archive && lock.packages['node_modules/'+name]?.integrity!==String(archive.manifest._integrity))
      throw new Error('Installed dependency differs from comparison archive: '+name);
  }
}
const selected = Object.fromEntries(Object.keys(dependencies).map(name => [name, lock.packages['node_modules/'+name].version]));
await writeFile(join(root,'resolution.json'),JSON.stringify({version,selected,entries:Object.keys(lock.packages).length-1},null,2));
