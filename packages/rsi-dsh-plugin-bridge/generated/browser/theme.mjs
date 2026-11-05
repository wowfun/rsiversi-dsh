// Generated from DeepSeek Harness fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159. See LICENSE.

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
  /** Create the presenter-owned metadata node before the first snapshot arrives. */
  constructor() {
    this.themeColorMeta = document.createElement("meta");
    this.themeColorMeta.name = "theme-color";
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
    this.themeColorMeta.content = getComputedStyle(body).backgroundColor;
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta);
  }
  /**
   * Retract root color-scheme, the theme-source attribute, the palette
   * attribute, token variables, the font sizes, font lists, and the owned metadata node.
   */
  dispose() {
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
