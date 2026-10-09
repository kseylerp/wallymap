import { Wordmark } from "@/components/Brand";

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
      className="glass-strong rise-in pointer-events-auto w-full max-w-[600px] rounded-large p-5 md:p-7"
      style={{ animationDelay: "120ms" }}
    >
      <Wordmark variant="hero" />
      <p className="mt-3 text-[16px] leading-snug text-ink-muted sm:mt-4 md:text-[18px]">
        Ask the map. Every answer is drawn, cited, and exportable.
      </p>
      <ul className="mt-4 grid grid-cols-1 gap-1.5 sm:mt-5 sm:grid-cols-2 sm:gap-2">
        {EXAMPLE_QUESTIONS.map((q, i) => (
          <li key={q} className="rise-in" style={{ animationDelay: `${220 + i * 50}ms` }}>
            <button
              type="button"
              onClick={() => onPick(q)}
              className="group press flex h-full min-h-11 w-full items-center gap-2 rounded-card border border-line bg-paper px-4 py-2 text-left text-[15px] leading-snug text-ink transition duration-150 ease-out hover:border-accent/40 hover:bg-mist sm:py-2.5"
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
