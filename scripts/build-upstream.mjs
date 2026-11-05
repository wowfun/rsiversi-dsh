import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { globSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {sourceIdentity} from './source-identity.mjs';

const source = resolve(process.argv[2] ?? '../rsiversi/.references/rsi/deepseek-harness');
const destination = resolve(process.argv[3] ?? '.local/upstream');
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
const requireUpstream = createRequire(join(source, 'package.json'));
const buildInputs = {
  baseline:identity.revision, node: process.version,
  lockSha256: hash(readFileSync(join(source, 'pnpm-lock.yaml'))),
  scriptSha256: hash(readFileSync(new URL(import.meta.url))),
  toolchain: Object.fromEntries(['typescript', 'tsdown', 'pnpm'].map(name =>
    [name, JSON.parse(readFileSync(join(source, 'node_modules', name, 'package.json'))).version])),
};
const buildInputSha256 = hash(JSON.stringify(buildInputs));
execFileSync(process.execPath, ['--max-old-space-size=8192', requireUpstream.resolve('typescript/bin/tsc'), '-b',
  'packages/typert/generator', ...[...selected.values()].map(pkg => relative(source, pkg.dir))],
  { cwd: source, stdio: 'inherit' });
const { build } = await import(pathToFileURL(requireUpstream.resolve('tsdown')));
const { decoratorPlugin } = await import(pathToFileURL(join(source, 'packages/typert/generator/lib/types/tsdown-plugin.js')));
const pnpmManifest = join(source, 'node_modules/pnpm/package.json');
const pnpm = join(dirname(pnpmManifest), JSON.parse(readFileSync(pnpmManifest)).bin.pnpm);
const artifacts = [];
const previous = existsSync(join(destination, 'receipt.json')) ? JSON.parse(readFileSync(join(destination, 'receipt.json'))) : undefined;
// Each invocation uses upstream build defaults and its original local config.
// Workspace pack rewrites workspace specifiers exactly as the upstream release does.
for (const [name, { manifest, dir }] of selected) {
  const cached = identity.cacheable && previous?.cacheable && previous.buildInputSha256 === buildInputSha256 ? previous.artifacts.find(artifact => artifact.name === name) : undefined;
  if (cached && existsSync(join(destination, cached.tarball)) && hash(readFileSync(join(destination, cached.tarball))) === cached.sha256) {
    artifacts.push(cached); continue;
  }
  if (!existsSync(join(dir, 'lib/types/index.js'))) throw new Error(`Compile original project first: ${name}`);
  const config = join(dir, 'tsdown.config.ts');
  if (existsSync(config)) {
    await build({ cwd: dir, config, configLoader: 'native' });
  } else {
    await build({ cwd: dir, config: false, entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false, plugins: [decoratorPlugin()] });
  }
  execFileSync(process.execPath, [pnpm, '--dir', dir, 'pack', '--pack-destination', destination], { cwd: source, stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
  const tarball = `${name.replace('@', '').replaceAll('/', '-')}-${manifest.version}.tgz`;
  artifacts.push({ name, version: manifest.version, source: relative(source, dir).replaceAll('\\', '/'), tarball,
    sha256: hash(readFileSync(join(destination, tarball))), entry: manifest.main, entrySha256: hash(readFileSync(join(dir, manifest.main))) });
  console.log(`packed ${artifacts.length}/${selected.size} ${name}`);
}
const completed=sourceIdentity(source);
const cacheable=identity.cacheable && completed.cacheable && completed.revision===identity.revision;
writeFileSync(join(destination, 'receipt.json'), JSON.stringify({ ...buildInputs, buildInputSha256, cacheable, pnpm: JSON.parse(readFileSync(pnpmManifest)).version, roots, browserDependencies, artifacts }, null, 2) + '\n');
