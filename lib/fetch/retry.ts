/**
 * Retry with backoff for an upstream call that fails now and then (rate limits, a busy server, a dropped connection).
 * Each attempt reports whether its failure is worth another try; a deadline shared by every call of one query keeps the
 * whole query inside the route's time budget, so a retry only starts when enough time is left for it to finish.
 */

export type RetryPolicy = {
  /** Waits before the second, third... attempt; attempts = delaysMs.length + 1. */
  delaysMs: readonly number[];
  /** Most one attempt may take. */
  attemptTimeoutMs: number;
  /** A retry starts only when at least this much time is left before the deadline after its wait. */
  minAttemptMs: number;
};

export type AttemptResult<T> = { ok: true; value: T } | { ok: false; error: string; retry: boolean };

export type RetryResult<T> = { ok: true; value: T; attempts: number } | { ok: false; error: string; attempts: number };

/** HTTP statuses worth asking again: timeouts, rate limits and server errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` until it succeeds, says not to retry, the policy runs out of attempts, or the deadline (epoch ms) is
 * too close. `attempt` gets its 1-based number and the timeout it must respect (the policy's, or less near the deadline).
 */
export async function withRetry<T>(
  policy: RetryPolicy,
  deadline: number,
  attempt: (n: number, timeoutMs: number) => Promise<AttemptResult<T>>,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<RetryResult<T>> {
  let error = "no attempt was made";
  for (let n = 1; n <= policy.delaysMs.length + 1; n++) {
    if (n > 1) {
      const wait = policy.delaysMs[n - 2] ?? 0;
      if (deadline - Date.now() - wait < policy.minAttemptMs) return { ok: false, error, attempts: n - 1 };
      await sleep(wait);
    }
    const timeoutMs = Math.max(1, Math.min(policy.attemptTimeoutMs, deadline - Date.now()));
    const result = await attempt(n, timeoutMs);
    if (result.ok) return { ok: true, value: result.value, attempts: n };
    error = result.error;
    if (!result.retry) return { ok: false, error, attempts: n };
  }
  return { ok: false, error, attempts: policy.delaysMs.length + 1 };
}

/** Maps `items` through `fn` with at most `limit` running at once, keeping order. */
export async function mapLimit<I, O>(items: readonly I[], limit: number, fn: (item: I) => Promise<O>): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
