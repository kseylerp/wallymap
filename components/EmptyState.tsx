import { Wordmark } from "@/components/Wordmark";

export const EXAMPLE_QUESTIONS = [
  "Show hiking trails around Lake Tahoe",
  "Which wildfires burned near Yosemite in the last 10 years?",
  "Where has the Amazon lost the most forest since 2015?",
  "How much snow is on the ground around Mount Hood?",
  "Find campsites and forest roads open to vehicles near Moab",
  "What wildlife has been spotted around Banff this year?",
] as const;

type EmptyStateProps = { onPick: (question: string) => void };

/** The welcome card centered over the globe; picking a question sends it and the chat panel takes over. */
export function EmptyState({ onPick }: EmptyStateProps) {
  return (
    <div
      data-testid="empty-state"
      className="glass-strong rise-in pointer-events-auto w-full max-w-[600px] rounded-card p-5 md:p-7"
      style={{ animationDelay: "120ms" }}
    >
      <Wordmark variant="hero" />
      <p className="mt-2 text-[15px] text-ink-muted sm:mt-3 md:text-base">
        Ask about trails, fire, forests, snow, rivers, camping, and wildlife, anywhere on Earth.
      </p>
      <ul className="mt-4 grid grid-cols-1 gap-1.5 sm:mt-5 sm:grid-cols-2 sm:gap-2">
        {EXAMPLE_QUESTIONS.map((q, i) => (
          <li key={q} className="rise-in" style={{ animationDelay: `${220 + i * 50}ms` }}>
            <button
              type="button"
              onClick={() => onPick(q)}
              className="group flex h-full w-full items-center gap-2 rounded-[18px] border border-line bg-paper px-4 py-2 text-left text-[14px] leading-snug text-ink transition-all duration-200 hover:-translate-y-px hover:bg-mist sm:py-2.5"
            >
              <span className="flex-1">{q}</span>
              <span
                aria-hidden
                className="text-ink-muted opacity-0 transition-opacity duration-200 group-hover:opacity-100"
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
