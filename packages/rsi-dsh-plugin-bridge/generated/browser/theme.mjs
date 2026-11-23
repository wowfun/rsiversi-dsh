// Generated from DeepSeek Harness 4b399c39a6d1479cd84ca591b4d7c88e24d38a96. See LICENSE.

// packages/client/ui-layout/src/client/theme-presenter.ts
var DARK_ATTRIBUTE = "data-ds-dark-theme";
var THEME_SOURCE_ATTRIBUTE = "data-ds-theme-source";
var CONTENT_FONT_SIZE_VARIABLE = "--dsh-content-font-size";
var FONT_SIZE_VARIABLES = {
  text: CONTENT_FONT_SIZE_VARIABLE,
  code: "--dsh-code-font-size",
  terminal: "--dsh-terminal-font-size"
};
var FONT_FAMILY_VARIABLES = {
  text: "--dsh-font-family-text",
  code: "--dsh-font-family-code",
  terminal: "--dsh-font-family-terminal"
};
var ThemePresenter = class {
  /** Token names this presenter wrote in the last apply (its retraction set). */
  appliedTokens = [];
  /** The single metadata node this presenter inserts and removes. */
  themeColorMeta;
  styleObserver;
  /** Create the presenter-owned metadata node before the first snapshot arrives. */
  constructor() {
    this.themeColorMeta = document.createElement("meta");
    this.themeColorMeta.name = "theme-color";
  }
  /** Observe stylesheet installation and replacement after theme initialization. */
  start() {
    if (this.styleObserver !== void 0) return;
    this.styleObserver = new MutationObserver((changes) => {
      const isStyle = (node) => node.nodeName === "STYLE";
      if (changes.some((change) => isStyle(change.target) || change.target.parentNode?.nodeName === "STYLE" || [...change.addedNodes, ...change.removedNodes].some(isStyle))) this.refreshThemeColor();
    });
    this.styleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  }
  /**
   * Project a snapshot onto the document: set root `color-scheme` and the body
   * palette attribute from `active.colorScheme` (never the id — `system` is
   * resolved upstream), publish the font sizes and font lists, then replace the
   * previously applied token variables with `active.tokens`. Browser
   * theme-color metadata follows the computed body background after those
   * writes, so the rendered palette remains the color authority.
   * @param snapshot - resolved theme snapshot from ctx.theme.
   */
  apply(snapshot) {
    const scheme = snapshot.active.colorScheme;
    document.documentElement.style.colorScheme = scheme;
    document.documentElement.setAttribute(
      THEME_SOURCE_ATTRIBUTE,
      snapshot.preference === "system" ? "system" : scheme
    );
    const body = document.body;
    if (scheme === "dark") body.setAttribute(DARK_ATTRIBUTE, "");
    else body.removeAttribute(DARK_ATTRIBUTE);
    for (const [role, name] of Object.entries(FONT_SIZE_VARIABLES)) {
      body.style.setProperty(name, `${snapshot.fontSizes[role]}px`);
    }
    for (const [kind, name] of Object.entries(FONT_FAMILY_VARIABLES)) {
      const list = snapshot.fontFamilies[kind];
      if (list === "") body.style.removeProperty(name);
      else body.style.setProperty(name, list);
    }
    for (const name of this.appliedTokens) body.style.removeProperty(name);
    this.appliedTokens = [];
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value);
      this.appliedTokens.push(name);
    }
    this.refreshThemeColor();
  }
  refreshThemeColor() {
    this.themeColorMeta.content = getComputedStyle(document.body).backgroundColor;
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta);
  }
  /**
   * Retract root color-scheme, the theme-source attribute, the palette
   * attribute, token variables, the font sizes, font lists, and the owned metadata node.
   */
  dispose() {
    this.styleObserver?.disconnect();
    this.styleObserver = void 0;
    document.documentElement.style.removeProperty("color-scheme");
    document.documentElement.removeAttribute(THEME_SOURCE_ATTRIBUTE);
    const body = document.body;
    body.removeAttribute(DARK_ATTRIBUTE);
    for (const name of Object.values(FONT_SIZE_VARIABLES)) body.style.removeProperty(name);
    for (const name of Object.values(FONT_FAMILY_VARIABLES)) body.style.removeProperty(name);
    for (const name of this.appliedTokens) body.style.removeProperty(name);
    this.appliedTokens = [];
    this.themeColorMeta.remove();
  }
};
export {
  ThemePresenter
};
