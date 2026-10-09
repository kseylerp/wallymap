import { bodyHash, createCache, type Cache } from "./cache";
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
  /** Override the cache backend (defaults to createCache()). */
  cache?: Cache;
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

let warnedAboutCache = false;

function warnCacheFailure(error: unknown): void {
  if (warnedAboutCache) return;
  warnedAboutCache = true;
  console.warn("Fetch cache unavailable, falling back to uncached requests:", error);
}

/**
 * Body text used in the default cache key, or null when the body cannot be
 * serialised reliably (binary, Blob, FormData, streams), in which case the
 * default key would collide and the request must bypass the cache.
 */
function bodyText(body: RequestInit["body"]): string | null {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return null;
}

export function createLayerFetch(layerId: string, opts: LayerFetchOptions = {}): CachedFetch {
  const bucket = bucketFor(
    layerId,
    opts.capacity ?? DEFAULT_CAPACITY,
    opts.refillPerSecond ?? DEFAULT_REFILL_PER_SECOND,
  );
  const defaultTtl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const cache = opts.cache ?? createCache();

  return async (url, init = {}) => {
    const { cacheKey, ttlSeconds, ...requestInit } = init;

    const method = (requestInit.method ?? "GET").toUpperCase();
    const text = bodyText(requestInit.body);
    const key =
      cacheKey ?? (text === null ? null : `${layerId}:${method}:${url}:${bodyHash(text)}`);

    if (key !== null) {
      try {
        const cached = await cache.get(key);
        if (cached !== null) {
          return new Response(cached, { status: 200, headers: { "x-cache": "HIT" } });
        }
      } catch (error) {
        warnCacheFailure(error);
      }
    }

    // Only real upstream calls spend rate-limit tokens.
    await bucket.take();
    const response = await fetch(url, requestInit);
    if (response.status < 200 || response.status >= 300) return response;

    const responseText = await response.text();
    if (key !== null) {
      try {
        await cache.set(key, responseText, ttlSeconds ?? defaultTtl);
      } catch (error) {
        warnCacheFailure(error);
      }
    }
    const headers = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    return new Response(responseText, { status: response.status, headers });
  };
}
