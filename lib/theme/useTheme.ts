import { useEffect, useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY } from "@/lib/theme/initScript";

export { THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "@/lib/theme/initScript";

/** Light is the default; dark is Wally's dark token set, switched by `data-theme` on <html>. */
export type Theme = "light" | "dark";

const listeners = new Set<() => void>();

function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

/** Keep the browser chrome (mobile address bar) on the scaffold color of the active theme. */
function syncThemeColor() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const paper = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim();
  if (meta && paper) meta.content = paper;
}

/** Apply and remember a theme; every `useTheme()` re-renders. */
export function setTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The active theme and a toggle. The server always renders light; the client reads <html data-theme>. */
export function useTheme() {
  const theme = useSyncExternalStore<Theme>(subscribe, currentTheme, () => "light");

  // The init script normally sets data-theme before paint; this covers pages rendered without it (tests).
  useEffect(() => {
    if (!document.documentElement.dataset.theme) {
      applyTheme(readStoredTheme());
      listeners.forEach((listener) => listener());
    }
  }, []);

  useEffect(syncThemeColor, [theme]);

  return { theme, setTheme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") };
}
