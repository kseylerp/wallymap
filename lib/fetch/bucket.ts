export type BucketOptions = { capacity: number; refillPerSecond: number };
export type Bucket = { take(): Promise<void> };

/**
 * Token bucket. Each take() reserves a token immediately (the balance may go
 * negative), then waits as long as the refill rate needs to pay the debt off,
 * so concurrent callers are served in order.
 */
export function createBucket({ capacity, refillPerSecond }: BucketOptions): Bucket {
  let tokens = capacity;
  let last = Date.now();

  return {
    take() {
      const now = Date.now();
      tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSecond);
      last = now;
      tokens -= 1;
      if (tokens >= 0) return Promise.resolve();
      const waitMs = Math.ceil((-tokens / refillPerSecond) * 1000);
      return new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    },
  };
}
