import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { writePayload } from '../packages/rsi-dsh-cordis/src/archive/payload.mjs';
const destination = resolve(process.argv[2] ?? '.local/cohort-package');
await mkdir(destination, { recursive: true });
const result = await writePayload(resolve(process.argv[3] ?? '.local/cohort', 'node_modules'), join(destination, 'cohort.rsi'));
await writeFile(join(destination, 'package.json'), JSON.stringify({ format: 2, name: 'dsh-acceptance-cohort', version: 'ce7073d5', target: 'portable',
  dependencies: [], requires: [], files: [{ path: 'cohort.rsi', bytes: result.bytes, digest: result.digest, executable: false }],
  exports: { node_modules: { kind: 'payload_tree', path: 'cohort.rsi' } } }, null, 2) + '\n');
console.log(JSON.stringify(result));
