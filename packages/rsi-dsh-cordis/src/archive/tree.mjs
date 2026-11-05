import { createHash } from 'node:crypto';
import { lstat, opendir, open } from 'node:fs/promises';
import { join } from 'node:path';

const maximumBytes = 4 * 1024 ** 3;

// Bounds also cover empty directories and the temporary per-directory sort.
export async function walkFiles(root, visit, { exclude = () => false, signal } = {}) {
  let entries = 0, files = 0, bytes = 0;
  async function walk(prefix, depth) {
    const names = [];
    for await (const dirent of await opendir(join(root, prefix))) {
      signal?.throwIfAborted();
      if (++entries > 65536) throw new Error('Tree entry capacity');
      names.push(dirent.name);
    }
    for (const name of names.sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (exclude(path)) continue;
      if (depth > 128 || Buffer.byteLength(path) > 1024) throw new Error('Tree path capacity');
      const stat = await lstat(join(root, path));
      if (stat.isSymbolicLink()) throw new Error(`Tree refuses link: ${path}`);
      if (stat.isDirectory()) await walk(path, depth + 1);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (++files > 16384 || bytes > maximumBytes) throw new Error('Tree file capacity');
        await visit(path, stat.size);
      } else throw new Error('Tree refuses special file');
    }
  }
  await walk('', 1);
}

// A short or growing file cannot exceed its admitted size during either pass.
export async function readDigest(path, size, write, signal) {
  const file = await open(path, 'r'), hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(65536, size + 1));
  let used = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const {bytesRead} = await file.read(buffer, 0, buffer.length);
      if (!bytesRead) break;
      if ((used += bytesRead) > size) throw new Error('Tree file grew while reading');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk); if (write) await write(chunk);
    }
    if (used !== size) throw new Error('Tree file shrank while reading');
    return hash.digest('hex');
  } finally { await file.close(); }
}
