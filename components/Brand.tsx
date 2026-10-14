import Image from "next/image";

/** wally-logo-light.png is 125px square with transparent padding; the mark itself spans this box. */
const LOGO = { size: 125, x: 6, y: 9, w: 114, h: 100 } as const;

/**
 * The Wally logo (public/brand/wally-logo-light.png: a white rounded triangle with a grey W), cropped to the mark
 * and centered in a `size` square.
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
        src="/brand/wally-logo-light.png"
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
  /** "pill" floats over the map; "hero" is the large mark on the empty-state card. */
  variant?: "pill" | "hero";
};

/** The logo plus "WallyMap" in the serif heading face. */
export function Wordmark({ variant = "pill" }: WordmarkProps) {
  if (variant === "hero") {
    return (
      <div className="flex items-center gap-3">
        <WallyMark size={40} />
        <span className="font-serif text-[2.1rem] leading-none font-semibold tracking-[-0.04em] text-ink">WallyMap</span>
      </div>
    );
  }
  return (
    <div className="glass-strong flex h-10 items-center gap-2 rounded-pill px-2 md:pr-4">
      <WallyMark size={24} />
      <h1 className="sr-only font-serif text-[1.15rem] leading-none font-semibold tracking-[-0.03em] text-ink md:not-sr-only">
        WallyMap
      </h1>
    </div>
  );
}
