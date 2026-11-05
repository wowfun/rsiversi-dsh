import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const directory = resolve('.local/plugins');
await mkdir(directory, { recursive: true });
const artifacts = [];
for (const name of ['rsi-dsh-cordis', 'rsi-dsh-plugin-bridge']) {
  const result = JSON.parse(execFileSync(process.execPath, [resolve('node_modules/npm/bin/npm-cli.js'), 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: resolve('packages', name), encoding: 'utf8' }))[0];
  const bytes = await readFile(join(directory, result.filename));
  artifacts.push({ name, filename: result.filename, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
}
await writeFile(join(directory, 'receipt.json'), JSON.stringify({ artifacts }, null, 2));
console.log(JSON.stringify(artifacts));
