"use client";

import Image from "next/image";
import { useTheme } from "@/lib/theme/useTheme";

/** wally-logo.png is 892px square with transparent padding; the mark itself spans this box. */
const LOGO = { size: 892, x: 83, y: 49, w: 758, h: 663 } as const;

/**
 * The Wally logo (public/brand/wally-logo.png: the dark rounded-triangle mark with a cream rim), cropped to the
 * mark and centered in a `size` square. The cream rim keeps it legible on dark surfaces too.
 */
export function WallyMark({ size = 24, className }: { size?: number; className?: string }) {
  const k = size / LOGO.w;
  const rendered = Math.round(LOGO.size * k);
  return (
    <span
      data-testid="wally-mark"
      className={["relative block shrink-0 overflow-hidden", className].filter(Boolean).join(" ")}
      style={{ width: size, height: size }}
    >
      <Image
        src="/brand/wally-logo.png"
        alt="Wally"
        width={rendered}
        height={rendered}
        className="absolute max-w-none"
        style={{ left: -LOGO.x * k, top: -LOGO.y * k + (size - LOGO.h * k) / 2 }}
      />
    </span>
  );
}

type WordmarkProps = {
  /** "pill" floats over the map (with the theme toggle); "hero" is the large mark on the empty-state card. */
  variant?: "pill" | "hero";
};

/** The logo plus "WallyMap" in the serif heading face. */
export function Wordmark({ variant = "pill" }: WordmarkProps) {
  if (variant === "hero") {
    return (
      <div className="flex items-center gap-3">
        <WallyMark size={40} />
        <span className="font-serif text-[2.1rem] leading-none font-semibold tracking-[-0.02em] text-ink">WallyMap</span>
      </div>
    );
  }
  return (
    <div className="glass-strong flex h-10 items-center gap-2 rounded-pill pr-1 pl-2">
      <WallyMark size={24} />
      <h1 className="sr-only font-serif text-[1.15rem] leading-none font-semibold tracking-[-0.01em] text-ink md:not-sr-only">
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
