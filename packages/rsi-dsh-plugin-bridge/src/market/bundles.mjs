import {isAbsolute,relative,sep} from 'node:path';

// DSH owns bundle eligibility and patch order. The Store lease bounds the patch files.
export function bundlePatches(boot,directory,exemptions,runtimeVersion) {
  const manifest=boot.readProfileManifest('rsi-dsh',directory);
  const bundle=manifest.dsh?.bundle;
  if(!bundle)throw new Error('Missing dsh.bundle in '+directory);
  boot.assertBundlePlatform(bundle.platforms,process.platform);
  const issue=boot.evaluatePluginCompatibility(manifest,exemptions,runtimeVersion);
  if(issue&&!issue.exempted)throw new Error(boot.pluginCompatibilityWarning(issue));
  return boot.bundlePatchPaths(directory,bundle).map(patch=>{
    const local=relative(directory,patch);
    if(!local||local==='..'||local.startsWith('..'+sep)||isAbsolute(local))
      throw new Error('Bundle patch is outside its package: '+manifest.name);
    return boot.loadOverlayPatches('rsi-dsh',patch);
  });
}
