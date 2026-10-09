/**
 * Wally's 3×3 dot spinner: nine 3px dots; the eight outer dots light one after another clockwise, one step every
 * 150 ms (`.dot-spinner` in globals.css), while the center holds at half strength. Inherits `currentColor`.
 */
const ORDER = [0, 1, 2, 7, -1, 3, 6, 5, 4] as const;

export function DotSpinner({ label, className }: { label?: string; className?: string }) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-testid="dot-spinner"
      className={["dot-spinner", className].filter(Boolean).join(" ")}
    >
      {ORDER.map((step, i) => (
        <span
          key={i}
          className={step === -1 ? "dot-spinner-center" : undefined}
          style={step === -1 ? undefined : { animationDelay: `${step * 150}ms` }}
        />
      ))}
    </span>
  );
}
