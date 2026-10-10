import { ChevronRight } from "lucide-react";

export const EXAMPLE_QUESTIONS = [
  "Show hiking trails around Lake Tahoe",
  "Which wildfires burned near Yosemite in the last 10 years?",
  "Where has the Amazon lost the most forest since 2015?",
  "How much snow is on the ground around Mount Hood?",
  "Find campsites and forest roads open to vehicles near Moab",
  "What wildlife has been spotted around Banff this year?",
] as const;

type EmptyStateProps = { onPick: (question: string) => void; onClose?: () => void };

/** The hairline ×, as in the data console: a 16px glyph whose invisible ::after reaches 6px past it, so the hit area is 28px. */
const CLOSE_BUTTON =
  "absolute top-3 right-3 grid size-4 place-items-center text-[16px] leading-none text-ink-muted transition-colors duration-150 hover:text-ink after:absolute after:-inset-1.5 after:content-[''] md:top-5 md:right-5";

/** The welcome card centered over the globe; picking a question sends it and the chat panel takes over. */
export function EmptyState({ onPick, onClose }: EmptyStateProps) {
  return (
    <div
      data-testid="empty-state"
      className="glass-strong rise-in pointer-events-auto relative w-full max-w-[600px] rounded-large p-5 md:p-7"
      style={{ animationDelay: "120ms" }}
    >
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Close suggestions" title="Close suggestions" className={CLOSE_BUTTON}>
          ×
        </button>
      )}
      {/* Text only: the logo lives in the corner map pill. */}
      <h2 className="font-serif text-[20px] leading-tight font-medium tracking-normal text-ink">WallyMap</h2>
      <p className="mt-2 text-[14px] leading-snug text-ink-muted">
        Ask the map. Every answer is drawn, cited, and exportable.
      </p>
      <ul className="mt-4 grid grid-cols-1 gap-1.5 sm:mt-5 sm:grid-cols-2 sm:gap-2">
        {EXAMPLE_QUESTIONS.map((q, i) => (
          <li key={q} className="rise-in" style={{ animationDelay: `${220 + i * 50}ms` }}>
            <button
              type="button"
              onClick={() => onPick(q)}
              className="group press flex h-full min-h-11 w-full items-center gap-2 rounded-[16px] border border-line bg-paper px-4 py-2 text-left text-[15px] leading-snug text-ink transition duration-150 ease-out hover:border-ink/20 hover:bg-mist sm:py-2.5"
            >
              <span className="flex-1">{q}</span>
              <ChevronRight
                aria-hidden
                size={16}
                strokeWidth={2}
                className="shrink-0 text-ink-muted opacity-0 transition duration-200 group-hover:translate-x-0.5 group-hover:opacity-100"
              />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
