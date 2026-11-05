import test from 'node:test';
import assert from 'node:assert/strict';
import { JournalWindow } from '../../src/browser/journal.mjs';

test('bounded tail and backward pages retain their captured segment cut', async () => {
  const segments = Array.from({length: 20}, (_, first) => ({first, count: 1, sha256: String(first)}));
  const calls = [];
  const journal = new JournalWindow(async request => {
    calls.push(request.id);
    const value = request.id === 'head' ? {segments} : [{seq: Number(request.id), type: 'recorded'}];
    return {session_id: 'session', request, value: {kind: 'read', text: JSON.stringify(value)}};
  }, 'session');
  const head = await journal.head();
  const page = await journal.page(head);
  assert.deepEqual(page.entries.map(event => event.seq), Array.from({length:16}, (_, n) => n + 4));
  assert.equal(page.hasMore, true);
  assert.equal(calls.length, 17);
  assert.deepEqual((await journal.page(head, 4, 1)).entries, [{seq:3, type:'recorded'}]);
  assert.equal((await journal.page(head, 1, 1)).hasMore, false);
});

test('retirement and wrong Session replies cannot publish journal bytes', async () => {
  let finish;
  const journal = new JournalWindow(request => new Promise(resolve => { finish = value => resolve({session_id:'session', request, value:{kind:'read', text:JSON.stringify(value)}}); }), 'session');
  const pending = journal.head();
  journal.close(); finish({segments:[]});
  await assert.rejects(pending, /does not belong/);
  const wrong = new JournalWindow(async request => ({session_id:'other', request, value:{kind:'read', text:'{}'}}), 'session');
  await assert.rejects(wrong.head(), /does not belong/);
});
