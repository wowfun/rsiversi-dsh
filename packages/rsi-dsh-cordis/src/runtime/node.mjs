import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/** Only OS essentials cross the launch boundary; Node/npm configuration never does. */
export function runtimeEnvironment(source = process.env) {
  const allowed = process.platform === 'win32' ? ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'] : ['TMPDIR', 'LANG'];
  const result = {};
  for (const key of allowed) {
    const actual = Object.keys(source).find(name => name.toLowerCase() === key.toLowerCase());
    if (actual !== undefined) result[key] = source[actual];
  }
  return result;
}
export function supportsNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match !== null && (+match[1] > 24 || (+match[1] === 24 && +match[2] >= 9));
}
async function probe(program) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(program, ['-p', 'JSON.stringify({version:process.version,executable:process.execPath})'], {
      env: runtimeEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    });
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 4096) child.kill(); });
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', code => {
      try {
        if (code !== 0 || output.length > 4096) throw new Error('Node probe failed');
        const info = JSON.parse(output);
        if (!supportsNode(info.version) || !isAbsolute(info.executable)) throw new Error('Node >=24.9.0 required');
        resolve(info);
      } catch (error) { reject(error); }
    });
  });
}
/** Resolve once per generation, then use this absolute executable for every spawn. */
export async function discoverNode({ executable, path = process.env.PATH ?? '' } = {}) {
  const candidates = executable ? [executable] : path.split(delimiter).filter(Boolean).map(dir => join(dir, process.platform === 'win32' ? 'node.exe' : 'node'));
  for (const candidate of candidates) {
    try {
      if (!isAbsolute(candidate) || /\.(cmd|bat)$/i.test(extname(candidate))) throw new Error('Node must be an absolute executable');
      await access(candidate, constants.X_OK);
      const physical = await realpath(candidate);
      const info = await probe(physical);
      return { ...info, executable: await realpath(info.executable) };
    } catch (error) { if (executable) throw error; }
  }
  throw new Error('No compatible installed Node executable found');
}
