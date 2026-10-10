/** The phone's safe-area insets in px (notch, home indicator): the `--safe-*` variables of app/globals.css. */
export type Insets = { top: number; right: number; bottom: number; left: number };

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

let probe: HTMLDivElement | null = null;

/**
 * The current safe-area insets, read through a hidden probe padded by the `--safe-*` variables (a custom property's
 * own value is the unresolved `env(...)` text, so it has to be applied to something to be measured). Zero outside a
 * browser and on screens without insets.
 */
export function safeAreaInsets(): Insets {
  if (typeof document === "undefined" || !document.body) return NO_INSETS;
  if (!probe || !probe.isConnected) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding:var(--safe-top,0px) var(--safe-right,0px) var(--safe-bottom,0px) var(--safe-left,0px)";
    document.body.appendChild(probe);
  }
  const style = getComputedStyle(probe);
  const px = (v: string) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  return { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
}
