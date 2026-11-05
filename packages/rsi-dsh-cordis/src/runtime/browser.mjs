/** Original bundles execute as scripts; their factories resolve only the frozen host table. */
export function installModuleLoader(modules, approved) {
  if (window.__ModuleLoader__) throw new Error('browser cohort already installed; restart the application');
  const table = new Map(Object.entries(modules));
  const expected = new Map(approved.map(entry => [entry.id, entry]));
  const loaded = new Map();
  const require = id => { if (!table.has(id)) throw new Error(`unresolved browser singleton: ${id}`); return table.get(id); };
  window.__ModuleLoader__ = Object.freeze({ load({ id, factory }) {
    if (!expected.has(id) || loaded.has(id) || typeof factory !== 'function') throw new Error('unapproved or duplicate browser bundle');
    const plugin = factory(require);
    loaded.set(id, plugin);
  } });
  return Object.freeze({ async load(id, signal) {
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
    return loaded.get(id);
  } });
}
