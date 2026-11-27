import { createHash } from 'node:crypto';
import { lstat, opendir, open } from 'node:fs/promises';
import { join } from 'node:path';

export const maximumBytes = 4 * 1024 ** 3;
export const maximumEntries = 65536;

// Bounds also cover empty directories and the temporary per-directory sort.
export async function walkFiles(root, visit, { exclude = () => false, signal } = {}) {
  let entries = 0, bytes = 0;
  async function walk(prefix, depth) {
    const paths = [];
    for await (const dirent of await opendir(join(root, prefix))) {
      signal?.throwIfAborted();
      if (++entries > maximumEntries) throw new Error('Tree entry capacity');
      const path = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (!exclude(path, dirent)) paths.push(path);
    }
    for (const path of paths.sort()) {
      if (depth > 128 || Buffer.byteLength(path) > 1024) throw new Error('Tree path capacity');
      const stat = await lstat(join(root, path));
      if (stat.isSymbolicLink()) throw new Error(`Tree refuses link: ${path}`);
      if (stat.isDirectory()) await walk(path, depth + 1);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > maximumBytes) throw new Error('Tree file capacity');
        await visit(path, stat.size, process.platform !== 'win32' && (stat.mode & 0o111) !== 0);
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
