import assert from 'node:assert/strict';
import test from 'node:test';
import {installModuleLoader} from '../../src/runtime/browser.mjs';

test('the renderer sees shared and plugin stylesheet metadata with the original module identities', t => {
  globalThis.window = {};
  t.after(() => { delete globalThis.window; });
  const react = {}, shared = {}, meta = () => ({stylesheets: {}});
  let builds = 0;
  const modules = {react, ui: {__$dsh_client_module_manifest: {
    id: 'ui', meta, factory(require) { builds++; assert.equal(require('react'), react); return shared; },
  }}};
  const loader = installModuleLoader(modules, [{id:'first'}, {id:'second'}]);
  const seen = [];
  const off = loader.subscribeModules(() => seen.push(Array.from(loader.activeRecords(), record => record.id)));
  function register(id) {
    window.__ModuleLoader__.load({id, meta, factory(require) { assert.equal(require('ui'), shared); return {}; }});
  }
  register('first');
  off();
  register('second');
  assert.deepEqual(seen, [['ui'], ['ui','first']]);
  const records = Array.from(loader.activeRecords());
  assert.deepEqual(records.map(row => [row.id, row.ownerId, [...row.edges]]), [
    ['ui','ui',['react']], ['first','first',['ui']], ['second','second',['ui']],
  ]);
  assert.ok(records.every(row => row.meta === meta));
  assert.equal(builds, 1);
});
