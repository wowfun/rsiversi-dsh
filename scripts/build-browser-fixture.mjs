import { build, transform } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const cohort = resolve(process.argv[2] ?? '.local/cohort');
const output = resolve('.local/browser');
await mkdir(output, { recursive: true });
const approved = [];
for (const name of ['ui-tool', 'ui-plan', 'ui-theme']) {
  const id = `@deepseek-ai/dsh-client-${name}`;
  const bytes = await readFile(join(cohort, 'node_modules', id, 'lib/client.js'));
  await writeFile(join(output, `${name}.js`), bytes);
  approved.push({ id, url: `/${name}.js`, integrity: `sha256-${createHash('sha256').update(bytes).digest('base64')}` });
}
await writeFile('fixtures/browser/approved.json', JSON.stringify(approved, null, 2));
// The dictionary is not a standalone published module. This fixture copies original
// locale data only; both components under test remain the unchanged packed scripts.
const localeSource = await readFile(resolve(process.argv[3] ?? '../references/rsi/deepseek-harness', 'packages/client/ui-conversation/src/client/locales.ts'), 'utf8');
const { code } = await transform(localeSource, { loader: 'ts', format: 'esm' });
const { en } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
await writeFile('fixtures/browser/conversation.json', JSON.stringify(en));
await build({ entryPoints: ['fixtures/browser/entry.jsx'], outdir: output, bundle: true, format: 'esm',
  splitting: true, sourcemap: true, platform: 'browser', nodePaths: [join(cohort, 'node_modules')],
  alias: { react: join(cohort, 'node_modules/react'), 'react-dom': join(cohort, 'node_modules/react-dom') },
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'file' }, logLevel: 'info' });
await writeFile(join(output, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH original UI verification</title><link rel="stylesheet" href="/entry.css"><div id="root"></div><script type="module" src="/entry.js"></script></html>');
await writeFile(join(output, 'receipt.json'), JSON.stringify({ cohort, approved }, null, 2));
