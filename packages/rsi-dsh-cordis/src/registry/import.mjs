import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import {installNpm} from './npm-install.mjs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { walkFiles } from '../archive/tree.mjs';
import { loadCohort } from '../runtime/cohort.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export {npmImportFlags} from './npm-install.mjs';
const packageName = value => typeof value === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(value) && value.length <= 214;

import {checkRequirements} from './requirements.mjs';
export {checkRequirements} from './requirements.mjs';

/** npm is a pinned implementation detail, never an ambient user command/config. */
export async function importCohort({ cohortRoot, lock, workspace, work, specifications, signal }) {
  const host = await loadCohort(cohortRoot);
  const runtimeVersion = (await host.import('@deepseek-ai/dsh-app-boot')).getDshRuntimeVersion();
  const require = createRequire(join(cohortRoot, 'node_modules/npm/package.json'));
  const npa = require('npm-package-arg'), tar = require('tar'), semver = require('semver');
  const archive = join(work, 'archives'), root = join(work, 'cohort');
  await mkdir(archive, { recursive: true }); await mkdir(root);
  const dependencies = { ...lock.browserDependencies };
  for (const artifact of lock.artifacts) {
    signal.throwIfAborted();
    const directory = join(cohortRoot, 'node_modules', artifact.name);
    const target = join(archive, `${hash(artifact.name)}.tgz`);
    await tar.c({ gzip: true, file: target, cwd: directory, prefix: 'package', filter: path => !path.split(/[\\/]/).includes('.rsi-namespace-pin') }, ['.']);
    dependencies[artifact.name] = `file:${target.replaceAll('\\', '/')}`;
  }
  const specs = specifications.map(value => {
    if (typeof value !== 'string' || !value || value.length > 65536 || value.startsWith('-')) throw new Error('Invalid npm specification');
    const parsed = npa(value, workspace);
    if (!['version', 'range', 'tag', 'file', 'directory'].includes(parsed.type)) throw new Error('Only registry, local tarball or built directory specifications are supported');
    if (parsed.name && Object.hasOwn(dependencies, parsed.name)) throw new Error(`Cannot replace pinned dependency: ${parsed.name}`);
    return parsed.type === 'file' || parsed.type === 'directory' ? parsed.fetchSpec : parsed.raw;
  });
  await writeFile(join(root, 'package.json'), JSON.stringify({name:'rsi-dsh-import',version:'0.0.0',private:true,type:'module',dependencies}));
  await installNpm(join(cohortRoot,'node_modules/npm'),root,work,specs,signal);
  signal.throwIfAborted();
  const installed = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const added = Object.keys(installed.dependencies).filter(name => !Object.hasOwn(dependencies,name));
  const plugins = specifications.map(spec => {
    const wanted = npa(spec,workspace);
    if (wanted.name) return wanted.name;
    return added.find(name => npa.resolve(name,installed.dependencies[name],root).fetchSpec === wanted.fetchSpec);
  });
  if (!plugins.length || plugins.length > 128 || plugins.length !== added.length ||
      new Set(plugins).size !== added.length || plugins.some(name => !packageName(name) || !added.includes(name)))
    throw new Error('Imported plugin names or count');
  for (const name of Object.keys(dependencies)) {
    if (installed.dependencies[name] !== dependencies[name]) throw new Error(`Import replaced runtime dependency: ${name}`);
  }
  const cohort = await loadCohort(root);
  const shared = new Map(lock.artifacts.map(artifact => [artifact.name, cohort.entry(artifact.name)]));
  async function validatePackages(directory) {
    for (const name of await readdir(directory)) {
      if (name.startsWith('.')) continue;
      const location = join(directory,name);
      if (name.startsWith('@')) { await validatePackages(location); continue; }
      const manifest = JSON.parse(await readFile(join(location,'package.json'),'utf8'));
      if (!packageName(manifest.name)) throw new Error('Invalid installed package identity');
      checkRequirements(manifest, runtimeVersion, semver);
      if (shared.has(manifest.name) && await realpath(location) !== await realpath(join(root,'node_modules',manifest.name)))
        throw new Error(`Nested pinned package: ${manifest.name}`);
      const consumer = createRequire(join(location,'package.json'));
      for (const dependency of Object.keys({...manifest.dependencies,...manifest.peerDependencies})) {
        if (shared.has(dependency) && await realpath(consumer.resolve(dependency)) !== shared.get(dependency)) throw new Error(`Split peer identity: ${manifest.name} -> ${dependency}`);
      }
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
  return {root,plugins,lockSha256:hash(await readFile(join(root,'package-lock.json')))};
}
