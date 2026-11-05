import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkRequirements } from '../../src/registry/import.mjs';
import { walkFiles, readDigest } from '../../src/archive/tree.mjs';

test('DSH engine overrides peers; supported workspace peers bind the exact prerelease', () => {
  const version = '0.2.2-alpha.2';
  const semver = {satisfies(runtime, range, options) {
    assert.equal(runtime, version); assert.equal(options.includePrerelease, true);
    return range === version;
  }};
  const peers = {'@deepseek-ai/dsh': 'unmet', '@deepseek-ai/dsh-agent': 'workspace:^'};
  assert.doesNotThrow(() => checkRequirements({engines:{dsh:version}, peerDependencies:peers}, version, semver));
  assert.throws(() => checkRequirements({engines:{dsh:''}, peerDependencies:peers}, version, semver), /engines.dsh/);
  assert.throws(() => checkRequirements({peerDependencies:peers}, version, semver), /Incompatible @deepseek-ai\/dsh/);
  assert.doesNotThrow(() => checkRequirements({peerDependencies:{'@deepseek-ai/dsh-agent':'workspace:~'}}, version, semver));
});

test('tree admission refuses oversized files before reading; a changed admitted length cannot be copied', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tree-test-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const path = join(root, 'file'); await writeFile(path, 'initial');
  await assert.rejects(readDigest(path, 3), /grew/);
  await assert.rejects(readDigest(path, 12), /shrank/);
  await truncate(path, 4 * 1024 ** 3 + 1);
  await assert.rejects(walkFiles(root, () => assert.fail('oversized file was visited')), /capacity/);
});
