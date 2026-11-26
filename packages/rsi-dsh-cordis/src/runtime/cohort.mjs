import { registerHooks } from 'node:module';
import { realpath } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Scope one synchronous ESM lookup to an immutable cohort without writing a
// resolver module into its payload. Plugin evaluation uses Node's usual loader.
function resolveImport(name,parentURL) {
  const hook=registerHooks({resolve(specifier,context,next) {
    return next(specifier,context.parentURL===import.meta.url?{...context,parentURL}:context);
  }});
  try {return fileURLToPath(import.meta.resolve(name));}
  finally {hook.deregister();}
}

function peerFile(peer,issuer) {
  try {return realpathSync(resolveImport(peer+'/package.json',issuer));}
  catch(error){if(error.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw error;}
  return realpathSync(resolveImport(peer,issuer));
}

/** Resolve public exports from one installed graph. PackageStore owns the
 * integrity of this particular installation; source-entry hashes in build
 * receipts are not a compatibility test for a different release. */
export async function loadCohort(root) {
  root = await realpath(resolve(root));
  const parent=pathToFileURL(join(root,'package.json')).href;
  const paths = new Map();
  function entry(name) {
    if (typeof name!=='string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 214)
      throw new Error('Invalid package export: '+name);
    if (paths.has(name)) return paths.get(name);
    const physical = realpathSync(resolveImport(name,parent));
    const manifestPath = join(root,'node_modules',name,'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath,'utf8'));
    const consumer=pathToFileURL(physical).href;
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!peer.startsWith('@deepseek-ai/') && !['react','react-dom','zod'].includes(peer)) continue;
      let shared;
      try { shared = peerFile(peer,parent); }
      catch (error) {
        if (manifest.peerDependenciesMeta?.[peer]?.optional && error.code==='ERR_MODULE_NOT_FOUND') continue;
        throw error;
      }
      if (peerFile(peer,consumer)!==shared)
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
      return import(pathToFileURL(resolveImport(`${name}/${suffix}`,parent)));
    },
  });
}
