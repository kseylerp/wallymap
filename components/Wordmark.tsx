type WordmarkProps = {
  /** "pill" floats over the map; "hero" is the large mark on the empty-state card. */
  variant?: "pill" | "hero";
};

/** An ink disc with a white ridge line: the WildMap pin. */
export function WildMapMark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="shrink-0">
      <circle cx="12" cy="12" r="12" className="fill-ink" />
      <path
        d="M5 16.25 9.5 9.5l2.6 3.7 1.9-2.45 5 5.5"
        fill="none"
        className="stroke-paper"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({ variant = "pill" }: WordmarkProps) {
  if (variant === "hero") {
    return (
      <div className="flex items-center gap-3">
        <WildMapMark size={34} />
        <span className="font-serif text-[2.1rem] leading-none font-semibold tracking-[-0.02em] text-ink">WildMap</span>
      </div>
    );
  }
  return (
    <div className="glass-strong flex h-10 items-center gap-2 rounded-pill px-2 md:pr-4">
      <WildMapMark />
      <h1 className="sr-only font-serif text-[1.15rem] leading-none font-semibold tracking-[-0.01em] text-ink md:not-sr-only">
        WildMap
      </h1>
    </div>
  );
}
