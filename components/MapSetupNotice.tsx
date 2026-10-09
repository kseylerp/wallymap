export function MapSetupNotice() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-zinc-100 p-4 dark:bg-zinc-900">
      <div className="max-w-md rounded-lg border border-zinc-300 bg-white p-6 text-zinc-800 shadow-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
        <h2 className="mb-2 text-lg font-semibold">Map setup needed</h2>
        <p className="text-sm leading-6">
          Set <code className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">NEXT_PUBLIC_MAPBOX_TOKEN</code>{" "}
          in <code className="font-mono">.env.local</code> to a Mapbox public token, then restart the dev server.{" "}
          <a
            className="font-medium text-blue-700 underline dark:text-blue-400"
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
