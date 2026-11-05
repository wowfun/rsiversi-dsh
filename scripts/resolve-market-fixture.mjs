// Resolve the real release and both published targets under the same npm
// rules as an install. The source tree is never used for module resolution.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {createRequire} from 'node:module';
import { runtimeEnvironment } from '../packages/rsi-dsh-cordis/src/runtime/node.mjs';
import {prereleasePeerOverrides} from '../packages/rsi-dsh-cordis/src/registry/requirements.mjs';

const [directory, version, npmEntry, marketVersion='1.73.11', sidebarVersion='0.30.1'] = process.argv.slice(2);
if (!directory || !npmEntry || !version)
  throw new Error('Expected isolated output directory, reference release, and absolute npm CLI');
const root = resolve(directory);
await mkdir(root, { recursive: true });
const packages = Object.fromEntries(['dsh', 'dsh-client-web', 'dsh-client-modules',
  'dsh-client-ui-plugin-manager', 'dsh-client-ui-plugin-market', 'dsh-host-webserver',
  'dsh-api-terminal-controller'].map(name => ['@deepseek-ai/' + name, version]));
// Explicit root placements keep Arborist from filling an optional peer with a
// different release while resolving the two third-party bundles together.
async function publishedManifest(name, selected) {
  const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name) + '/' + encodeURIComponent(selected));
  if (!response.ok) throw new Error('Registry metadata unavailable: '+name+'@'+selected);
  const manifest=await response.json();
  if(manifest.version!==selected)throw Error('Expected exact published version: '+name+'@'+selected);
  return manifest;
}
const [runtime, market, sidebar] = await Promise.all([
  publishedManifest('@deepseek-ai/dsh', version),
  publishedManifest('dshmarket',marketVersion),
  publishedManifest('dsh-better-sidebar',sidebarVersion),
]);
for (const manifest of [runtime.dependencies, market.peerDependencies, sidebar.peerDependencies]) {
  for (const name of Object.keys(manifest)) {
    if (name.startsWith('@deepseek-ai/dsh-')) packages[name] = version;
  }
}
const read = new Set();
while (true) {
  const batch = Object.keys(packages).filter(name => !read.has(name)).slice(0, 12);
  if (!batch.length) break;
  await Promise.all(batch.map(async name => {
    read.add(name);
    const manifest = await publishedManifest(name, version);
    for (const dependency of Object.keys({...manifest.dependencies, ...manifest.peerDependencies})) {
      if (dependency.startsWith('@deepseek-ai/dsh-') && !manifest.peerDependenciesMeta?.[dependency]?.optional)
        packages[dependency] = version;
    }
  }));
  if (Object.keys(packages).length > 512) throw new Error('Runtime dependency graph capacity');
}
const dependencies = { ...packages, '@deepseek-ai/cordis': runtime.dependencies['@deepseek-ai/cordis'], dshmarket: marketVersion,
  'dsh-better-sidebar': sidebarVersion };
const overrides=prereleasePeerOverrides([market,sidebar],packages,createRequire(resolve(npmEntry))('semver'));
await writeFile(join(root, 'package.json'), JSON.stringify({name:'rsi-dsh-release-fixture', private:true, dependencies, overrides}, null, 2));
const home = join(root, '.home'), cache = join(dirname(root), 'npm-download-cache');
await mkdir(home, { recursive: true });
await writeFile(join(home, 'npmrc'), '');
await writeFile(join(home, 'global-npmrc'), '');
const child = spawn(process.execPath, [resolve(npmEntry), 'install', '--strict-peer-deps', '--prefer-dedupe', '--ignore-scripts',
  '--bin-links=false', '--no-audit', '--no-fund', '--fetch-retries=1', '--registry=https://registry.npmjs.org/'], {
  cwd:root, windowsHide:true, stdio:'inherit', env:{ ...runtimeEnvironment(), HOME:home, USERPROFILE:home,
    npm_config_userconfig:join(home,'npmrc'), npm_config_globalconfig:join(home,'global-npmrc'), npm_config_cache:cache }
});
await new Promise((accept,reject) => {
  child.once('error',reject);
  child.once('exit',code => code === 0 ? accept() : reject(new Error('npm install failed: '+code)));
});
const lock = JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
const selected = Object.fromEntries(Object.keys(dependencies).map(name => [name, lock.packages['node_modules/'+name].version]));
await writeFile(join(root,'resolution.json'),JSON.stringify({version,selected,entries:Object.keys(lock.packages).length-1},null,2));
