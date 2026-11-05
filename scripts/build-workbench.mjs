import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// The producer receives an independently built matching Worker/WASM bundle. It
// rebuilds the complete document against the same family and React, then renews
// the bundle's receipt. This is source SDK acceptance, not a published SDK claim.
const [rsi, cohort, base, output] = process.argv.slice(2).map(path => resolve(path));
if (!output) throw new Error('Usage: build-workbench.mjs RSI_SOURCE INSTALLED_COHORT BASE_BUNDLE EMPTY_OUTPUT');
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Output must be empty');
for (const name of await readdir(base)) await copyFile(join(base, name), join(output, name));
const receipt = JSON.parse(await readFile(join(base, 'rsi-build.json'), 'utf8'));
process.env.RSI_BUILD_FAMILY_SHA256 = receipt.family_sha256;
const approved = [];
for (const name of ['ui-tool', 'ui-plan', 'ui-theme']) {
  const id = `@deepseek-ai/dsh-client-${name}`;
  const bytes = await readFile(join(cohort, 'node_modules', id, 'lib/client.js'));
  const filename = `dsh-${name}.js`;
  await writeFile(join(output, filename), bytes);
  approved.push({ id, url: `/${filename}`, integrity: `sha256-${createHash('sha256').update(bytes).digest('base64')}` });
}
const generated = resolve('.local/workbench-source');
await mkdir(generated, { recursive: true });
const entry = join(generated, 'entry.jsx');
const path = value => JSON.stringify(value.replaceAll('\\', '/'));
await writeFile(entry, `import * as sdk from ${path(join(rsi, 'apps/web/src/document-plugins.tsx'))};
import { mountWorkbench } from ${path(join(rsi, 'apps/web/src/workbench-root.tsx'))};
import { installWorkbenchBridge } from ${path(resolve('packages/rsi-dsh-plugin-bridge/src/browser/index.jsx'))};
try {
await installWorkbenchBridge(sdk, ${JSON.stringify(approved)});
const owner = mountWorkbench(document.getElementById('root'));
owner.runtime.start();
} catch (error) {
  console.error(error);
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = "Unable to start workbench: " + String(error.message ?? error).slice(0, 2048);
  document.getElementById("root").replaceChildren(message);
}
`);
const web = join(rsi, 'apps/web');
const { build } = await import(pathToFileURL(join(web, 'node_modules/vite/dist/node/index.js')));
const { documentConfiguration } = await import(pathToFileURL(join(web, 'vite.config.mjs')));
const config = documentConfiguration({ command: 'build' });
const modules = join(cohort, 'node_modules').replaceAll('\\', '/');
await build({ ...config, root: web, configFile: false, resolve: { ...config.resolve, alias: {
  ...config.resolve.alias,
  react: join(web, 'node_modules/react'), 'react-dom': join(web, 'node_modules/react-dom'),
  '@deepseek-ai': `${modules}/@deepseek-ai`, '@tanstack': `${modules}/@tanstack`,
  zod: `${modules}/zod`, 'rsi-dsh-cordis/browser': resolve('packages/rsi-dsh-cordis/src/runtime/browser.mjs'),
} }, build: { ...config.build, outDir: output, assetsInlineLimit: 0, cssCodeSplit: false,
  rollupOptions: { ...config.build.rollupOptions, input: entry, output: {
    inlineDynamicImports: true, entryFileNames: 'app.js', assetFileNames: asset => asset.names?.some(name => name.endsWith('.css')) ? 'styles.css' : '[name]-[hash][extname]',
  } } } });
const files = (await readdir(output)).filter(name => name !== 'rsi-build.json').sort();
const descriptor = `${output}.assets.json`;
await writeFile(descriptor, JSON.stringify({ files, trusted_inline_styles: true }, null, 2));
const check = spawnSync('cargo', ['run', '--locked', '-p', 'rsi-web-assets', '--example', 'check_bundle', '--',
  output, '--write-pairing', receipt.family_sha256, JSON.stringify(receipt.desktop_bridge), '--document', descriptor], { cwd: rsi, stdio: 'inherit' });
if (check.status !== 0) throw new Error('Workbench bundle admission failed');
await writeFile(`${output}.receipt.json`, JSON.stringify({ approved, sdk: rsi, cohort, family: receipt.family_sha256 }, null, 2));
console.log(JSON.stringify({ event: 'dsh-workbench-built', output, files: files.length, configuration: `${output}.assets.json` }));
