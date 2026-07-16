(function initSnaxTheme(global) {
  "use strict";

  const STORAGE_KEY = "snax.theme.v1";
  const DEFAULT_THEME = "default";
  const THEMES = Object.freeze({
    default: Object.freeze({
      id: "default",
      label: "default",
      themeColor: "#fffdf7",
    }),
    basquiat: Object.freeze({
      id: "basquiat",
      label: "basquiat",
      themeColor: "#f2eee4",
    }),
  });

  function normalizeTheme(value) {
    return Object.prototype.hasOwnProperty.call(THEMES, value) ? value : DEFAULT_THEME;
  }

  function readStoredTheme() {
    try {
      return normalizeTheme(global.localStorage.getItem(STORAGE_KEY));
    } catch {
      return DEFAULT_THEME;
    }
  }

  function writeStoredTheme(theme) {
    try {
      global.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // The active theme still works when storage is unavailable.
    }
  }

  function syncThemeControls(theme) {
    global.document.querySelectorAll("[data-theme-option]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.themeOption === theme));
    });
  }

  function applyTheme(value, options = {}) {
    const theme = normalizeTheme(value);
    const definition = THEMES[theme];
    global.document.documentElement.dataset.theme = theme;
    global.document.documentElement.style.colorScheme = "light";
    global.document.querySelector('meta[name="theme-color"]')?.setAttribute("content", definition.themeColor);
    syncThemeControls(theme);

    if (options.persist !== false) {
      writeStoredTheme(theme);
    }

    global.document.dispatchEvent(
      new CustomEvent("snax:themechange", {
        detail: { theme },
      }),
    );

    return theme;
  }

  global.SNAX_THEME = Object.freeze({
    themes: THEMES,
    current() {
      return normalizeTheme(global.document.documentElement.dataset.theme);
    },
    apply: applyTheme,
    syncControls() {
      syncThemeControls(this.current());
    },
  });

  applyTheme(readStoredTheme(), { persist: false });
})(globalThis);
