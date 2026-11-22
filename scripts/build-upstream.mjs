import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { globSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import {sourceIdentity} from './source-identity.mjs';

const { values, positionals } = parseArgs({ options: { built: { type: 'boolean' } }, allowPositionals: true });
const source = resolve(positionals[0] ?? '../rsiversi/.references/rsi/deepseek-harness');
const destination = resolve(positionals[1] ?? '.local/upstream');
const roots = ['@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-plan-mode', '@deepseek-ai/dsh-client-ui-tool', '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity=sourceIdentity(source);
const packages = new Map();
for (const file of globSync(['packages/*/*/package.json', 'vendor/*/package.json'], { cwd: source })) {
  const manifest = JSON.parse(readFileSync(join(source, file)));
  packages.set(manifest.name, { manifest, dir: join(source, dirname(file)) });
}
const selected = new Map();
function select(name) {
  if (selected.has(name) || !packages.has(name)) return;
  const pkg = packages.get(name); selected.set(name, pkg);
  for (const name of Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.peerDependencies })) select(name);
  for (const name of pkg.manifest.dsh?.client?.inject ?? []) select(name);
}
roots.forEach(select);
const browserDependencies = { react: '18.3.1', 'react-dom': '18.3.1', '@tanstack/react-virtual': '3.14.10' };
for (const name of roots.slice(4)) {
  for (const [dependency, version] of Object.entries(packages.get(name).manifest.devDependencies ?? {})) {
    if (version.startsWith('workspace:')) select(dependency);
    else if (!dependency.startsWith('@types/') && dependency !== 'typescript' && !Object.hasOwn(browserDependencies, dependency)) browserDependencies[dependency] = version;
  }
}
mkdirSync(destination, { recursive: true });
const pnpmManifest = join(source, 'node_modules/pnpm/package.json');
const pnpmPackage = JSON.parse(readFileSync(pnpmManifest));
const pnpm = join(dirname(pnpmManifest), pnpmPackage.bin.pnpm);
const buildInputs = {
  baseline: identity.revision, node: process.version, lockSha256: hash(readFileSync(join(source, 'pnpm-lock.yaml'))),
  scriptSha256: hash(readFileSync(new URL(import.meta.url))),
  clientEnvironment: hash(JSON.stringify(Object.entries(process.env)
    .filter(([key]) => key.startsWith('DSH_CLIENT_') || key === 'DSH_BUILD_CLIENT_PROFILE')
    .sort(([left], [right]) => left.localeCompare(right)))),
  toolchain: Object.fromEntries(['typescript', 'tsdown', 'pnpm'].map(name =>
    [name, JSON.parse(readFileSync(join(source, 'node_modules', name, 'package.json'))).version])),
};
const buildInputSha256 = hash(JSON.stringify(buildInputs));
const receiptPath = join(destination, 'receipt.json');
const buildRecord = join(source, '.dsh-build/client-build-environment.json');
const tarballName = (name, version) => name.replace('@', '').replaceAll('/', '-') + '-' + version + '.tgz';
if (!values.built && identity.cacheable && existsSync(receiptPath) && existsSync(buildRecord)) {
  const previous = JSON.parse(readFileSync(receiptPath));
  if (previous.cacheable && previous.buildInputSha256 === buildInputSha256 &&
      previous.clientBuild?.artifacts.sha256 === JSON.parse(readFileSync(buildRecord)).artifacts.sha256 &&
      previous.artifacts.length === selected.size && previous.artifacts.every(artifact => {
        const pkg = selected.get(artifact.name);
        if (!pkg || artifact.tarball !== tarballName(artifact.name, pkg.manifest.version)) return false;
        const file = join(destination, artifact.tarball);
        return existsSync(file) && hash(readFileSync(file)) === artifact.sha256;
      })) process.exit(0);
}
function run(args) {
  execFileSync(process.execPath, [pnpm, ...args], { cwd: source, stdio: 'inherit', windowsHide: true });
}
if (!values.built) run(['run', 'build:artifacts']);
const clientBuild = JSON.parse(readFileSync(buildRecord));
run(['--recursive', '--workspace-concurrency=4', ...Array.from(selected.keys(), name => '--filter=' + name),
  'pack', '--pack-destination', destination]);
const artifacts = [];
for (const [name, { manifest, dir }] of selected) {
  const tarball = tarballName(name, manifest.version);
  artifacts.push({
    name, version: manifest.version, source: relative(source, dir).replaceAll('\\', '/'), tarball,
    sha256: hash(readFileSync(join(destination, tarball))), entry: manifest.main,
    entrySha256: hash(readFileSync(join(dir, manifest.main))),
  });
}
const completed = sourceIdentity(source);
const receipt = {
  ...buildInputs, buildInputSha256, cacheable: !values.built && identity.cacheable && completed.cacheable && identity.revision === completed.revision,
  pnpm: pnpmPackage.version, clientBuild, browserDependencies, roots, artifacts,
};
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
