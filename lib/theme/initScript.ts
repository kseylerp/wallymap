// Server-safe (no React): app/layout.tsx inlines this script; lib/theme/useTheme.ts shares the key.

export const THEME_STORAGE_KEY = "wallymap-theme";

/**
 * Runs in <head> before first paint so a stored dark preference never flashes light.
 * Storage can throw (private mode, blocked site data); the page then stays light.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");document.documentElement.setAttribute("data-theme",t==="dark"?"dark":"light")}catch(e){}})()`;
