export const EXAMPLE_QUESTIONS = [
  "Show hiking trails around Lake Tahoe",
  "Which trails near Chamonix are alpine grade?",
  "Find footpaths in the Lake District",
  "Show tracks and paths around Torres del Paine",
  "What trails run through the Blue Mountains near Sydney?",
  "Trails near Yosemite Valley with a name",
] as const;

type EmptyStateProps = { onPick: (question: string) => void };

export function EmptyState({ onPick }: EmptyStateProps) {
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="empty-state">
      <p className="text-sm text-neutral-600">Ask about outdoor data anywhere on Earth. Try one of these:</p>
      <ul className="flex flex-col gap-2">
        {EXAMPLE_QUESTIONS.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => onPick(q)}
              className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-sm text-neutral-800 shadow-sm transition hover:border-emerald-500 hover:bg-emerald-50"
            >
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
