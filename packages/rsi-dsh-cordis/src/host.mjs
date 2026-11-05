import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { Peer } from './runtime/transport.mjs';
import { loadCohort } from './runtime/cohort.mjs';
import { supportsNode } from './runtime/node.mjs';

if (!supportsNode(process.version)) throw new Error('Node >=24.9.0 required');

// Stdout is exclusively the protocol. Trusted plugins can still access native IO.
for (const name of ['log', 'info', 'debug', 'warn', 'error']) {
  console[name] = (...args) => process.stderr.write(args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ') + '\n');
}
const [generation, bridgeEntry, cohortRoot, configPath] = process.argv.slice(2);
if (!generation || !bridgeEntry || !cohortRoot) throw new Error('generation, bridge entry and installed cohort are required');
const { createExtension } = await import(pathToFileURL(resolve(bridgeEntry)));
let peer;
let configuration;
if (configPath) {
  if ((await stat(configPath)).size > 64 * 1024) throw new Error('Extension configuration capacity');
  configuration = JSON.parse(await readFile(configPath, 'utf8'));
}
const extension = await createExtension({ cohortRoot: resolve(cohortRoot), cohortLoader: loadCohort, configuration,
  hostModules: { importCohort: (await import('./registry/import.mjs')).importCohort, writePayload: (await import('./archive/payload.mjs')).writePayload },
  request: (method, payload, signal) => peer.request(method, payload, { signal }) });
peer = new Peer({ input: process.stdin, output: process.stdout, generation, onClose: async () => {
  await extension.close(); process.stdin.destroy(); process.exitCode = 0;
}, handler: async (method, args, signal) => {
  if (method === 'extension.hello') {
    if (args?.protocol !== 1) throw new Error('unsupported extension protocol');
    return { protocol: 1 };
  }
  if (method === 'extension.close') { await extension.close(); return null; }
  if (method === 'extension.ping') return null;
  return extension.handle(method, args, signal);
} });
