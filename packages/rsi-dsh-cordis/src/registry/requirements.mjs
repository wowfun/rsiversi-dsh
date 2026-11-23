// DSH app-boot's engines.dsh precedence and peer fallback; no implicit exemptions.
const isDshPeer=name=>name==='@deepseek-ai/dsh'||name.startsWith('@deepseek-ai/dsh-');
export function checkRequirements(manifest, runtime, semver) {
  const peers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => isDshPeer(name));
  const engine = Object.hasOwn(manifest.engines ?? {}, 'dsh');
  for (const [name, range] of engine ? [['engines.dsh', manifest.engines.dsh]] : peers) {
    const value = !engine && ['workspace:^','workspace:~','workspace:*'].includes(range) ? runtime : range;
    if (typeof value !== 'string' || !value.trim() || !semver.satisfies(runtime,value,{includePrerelease:true}))
      throw new Error(`Incompatible ${name} for ${manifest.name}: ${range}`);
  }
}

