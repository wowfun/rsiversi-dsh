/** Original bundles execute as scripts; their factories resolve only the frozen host table. */
export function installModuleLoader(modules, approved) {
  if (window.__ModuleLoader__) throw new Error('browser cohort already installed; restart the application');
  const table = new Map(Object.entries(modules));
  const expected = new Map(approved.map(entry => [entry.id, entry]));
  const loaded = new Map();
  const listeners = new Set();
  const resolveAsset = reference => reference;
  function materialize({id, factory, meta}) {
    const edges = new Set();
    const require = name => {
      if (!table.has(name)) throw new Error(`unresolved browser singleton: ${name}`);
      edges.add(name);
      const singleton = table.get(name);
      const manifest = singleton.__$dsh_client_module_manifest;
      return manifest ? (loaded.get(name) ?? materialize(manifest)).exports : singleton;
    };
    require.asset = resolveAsset;
    const record = {id, ownerId: id, exports: factory(require), meta, edges};
    loaded.set(id, record);
    for (const listener of listeners) listener();
    return record;
  }
  window.__ModuleLoader__ = Object.freeze({ load(registration) {
    if (!expected.has(registration.id) || loaded.has(registration.id) || typeof registration.factory !== 'function')
      throw new Error('unapproved or duplicate browser bundle');
    materialize(registration);
  } });
  async function load(id, signal) {
    const entry = expected.get(id);
    if (!entry || loaded.has(id)) throw new Error('unapproved or duplicate browser load');
    const url = new URL(entry.url, location.href);
    if (url.origin !== location.origin) throw new Error('browser bundles must be same-origin');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const abort = () => { script.remove(); reject(signal.reason); };
      signal?.throwIfAborted();
      script.src = url.href; script.integrity = entry.integrity; script.crossOrigin = 'anonymous';
      script.onload = () => { signal?.removeEventListener('abort', abort); resolve(); };
      script.onerror = () => { signal?.removeEventListener('abort', abort); script.remove(); reject(new Error(`bundle load failed: ${id}`)); };
      signal?.addEventListener('abort', abort, { once: true });
      document.head.append(script);
    });
    if (!loaded.has(id)) throw new Error(`bundle did not register: ${id}`);
    return loaded.get(id).exports;
  }
  return Object.freeze({
    load, resolveAsset, activeRecords: () => loaded.values(),
    subscribeModules(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
}
