import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { writePayload } from '../packages/rsi-dsh-cordis/src/archive/payload.mjs';

const cohort = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const artifacts = [];
for (const name of ['rsi-dsh-cordis', 'rsi-dsh-plugin-bridge']) {
  const output = join(destination, name);
  await mkdir(output, { recursive: true });
  const cordis = name === 'rsi-dsh-cordis';
  const payload = await writePayload(cordis ? join(cohort, 'node_modules') : join(cohort, 'node_modules', name), join(output, 'payload.rsi'),
    cordis ? { prefix: 'node_modules', exclude: path => path === '.package-lock.json' || path === 'rsi-dsh-plugin-bridge' } : {});
  const manifest = { format: 2, name, version: '0.1.0', target: 'portable',
    dependencies: cordis ? [] : [{ name: 'rsi-dsh-cordis', digest: artifacts[0].digest }],
    requires: [{ name: 'rsi.extension.process', version: 1 }, ...(cordis ? [] : [{ name: 'rsi.extension.agent', version: 7 }])],
    files: [{ path: 'payload.rsi', bytes: payload.bytes, digest: payload.digest, executable: false }],
    exports: { runtime: { kind: 'payload_tree', path: 'payload.rsi' } } };
  if (!cordis) {
    const runtime = { package: 'rsi-dsh-cordis', payload: 'runtime', path: '' };
    const descriptor = Buffer.from(JSON.stringify({ format: 1, cwd: runtime, arguments: [
      { kind: 'path', location: { ...runtime, path: 'node_modules/rsi-dsh-cordis/src/host.mjs' } },
      { kind: 'generation' }, { kind: 'path', location: { payload: 'runtime', path: 'src/index.mjs' } },
      { kind: 'path', location: runtime },
    ] }, null, 2) + '\n');
    await writeFile(join(output, 'process.json'), descriptor);
    manifest.files.push({ path: 'process.json', bytes: descriptor.length, digest: sha256(descriptor), executable: false });
    manifest.exports.process = { kind: 'process_extension', path: 'process.json' };
    const importer = JSON.parse(descriptor);
    importer.arguments[2].location.path = 'src/importer.mjs';
    const importerBytes = Buffer.from(JSON.stringify(importer,null,2) + '\n');
    await writeFile(join(output,'importer.json'), importerBytes);
    manifest.files.push({path:'importer.json',bytes:importerBytes.length,digest:sha256(importerBytes),executable:false});
    manifest.requires.push({name:'rsi.packages.importer',version:1});
    manifest.exports.import = {kind:'package_importer',path:'importer.json'};
    if (process.argv[4]) {
      const web = resolve(process.argv[4]);
      const browser = JSON.parse(await readFile(join(web, 'package.json'), 'utf8'));
      if (browser.exports.web?.kind !== 'web_assets') throw new Error('Expected independently assembled Web package');
      for (const file of browser.files) {
        if (!/^[a-zA-Z0-9._/-]+$/.test(file.path) || file.path.split('/').some(part => !part || part === '..')) throw new Error('Invalid Web package path');
        const bytes = await readFile(join(web, file.path));
        if (bytes.length !== file.bytes || sha256(bytes) !== file.digest) throw new Error('Web package changed after assembly');
        await mkdir(dirname(join(output, file.path)), {recursive:true});
        await copyFile(join(web, file.path), join(output, file.path));
        manifest.files.push(file);
      }
      manifest.requires.push(...browser.requires);
      manifest.exports.web = browser.exports.web;
      const profile = Buffer.from(`format = 1\n[[steps]]\nkind = "plugin"\nid = "service"\nplugin = "rsi.application.service"\nconfig = { host_profile = "standard" }\n[[steps]]\nkind = "plugin"\nid = "application"\nplugin = "rsi.application.web"\nconfig = { assets = { kind = "package", package = "rsi-dsh-plugin-bridge", export = "web" } }\n`);
      await writeFile(join(output, 'application.profile.toml'), profile);
      manifest.files.push({path:'application.profile.toml',bytes:profile.length,digest:sha256(profile),executable:false});
      manifest.exports.application = {kind:'application_profile',path:'application.profile.toml'};
    }
  }
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(output, 'package.json'), bytes);
  artifacts.push({ name, digest: sha256(bytes), payload });
}
await writeFile(join(destination, 'receipt.json'), JSON.stringify({ artifacts }, null, 2) + '\n');
console.log(JSON.stringify(artifacts));
