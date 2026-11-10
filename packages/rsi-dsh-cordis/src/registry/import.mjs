import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import {installNpm,npmManifest} from './npm-install.mjs';
import {installedPeers,packPeers} from './cohort.mjs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { walkFiles } from '../archive/tree.mjs';
import { loadCohort } from '../runtime/cohort.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export {npmImportFlags} from './npm-install.mjs';
const packageName = value => typeof value === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(value) && value.length <= 214;

import {checkRequirements,prereleasePeerOverrides} from './requirements.mjs';
export {checkRequirements} from './requirements.mjs';

/** npm is a pinned implementation detail, never an ambient user command/config. */
export async function importCohort({ cohortRoot, workspace, work, specifications, signal }) {
  const host = await loadCohort(cohortRoot);
  const runtimeVersion = (await host.import('@deepseek-ai/dsh-app-boot')).getDshRuntimeVersion();
  const npmRoot=join(cohortRoot,'node_modules/npm');
  const require = createRequire(join(npmRoot,'package.json'));
  const npa = require('npm-package-arg'), tar = require('tar'), semver = require('semver');
  const archive = join(work, 'archives'), root = join(work, 'cohort');
  await mkdir(archive, { recursive: true }); await mkdir(root);
  const peers=await installedPeers(cohortRoot);
  const specs = specifications.map(value => {
    if (typeof value !== 'string' || !value || value.length > 65536 || value.startsWith('-')) throw new Error('Invalid npm specification');
    const parsed = npa(value, workspace);
    if (!['version', 'range', 'tag', 'file', 'directory'].includes(parsed.type)) throw new Error('Only registry, local tarball or built directory specifications are supported');
    if (peers.has(parsed.name)) throw new Error(`Cannot replace pinned dependency: ${parsed.name}`);
    return parsed;
  });
  const manifests=await Promise.all(specs.map(spec=>npmManifest(npmRoot,spec,undefined,join(work,'cache'),signal)));
  for(const manifest of manifests) {
    if(peers.has(manifest.name))throw new Error(`Cannot replace pinned dependency: ${manifest.name}`);
    checkRequirements(manifest,runtimeVersion,semver);
  }
  const dependencies=await packPeers(cohortRoot,peers,archive,tar,signal);
  const versions=Object.fromEntries([...peers].map(([name,manifest])=>[name,manifest.version]));
  const overrides=prereleasePeerOverrides([...peers.values(),...manifests],versions,semver);
  await writeFile(join(root, 'package.json'), JSON.stringify({name:'rsi-dsh-import',version:'0.0.0',private:true,type:'module',dependencies,overrides}));
  await installNpm(npmRoot,root,work,specs.map(spec=>['file','directory'].includes(spec.type)?spec.fetchSpec:spec.raw),signal);
  signal.throwIfAborted();
  const installed = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const added = Object.keys(installed.dependencies).filter(name => !Object.hasOwn(dependencies,name));
  // npm canonicalizes local directory aliases; the resolved manifest owns identity.
  const plugins = manifests.map(manifest=>manifest.name);
  if (!plugins.length || plugins.length > 128 || plugins.length !== added.length ||
      new Set(plugins).size !== added.length || plugins.some(name => !packageName(name) || !added.includes(name)))
    throw new Error('Imported plugin names or count');
  for (const name of Object.keys(dependencies)) {
    if (installed.dependencies[name] !== dependencies[name]) throw new Error(`Import replaced runtime dependency: ${name}`);
  }
  async function validatePackages(directory) {
    for (const name of await readdir(directory)) {
      if (name.startsWith('.')) continue;
      const location = join(directory,name);
      if (name.startsWith('@')) { await validatePackages(location); continue; }
      const manifest = JSON.parse(await readFile(join(location,'package.json'),'utf8'));
      if (!packageName(manifest.name)) throw new Error('Invalid installed package identity');
      checkRequirements(manifest, runtimeVersion, semver);
      if (peers.has(manifest.name) && resolve(location) !== resolve(root,'node_modules',manifest.name))
        throw new Error(`Nested pinned package: ${manifest.name}`);
      const nested = join(location,'node_modules');
      try { await validatePackages(nested); } catch(error) { if (error.code !== 'ENOENT' || error.path !== nested) throw error; }
    }
  }
  await walkFiles(join(root,'node_modules'), async () => {}, {signal});
  await validatePackages(join(root,'node_modules'));
  for (const name of plugins) {
    const entry = await realpath(createRequire(join(root,'package.json')).resolve(name));
    const local = relative(root,entry);
    if (local.startsWith('..') || isAbsolute(local)) throw new Error('Plugin entry escaped imported cohort');
  }
  const {version:npmVersion}=JSON.parse(await readFile(join(npmRoot,'package.json'),'utf8'));
  return {root,plugins,runtimeVersion,npmVersion,lockSha256:hash(await readFile(join(root,'package-lock.json')))};
}
