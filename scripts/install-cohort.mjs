import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { runtimeEnvironment } from '../packages/rsi-dsh-cordis/src/runtime/node.mjs';

const archiveRoot = resolve(process.argv[2] ?? '.local/upstream');
const destination = resolve(process.argv[3] ?? '.local/cohort');
const receipt = JSON.parse(await readFile(join(archiveRoot, 'receipt.json'), 'utf8'));
const dependencies = { ...receipt.browserDependencies };
if (process.argv[4]) {
  const plugins = resolve(process.argv[4]);
  const packed = JSON.parse(await readFile(join(plugins, 'receipt.json'), 'utf8'));
  for (const artifact of packed.artifacts) {
    const file = join(plugins, artifact.filename);
    if (createHash('sha256').update(await readFile(file)).digest('hex') !== artifact.sha256) throw new Error('plugin tarball digest mismatch');
    dependencies[artifact.name] = `file:${file.replaceAll('\\', '/')}`;
  }
}
for (const artifact of receipt.artifacts) {
  const file = join(archiveRoot, artifact.tarball);
  if (createHash('sha256').update(await readFile(file)).digest('hex') !== artifact.sha256) throw new Error('tarball digest mismatch');
  dependencies[artifact.name] = `file:${file.replaceAll('\\', '/')}`;
}
await mkdir(destination, { recursive: true });
await mkdir(join(destination, 'home'), { recursive: true });
const userconfig = join(destination, 'npmrc');
await writeFile(userconfig, 'registry=https://registry.npmjs.org/\n');
const globalconfig = join(destination, 'global-npmrc');
await writeFile(globalconfig, '');
await writeFile(join(destination, 'package.json'), JSON.stringify({ name: 'rsi-dsh-acceptance-cohort', version: '0.0.0', private: true, type: 'module', dependencies }, null, 2));
execFileSync(process.execPath, [resolve('node_modules/npm/bin/npm-cli.js'), 'install', '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund', '--strict-peer-deps', '--prefer-dedupe', '--omit=dev'], {
  cwd: destination, stdio: 'inherit', env: { ...runtimeEnvironment(), HOME: join(destination, 'home'), USERPROFILE: join(destination, 'home'),
    npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, npm_config_cache: join(destination, 'cache') },
});
let files = 0, bytes = 0;
async function measure(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name); const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`cohort contains link: ${name}`);
    if (stat.isDirectory()) await measure(path);
    else if (stat.isFile()) { files++; bytes += stat.size; }
    else throw new Error('unexpected cohort file type');
  }
}
await measure(join(destination, 'node_modules'));
const lock = await readFile(join(destination, 'package-lock.json'));
await writeFile(join(destination, 'receipt.json'), JSON.stringify({ ...receipt, files, bytes, npm: '11.17.0', lockSha256: createHash('sha256').update(lock).digest('hex') }, null, 2) + '\n');
console.log(JSON.stringify({ files, bytes }));
