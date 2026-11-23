// Generated from DeepSeek Harness 4b399c39a6d1479cd84ca591b4d7c88e24d38a96. See LICENSE.

// packages/client/ui-renderer/src/client/styles/document-styles.ts
var styleKey = (owner, path) => `${owner}\0${path}`;
var NO_STYLES = /* @__PURE__ */ new Map();
var DocumentStyles = class {
  /** @param container - Style destination. @param modules - This renderer's module service. */
  constructor(container, modules) {
    this.container = container;
    this.modules = modules;
  }
  container;
  modules;
  records = /* @__PURE__ */ new Map();
  produced = /* @__PURE__ */ new WeakMap();
  /** Stylesheets, by {@link styleKey}, whose current conflict has been reported. */
  conflicts = /* @__PURE__ */ new Set();
  unsubscribe;
  mounted = false;
  disposed = false;
  /** Subscribe and synchronously install module styles; each instance can mount only once. */
  mount() {
    if (this.disposed) throw new Error("renderer: document styles are disposed");
    if (this.mounted) throw new Error("renderer: document styles are already mounted");
    this.mounted = true;
    try {
      this.unsubscribe = this.modules.subscribeModules(() => {
        if (!this.disposed) this.refresh();
      });
      this.refresh();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  /** Unsubscribe and remove all installed resources. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.unsubscribe?.();
    } finally {
      for (const record of this.records.values()) record.element.remove();
      this.records.clear();
    }
  }
  /** Produce one record's stylesheet text once, containing each producer failure to its own stylesheet. */
  stylesOf(record) {
    if (record.meta === void 0) return NO_STYLES;
    const cached = this.produced.get(record);
    if (cached !== void 0) return cached;
    const styles = /* @__PURE__ */ new Map();
    this.produced.set(record, styles);
    let stylesheets;
    try {
      stylesheets = record.meta().stylesheets ?? {};
    } catch (error) {
      console.error(`module styles: metadata of ${JSON.stringify(record.id)} failed; its styles are not installed`, error);
      return styles;
    }
    for (const [path, descriptor] of Object.entries(stylesheets)) {
      try {
        styles.set(path, descriptor.text({ asset: (reference) => this.modules.resolveAsset(reference) }));
      } catch (error) {
        console.error(`module styles: ${JSON.stringify(path)} of ${JSON.stringify(record.id)} failed and is not installed`, error);
      }
    }
    return styles;
  }
  collectStyles() {
    const byId = /* @__PURE__ */ new Map();
    const groups = /* @__PURE__ */ new Map();
    for (const record of this.modules.activeRecords()) {
      if (!byId.has(record.id)) byId.set(record.id, record);
      const group = groups.get(record.ownerId);
      if (group === void 0) groups.set(record.ownerId, [record]);
      else if (record.id === record.ownerId) group.unshift(record);
      else group.push(record);
    }
    const requested = /* @__PURE__ */ new Map();
    const providers = /* @__PURE__ */ new Map();
    const conflicting = /* @__PURE__ */ new Set();
    const visited = /* @__PURE__ */ new Set();
    const visit = (ownerId) => {
      if (visited.has(ownerId)) return;
      visited.add(ownerId);
      const records = groups.get(ownerId) ?? [];
      for (const record of records) {
        for (const specifier of record.edges) {
          if (specifier.startsWith("./")) continue;
          const dependency = byId.get(specifier) ?? byId.get(specifier.replace(/\/client$/, ""));
          if (dependency !== void 0) visit(dependency.ownerId);
        }
      }
      for (const record of records) {
        for (const [path, css] of this.stylesOf(record)) {
          const key = styleKey(record.ownerId, path);
          const previous = requested.get(key);
          if (previous === void 0) {
            requested.set(key, { owner: record.ownerId, path, css });
            providers.set(key, record.id);
            continue;
          }
          if (previous.css === css) continue;
          conflicting.add(key);
          let rejected = record.id;
          if (this.records.get(key)?.css === css) {
            rejected = providers.get(key) ?? rejected;
            previous.css = css;
            providers.set(key, record.id);
          }
          if (!this.conflicts.has(key)) {
            this.conflicts.add(key);
            console.error(`module styles: ${JSON.stringify(path)} of ${JSON.stringify(rejected)} is not installed; another module of ${JSON.stringify(record.ownerId)} provides different CSS for the same path`);
          }
        }
      }
    };
    for (const ownerId of [...groups.keys()].sort()) visit(ownerId);
    for (const key of this.conflicts) if (!conflicting.has(key)) this.conflicts.delete(key);
    return requested;
  }
  refresh() {
    const requested = this.collectStyles();
    for (const [key, record] of this.records) {
      if (requested.has(key)) continue;
      record.element.remove();
      this.records.delete(key);
    }
    const elements = [];
    for (const [key, { owner, path, css }] of requested) {
      let record = this.records.get(key);
      if (record === void 0) {
        const element = this.container.ownerDocument.createElement("style");
        element.setAttribute("data-plugin", owner);
        element.setAttribute("data-path", path);
        element.textContent = css;
        record = { element, css };
        this.records.set(key, record);
      } else if (record.css !== css) {
        record.element.textContent = css;
        record.css = css;
      }
      elements.push(record.element);
    }
    const owned = new Set(elements);
    const ordered = [...this.container.childNodes].filter((node) => owned.has(node));
    for (const [index, element] of elements.entries()) {
      if (ordered[index] === element) continue;
      const anchor = ordered[index] ?? ordered.at(-1)?.nextSibling ?? null;
      this.container.insertBefore(element, anchor);
      const previous = ordered.indexOf(element);
      if (previous !== -1) ordered.splice(previous, 1);
      ordered.splice(index, 0, element);
    }
  }
};
export {
  DocumentStyles
};
