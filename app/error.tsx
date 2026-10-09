"use client";

import { useEffect } from "react";

/**
 * The page's error boundary: a render error in a card or panel shows this plain notice instead of Next's generic
 * client-error screen. Retry renders the page again; the map and chat start over from what the URL hash carries.
 */
export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="flex h-dvh w-full items-center justify-center bg-cream p-4">
      <div className="max-w-md rounded-card border border-line bg-paper p-6 text-ink shadow-soft">
        <h2 className="mb-2 font-serif text-xl font-semibold">Something went wrong</h2>
        <p className="text-sm leading-6 text-ink-muted">
          Part of the page stopped working. Retry to load it again; the map comes back to the view in the address bar.
        </p>
        <button
          type="button"
          onClick={() => retry()}
          className="press mt-4 h-9 rounded-pill bg-primary px-4 text-[14px] font-medium text-on-primary transition duration-150 ease-out hover:opacity-85"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
