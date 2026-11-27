import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { walkFiles, readDigest, maximumEntries } from './tree.mjs';
import { join } from 'node:path';

export const maximumHeaderBytes = 16 * 1024 ** 2;

/** Emit only regular files. Rust repeats path/type/digest checks before publication. */
export async function writePayload(root, destination, { prefix: archivePrefix = '', exclude = () => false, signal } = {}) {
  const files = [];
  await walkFiles(root, async (source, bytes, executable) => {
    files.push({ path: archivePrefix ? `${archivePrefix}/${source}` : source, source:join(root, source), bytes, executable });
  }, {exclude, signal});
  return writePayloadFiles(files, destination, signal);
}

/** Pack already enumerated regular files from distinct npm package roots. */
export async function writePayloadFiles(entries, destination, signal) {
  if (!entries.length || entries.length > maximumEntries) throw new Error('Payload file capacity');
  const files = [];
  for (const {source, path, bytes, executable = false} of entries) {
    const digest = await readDigest(source, bytes, undefined, signal);
    files.push({source, path, bytes, digest, executable});
  }
  const header = Buffer.from(JSON.stringify({ format: 1, files: files.map(({ source, ...record }) => record) }));
  if (header.length > maximumHeaderBytes) throw new Error('payload header capacity');
  const prefix = Buffer.alloc(12); prefix.write('RSITREE1'); prefix.writeUInt32LE(header.length, 8);
  const output = await open(destination, 'wx');
  const digest = createHash('sha256'); let bytes = 0;
  async function write(buffer) {
    let offset = 0;
    while (offset < buffer.length) {
      const result = await output.write(buffer, offset, buffer.length - offset);
      if (!result.bytesWritten) throw new Error('payload write made no progress');
      offset += result.bytesWritten;
    }
    digest.update(buffer); bytes += buffer.length;
  }
  try {
    await write(prefix); await write(header);
    for (const file of files) {
      if (await readDigest(file.source, file.bytes, write, signal) !== file.digest)
        throw new Error('source changed while packaging');
    }
    await output.sync();
  } finally { await output.close(); }
  return { files: files.length, bytes, digest: digest.digest('hex'),
    indexDigest: createHash('sha256').update(prefix).update(header).digest('hex') };
}
