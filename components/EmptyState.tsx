import { Wordmark } from "@/components/Wordmark";

export const EXAMPLE_QUESTIONS = [
  "Show hiking trails around Lake Tahoe",
  "Which trails near Chamonix are alpine grade?",
  "Find footpaths in the Lake District",
  "Show tracks and paths around Torres del Paine",
  "What trails run through the Blue Mountains near Sydney?",
  "Trails near Yosemite Valley with a name",
] as const;

type EmptyStateProps = { onPick: (question: string) => void };

/** The welcome card centered over the globe; picking a question sends it and the chat panel takes over. */
export function EmptyState({ onPick }: EmptyStateProps) {
  return (
    <div
      data-testid="empty-state"
      className="glass rise-in pointer-events-auto w-full max-w-[600px] rounded-card p-5 md:p-7"
      style={{ animationDelay: "120ms" }}
    >
      <Wordmark variant="hero" />
      <p className="mt-2 text-[15px] text-ink-muted sm:mt-3 md:text-base">
        Ask about trails, terrain, and the wild, anywhere on Earth.
      </p>
      <ul className="mt-4 grid grid-cols-1 gap-1.5 sm:mt-5 sm:grid-cols-2 sm:gap-2">
        {EXAMPLE_QUESTIONS.map((q, i) => (
          <li key={q} className="rise-in" style={{ animationDelay: `${220 + i * 50}ms` }}>
            <button
              type="button"
              onClick={() => onPick(q)}
              className="group flex h-full w-full items-center gap-2 rounded-[18px] border border-line bg-paper/90 px-4 py-2 text-left text-[14px] sm:py-2.5 leading-snug text-ink transition-all duration-200 hover:-translate-y-px hover:border-accent/40 hover:bg-accent-soft"
            >
              <span className="flex-1">{q}</span>
              <span
                aria-hidden
                className="text-accent opacity-0 transition-opacity duration-200 group-hover:opacity-100"
              >
                →
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
