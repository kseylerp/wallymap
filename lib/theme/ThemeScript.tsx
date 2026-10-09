"use client";

import { THEME_INIT_SCRIPT } from "@/lib/theme/initScript";

/**
 * Applies the stored theme in <head> before first paint. On the server the script is executable; on the client it
 * renders as text/plain, so React does not warn about rendering a script, and suppressHydrationWarning accepts the
 * type difference (see Next's "Preventing flash before hydration" guide).
 */
export function ThemeScript() {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
    />
  );
}
