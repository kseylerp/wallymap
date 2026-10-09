"use client";

import { useTheme } from "@/lib/theme/useTheme";

/** The rounded mountain, 64-unit grid (matches public/brand/wally-mark.svg). */
const MOUNTAIN = "M28.91 13.15Q32 8 35.09 13.15L56.43 48.71Q59 53 54 53L10 53Q5 53 7.57 48.71Z";
/** The heavy W cut through it; its feet sit on the mountain's base. */
const W = "M9.02 21L19.69 53L21.55 53L32 36.09L42.45 53L44.31 53L54.98 21L46.02 21L41.34 35.04L32 19.91L22.66 35.04L17.98 21Z";

/**
 * The Wally mark. Colors come from tokens: in light it is the app icon (white mountain, charcoal outline and W);
 * in dark it is the logo (dark mountain and W with cream outlines). Reads at 20px.
 */
export function WallyMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      data-testid="wally-mark"
      viewBox="0 -1.5 64 64"
      width={size}
      height={size}
      aria-hidden
      className={["shrink-0", className].filter(Boolean).join(" ")}
    >
      <path
        d={MOUNTAIN}
        strokeWidth={3.4}
        strokeLinejoin="round"
        style={{ fill: "var(--mark-fill)", stroke: "var(--mark-line)" }}
      />
      <path
        d={W}
        strokeLinejoin="round"
        style={{ fill: "var(--mark-w)", stroke: "var(--mark-line)", strokeWidth: "var(--mark-w-stroke)" }}
      />
    </svg>
  );
}

type WordmarkProps = {
  /** "pill" floats over the map (with the theme toggle); "hero" is the large mark on the empty-state card. */
  variant?: "pill" | "hero";
};

/** The mark plus "WallyMap" in the title face. */
export function Wordmark({ variant = "pill" }: WordmarkProps) {
  if (variant === "hero") {
    return (
      <div className="flex items-center gap-3">
        <WallyMark size={44} />
        <span className="text-[2rem] leading-none font-bold tracking-[-0.025em] text-ink">WallyMap</span>
      </div>
    );
  }
  return (
    <div className="glass-strong flex h-10 items-center gap-2 rounded-pill pr-1 pl-2.5">
      <WallyMark size={24} />
      <h1 className="sr-only text-[17px] leading-none font-bold tracking-[-0.015em] text-ink md:not-sr-only">
        WallyMap
      </h1>
      <ThemeToggle />
    </div>
  );
}

/** Sun/moon button (Lucide geometry, 24 grid). Shows the theme you would switch to. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button
      type="button"
      data-testid="theme-toggle"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={[
        "press flex size-8 items-center justify-center rounded-pill text-ink-muted transition duration-150 ease-out hover:bg-mist hover:text-ink md:ml-1",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <svg
        viewBox="0 0 24 24"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {dark ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
          </>
        ) : (
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        )}
      </svg>
    </button>
  );
}
