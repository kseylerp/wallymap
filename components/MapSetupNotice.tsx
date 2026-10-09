export function MapSetupNotice() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-cream p-4">
      <div className="max-w-md rounded-card border border-line bg-paper p-6 text-ink shadow-soft">
        <h2 className="mb-2 font-serif text-xl font-semibold">Map setup needed</h2>
        <p className="text-sm leading-6 text-ink-muted">
          Set <code className="rounded-md bg-accent-soft px-1 font-mono text-ink">NEXT_PUBLIC_MAPBOX_TOKEN</code>{" "}
          in <code className="font-mono text-ink">.env.local</code> to a Mapbox public token, then restart the dev server.{" "}
          <a
            className="font-medium text-accent-deep underline underline-offset-2"
            href="https://account.mapbox.com/access-tokens/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Get a token
          </a>
        </p>
      </div>
    </div>
  );
}
