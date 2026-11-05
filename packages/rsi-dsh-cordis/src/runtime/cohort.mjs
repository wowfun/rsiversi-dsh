import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve public exports from one installed graph. PackageStore owns the
 * integrity of this particular installation; source-entry hashes in build
 * receipts are not a compatibility test for a different release. */
export async function loadCohort(root) {
  root = await realpath(resolve(root));
  const require = createRequire(join(root, 'package.json'));
  const paths = new Map();
  function entry(name) {
    if (typeof name!=='string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 214)
      throw new Error('Invalid package export: '+name);
    if (paths.has(name)) return paths.get(name);
    const physical = realpathSync(require.resolve(name));
    const manifestPath = join(root,'node_modules',name,'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath,'utf8'));
    const consumer = createRequire(manifestPath);
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!peer.startsWith('@deepseek-ai/') && !['react','react-dom','zod'].includes(peer)) continue;
      let shared;
      try { shared = require.resolve(peer+'/package.json'); }
      catch (error) {
        if (manifest.peerDependenciesMeta?.[peer]?.optional && error.code==='MODULE_NOT_FOUND') continue;
        shared = require.resolve(peer);
        if (realpathSync(consumer.resolve(peer))!==realpathSync(shared)) throw new Error('split peer identity: '+name+' -> '+peer);
        continue;
      }
      if (realpathSync(consumer.resolve(peer+'/package.json'))!==realpathSync(shared))
        throw new Error('split peer identity: '+name+' -> '+peer);
    }
    paths.set(name,physical);
    return physical;
  }
  return Object.freeze({
    root,
    entry,
    async import(name) { return import(pathToFileURL(this.entry(name))); },
    async subpath(name, suffix) {
      entry(name);
      if (!/^[a-z][a-z/-]*$/.test(suffix)) throw new Error('invalid cohort subpath');
      return import(pathToFileURL(require.resolve(`${name}/${suffix}`)));
    },
  });
}
