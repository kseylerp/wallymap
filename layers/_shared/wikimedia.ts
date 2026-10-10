/**
 * Shared politeness for Wikimedia endpoints (Wikipedia, Commons, Wikidata Query Service).
 * Wikimedia asks for one descriptive User-Agent with a way to find the project (no personal email) and answers 429 (or 503
 * from the query service) to bursts, often with a `Retry-After` header in seconds. `wikimediaFetch` adds the User-Agent and
 * retries once after the advised wait (2 s when the header is missing); a wait over 10 s is not waited for, the 429 is returned.
 */
import type { CachedFetch } from "@/lib/fetch";
import { UPSTREAM_TIMEOUT_MS } from "./constants";

export const WIKIMEDIA_USER_AGENT = "WallyMap/0.1 (https://wallymap.vercel.app)";

const DEFAULT_RETRY_MS = 2_000;
const MAX_RETRY_MS = 10_000;

export type WikimediaInit = Omit<RequestInit, "signal"> & { cacheKey?: string; ttlSeconds?: number };

export type WikimediaOptions = {
  /** Replaced in tests so no real time passes. */
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Milliseconds to wait from a Retry-After header (seconds or an HTTP date), or the default when absent or unreadable. */
export function retryDelayMs(header: string | null, now: number = Date.now()): number {
  if (header === null || header.trim() === "") return DEFAULT_RETRY_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return DEFAULT_RETRY_MS;
}

/**
 * `fetch` through the layer's cached fetch with the Wikimedia User-Agent, one 25 s timeout per attempt, and one retry on
 * 429 or 503. Throws what `fetch` throws (a TimeoutError on timeout); the caller maps that to its own message.
 */
export async function wikimediaFetch(
  fetch: CachedFetch,
  url: string,
  init: WikimediaInit = {},
  options: WikimediaOptions = {},
): Promise<Response> {
  const sleep = options.sleep ?? realSleep;
  const attempt = () =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), "user-agent": WIKIMEDIA_USER_AGENT },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

  const first = await attempt();
  if (first.status !== 429 && first.status !== 503) return first;
  const wait = retryDelayMs(first.headers.get("retry-after"));
  if (wait > MAX_RETRY_MS) return first;
  await sleep(wait);
  return attempt();
}
