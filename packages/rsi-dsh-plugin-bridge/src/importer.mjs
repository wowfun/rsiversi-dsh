import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/** One isolated importer process. The Rust owner publishes only after this work drains. */
export function createExtension({cohortRoot, hostModules}) {
  let active, retired = false;
  const stop = new AbortController();
  return { async close() { retired = true; stop.abort(); await active?.catch(() => {}); },
    async handle(method, request, signal) {
      if (method !== 'package.import' || retired || active) throw new Error('Importer unavailable');
      const operation = run(request, AbortSignal.any([signal, stop.signal])); active = operation;
      try { return await operation; } finally { active = undefined; }
    } };
  async function run(request, signal) {
    const {format, staging, workspace, specifications, importer} = request;
    if (format !== 1 || !isAbsolute(staging) || !isAbsolute(workspace) || !Array.isArray(specifications)
      || !specifications.length || specifications.length > 128 || specifications.some(value => typeof value !== 'string' || !value)
      || Buffer.byteLength(specifications.join('')) > 65536 || importer?.package !== 'rsi-dsh-plugin-bridge'
      || !/^[a-f0-9]{64}$/.test(importer.digest)) throw new Error('Invalid import request');
    const cordis = importer.dependencies.find(item => item.name === 'rsi-dsh-cordis');
    if (!cordis || !/^[a-f0-9]{64}$/.test(cordis.digest)) throw new Error('Importer has no pinned Cordis dependency');
    const work = await mkdtemp(join(tmpdir(),'dsh-npm-'));
    try {
      const {root,plugins,runtimeVersion,npmVersion,lockSha256} = await hostModules.importCohort({cohortRoot,workspace,work,specifications,signal});
      const selection = {format:1,plugins};
      const name = `dsh-import-${hash(json(plugins)).slice(0,24)}`;
      await writeFile(join(root,'plugins.json'),json(selection));
      const output = join(staging,name); await mkdir(output);
      signal.throwIfAborted();
      const payload = await hostModules.writePayload(root,join(output,'payload.rsi'), {signal, exclude: path => path === 'node_modules/.package-lock.json'});
      const runtime = {payload:'runtime',path:''};
      const path = (packageName, path) => ({kind:'path',location:{...runtime,...(packageName ? {package:packageName} : {}),path}});
      const descriptor = json({format:1,cwd:runtime,arguments:[
        path(cordis.name,'node_modules/rsi-dsh-cordis/src/host.mjs'),{kind:'generation'},
        path(importer.package,'src/index.mjs'),path(null,''),path(null,'plugins.json')]});
      const receipt = json({format:1,runtimeVersion,plugins,npm:npmVersion,lockSha256});
      const files = [{path:'payload.rsi',bytes:payload.bytes,digest:payload.digest,executable:false}];
      for (const [filename,bytes] of [['process.json',descriptor],['import.json',receipt]]) {
        await writeFile(join(output,filename),bytes); files.push({path:filename,bytes:bytes.length,digest:hash(bytes),executable:false});
      }
      await writeFile(join(output,'package.json'),json({format:2,name,version:'0.1.0',target:'portable',
        dependencies:[cordis,{name:importer.package,digest:importer.digest}],
        requires:[{name:'rsi.extension.process',version:1},{name:'rsi.extension.agent',version:8}],files,
        exports:{runtime:{kind:'payload_tree',path:'payload.rsi',index_digest:payload.indexDigest},process:{kind:'process_extension',path:'process.json'}}}));
      signal.throwIfAborted(); return {format:1,directories:[name]};
    } finally { await rm(work,{recursive:true,force:true}); }
  }
}
