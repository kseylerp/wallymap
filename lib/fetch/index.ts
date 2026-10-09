import { bodyHash, createCache } from "./cache";
import { createBucket, type Bucket } from "./bucket";

export { cacheKeyFor, createCache, type Cache } from "./cache";
export { createBucket, type Bucket, type BucketOptions } from "./bucket";

export type CachedFetch = (
  url: string,
  init?: RequestInit & { cacheKey?: string; ttlSeconds?: number },
) => Promise<Response>;

export type LayerFetchOptions = {
  capacity?: number;
  refillPerSecond?: number;
  ttlSeconds?: number;
};

const DEFAULT_CAPACITY = 5;
const DEFAULT_REFILL_PER_SECOND = 1;
const DEFAULT_TTL_SECONDS = 86400;

// One bucket per layer id, shared across createLayerFetch calls.
const buckets = new Map<string, Bucket>();

function bucketFor(layerId: string, capacity: number, refillPerSecond: number): Bucket {
  let bucket = buckets.get(layerId);
  if (!bucket) {
    bucket = createBucket({ capacity, refillPerSecond });
    buckets.set(layerId, bucket);
  }
  return bucket;
}

export function createLayerFetch(layerId: string, opts: LayerFetchOptions = {}): CachedFetch {
  const bucket = bucketFor(
    layerId,
    opts.capacity ?? DEFAULT_CAPACITY,
    opts.refillPerSecond ?? DEFAULT_REFILL_PER_SECOND,
  );
  const defaultTtl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const cache = createCache();

  return async (url, init = {}) => {
    const { cacheKey, ttlSeconds, ...requestInit } = init;
    await bucket.take();

    const method = (requestInit.method ?? "GET").toUpperCase();
    const body = typeof requestInit.body === "string" ? requestInit.body : "";
    const key = cacheKey ?? `${layerId}:${method}:${url}:${bodyHash(body)}`;

    const cached = await cache.get(key);
    if (cached !== null) {
      return new Response(cached, { status: 200, headers: { "x-cache": "HIT" } });
    }

    const response = await fetch(url, requestInit);
    if (response.status < 200 || response.status >= 300) return response;

    const text = await response.text();
    await cache.set(key, text, ttlSeconds ?? defaultTtl);
    const headers = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    return new Response(text, { status: response.status, headers });
  };
}
