import { ChevronRight } from "lucide-react";
import { FIRST_VISIT } from "@/lib/suggestions";

/** The six starter questions a first-time visitor sees. */
export const EXAMPLE_QUESTIONS = FIRST_VISIT;

type EmptyStateProps = {
  onPick: (question: string) => void;
  onClose?: () => void;
  /** The questions to show; the six starters when unset. */
  questions?: readonly string[];
  /** Shows a "More" link that swaps in a fresh set. */
  onMore?: () => void;
};

/** The hairline ×, as in the data console: a 16px glyph whose invisible ::after reaches 6px past it, so the hit area is 28px. */
const CLOSE_BUTTON =
  "absolute top-3 right-3 grid size-4 place-items-center text-[16px] leading-none text-ink-muted transition-colors duration-150 hover:text-ink after:absolute after:-inset-1.5 after:content-[''] md:top-5 md:right-5";

/** The welcome card centered over the globe; picking a question sends it and the chat panel takes over. */
export function EmptyState({ onPick, onClose, questions = EXAMPLE_QUESTIONS, onMore }: EmptyStateProps) {
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
      <h2 className="font-serif text-[20px] font-semibold text-ink">WallyMap</h2>
      <p className="mt-2 text-[14px] leading-snug text-ink-muted">
        Ask the map. Every answer is drawn, cited, and exportable.
      </p>
      <ul className="mt-4 grid grid-cols-1 gap-1.5 sm:mt-5 sm:grid-cols-2 sm:gap-2">
        {questions.map((q, i) => (
          <li key={q} className="rise-in" style={{ animationDelay: `${220 + i * 50}ms` }}>
            <button
              type="button"
              onClick={() => onPick(q)}
              className="group press flex h-full min-h-11 w-full items-center gap-2 rounded-[12px] border border-control-line bg-control-fill px-4 py-2 text-left text-[15px] leading-snug text-ink transition duration-150 ease-out hover:border-ink/40 sm:py-2.5"
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
      {onMore && (
        <button
          type="button"
          onClick={onMore}
          className="mt-3 text-[13px] text-ink-muted underline-offset-4 transition-colors duration-150 hover:text-ink hover:underline"
        >
          More
        </button>
      )}
    </div>
  );
}
