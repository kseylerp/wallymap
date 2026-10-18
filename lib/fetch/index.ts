import { bodyHash, createCache, type Cache } from "./cache";
import { createBucket, type Bucket } from "./bucket";
import type { SourceFailure } from "@/layers/types";

export { cacheKeyFor, createCache, type Cache } from "./cache";
export { createBucket, type Bucket, type BucketOptions } from "./bucket";
export { jsonArrayBody, jsonObjectBody, textBody } from "./validate";

export type CachedFetch = (
  url: string,
  init?: RequestInit & {
    cacheKey?: string;
    ttlSeconds?: number;
    /**
     * Whether a 2xx body is a real answer worth caching. Upstreams that report failures as HTTP 200
     * pass their own check; the default is `!looksLikeUpstreamFailure(body)`.
     */
    shouldCache?: (body: string) => boolean;
    /**
     * Whether a 2xx body has the shape the caller needs (see ./validate). When it returns false the body is
     * not cached and the caller gets a 502 instead, so a maintenance page or truncated file surfaces as an
     * upstream error rather than being stored under a shared key for a day. Checked before `shouldCache`.
     */
    validate?: (body: string) => boolean;
    /**
     * Abort the upstream call this many ms after it gets its rate-limit slot. Prefer this to passing
     * `signal: AbortSignal.timeout(...)`, whose clock also runs while the call waits in the rate limiter.
     */
    timeoutMs?: number;
  },
) => Promise<Response>;

export type LayerFetchOptions = {
  capacity?: number;
  refillPerSecond?: number;
  ttlSeconds?: number;
  /** Override the cache backend (defaults to createCache()). */
  cache?: Cache;
  /**
   * Called when an upstream call fails in a way the person should hear about (a 5xx, a 429, a timeout, an unreachable
   * host or a body that fails `validate`); lib/layers/run.ts copies the first one onto the answer as `sourceStatus`.
   */
  onSourceFailure?: (failure: SourceFailure) => void;
};

/** The host a URL names, for failure messages ("waterservices.usgs.gov"); the URL itself when it does not parse. */
/** Who runs a host, in the words people know them by, for the failure line ("NOAA's weather service"). */
const SOURCE_NAMES: [RegExp, string][] = [
  [/(^|\.)weather\.gov$/, "NOAA's weather service"],
  [/(^|\.)noaa\.gov$/, "NOAA"],
  [/(^|\.)usgs\.gov$/, "USGS"],
  [/(^|\.)nasa\.gov$/, "NASA"],
  [/(^|\.)earthdata\.nasa\.gov$/, "NASA"],
  [/(^|\.)usda\.gov$/, "USDA"],
  [/(^|\.)fs\.fed\.us$/, "the Forest Service"],
  [/(^|\.)nps\.gov$/, "the National Park Service"],
  [/(^|\.)blm\.gov$/, "BLM"],
  [/(^|\.)fws\.gov$/, "Fish and Wildlife Service"],
  [/(^|\.)epa\.gov$/, "EPA"],
  [/(^|\.)fema\.gov$/, "FEMA"],
  [/(^|\.)glims\.org$/, "GLIMS"],
  [/(^|\.)gbif\.org$/, "GBIF"],
  [/(^|\.)wikidata\.org$/, "Wikidata"],
  [/(^|\.)wikipedia\.org$/, "Wikipedia"],
  [/overpass/, "OpenStreetMap's Overpass server"],
  [/(^|\.)openstreetmap\.(org|fr)$/, "OpenStreetMap"],
  [/(^|\.)open-meteo\.com$/, "Open-Meteo"],
  [/(^|\.)globalforestwatch\.org$/, "Global Forest Watch"],
  [/(^|\.)arcgis\.com$/, "Esri's ArcGIS server"],
];

function hostLabel(url: string): string {
  const host = hostOf(url);
  if (!host) return "The source";
  return SOURCE_NAMES.find(([re]) => re.test(host))?.[1] ?? host;
}

/** "NOAA's weather service's server" reads badly: the owner of a server, possessive. */
function serverOf(url: string): string {
  const label = hostLabel(url);
  return /server$|service$/.test(label) ? label : `${label}'s server`;
}

/** The SourceFailure for an HTTP status, or null when the status is not a source failure (2xx, 3xx, a 4xx but 429). */
export function sourceFailureForStatus(status: number, url: string, now: Date = new Date()): SourceFailure | null {
  const since = now.toISOString();
  if (status === 429) return { ok: false, reason: "rate-limited", message: `${hostLabel(url)} is limiting requests right now (429).`, since };
  if (status >= 500) return { ok: false, reason: "server-error", message: `${serverOf(url)} is returning errors (${status}).`, since };
  return null;
}

/** The SourceFailure for a fetch that threw: a timeout or abort, or a host that could not be reached. */
export function sourceFailureForError(error: unknown, url: string, now: Date = new Date()): SourceFailure {
  const name = error instanceof Error ? error.name : "";
  const timedOut = name === "TimeoutError" || name === "AbortError";
  return {
    ok: false,
    reason: "offline",
    message: timedOut ? `${hostLabel(url)} did not answer in time.` : `${hostLabel(url)} could not be reached.`,
    since: now.toISOString(),
  };
}

const DEFAULT_CAPACITY = 5;
const DEFAULT_REFILL_PER_SECOND = 1;
const DEFAULT_TTL_SECONDS = 86400;

// One bucket per layer id, shared across createLayerFetch calls.
const buckets = new Map<string, Bucket>();

/**
 * Hosts that tolerate more than the per-layer default and whose layers make many small calls per view (one per
 * station, zone or point). Each gets one bucket shared by every layer, instead of the layer's own.
 */
export const HOST_RATES: Record<string, { capacity: number; refillPerSecond: number }> = {
  "api.weather.gov": { capacity: 5, refillPerSecond: 5 },
  "api.tidesandcurrents.noaa.gov": { capacity: 5, refillPerSecond: 5 },
  "waterservices.usgs.gov": { capacity: 5, refillPerSecond: 5 },
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** The bucket a request to `url` waits in: its host's shared bucket when HOST_RATES lists it, else the layer's. */
function bucketForRequest(url: string, layerBucket: Bucket): Bucket {
  const host = hostOf(url);
  const rate = host === null ? undefined : HOST_RATES[host];
  if (rate === undefined) return layerBucket;
  return bucketFor(`host:${host}`, rate.capacity, rate.refillPerSecond);
}

function bucketFor(layerId: string, capacity: number, refillPerSecond: number): Bucket {
  let bucket = buckets.get(layerId);
  if (!bucket) {
    bucket = createBucket({ capacity, refillPerSecond });
    buckets.set(layerId, bucket);
  }
  return bucket;
}

/** Bodies larger than this are never parsed by the default check; upstream error bodies are small. */
const FAILURE_SNIFF_MAX_CHARS = 64 * 1024;
const FAILURE_REMARK = /timed out|runtime error|out of memory/i;

/**
 * True for a 200 body that is really an upstream failure: a JSON object with a top-level `error`
 * (ArcGIS, MediaWiki/Commons) or an Overpass failure `remark`. Genuine empty results are not failures.
 */
export function looksLikeUpstreamFailure(body: string): boolean {
  if (body.length > FAILURE_SNIFF_MAX_CHARS || !body.trimStart().startsWith("{")) return false;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof json !== "object" || json === null) return false;
  const record = json as Record<string, unknown>;
  if (record.error !== undefined && record.error !== null) return true;
  return typeof record.remark === "string" && FAILURE_REMARK.test(record.remark);
}

/** Header set on a 204 or 205 answer the wrapper passes back with no body. */
export const EMPTY_BODY_HEADER = "x-empty-body";

/** Status a fetch returns when `validate` rejects a 2xx body, so callers' `!res.ok` paths report it as upstream. */
export const INVALID_BODY_STATUS = 502;

const defaultShouldCache = (body: string): boolean => !looksLikeUpstreamFailure(body);

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
    const { cacheKey, ttlSeconds, shouldCache = defaultShouldCache, validate, timeoutMs, ...requestInit } = init;

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
    await bucketForRequest(url, bucket).take();
    if (timeoutMs !== undefined) {
      // The timeout starts now, after the wait for a slot, so queued calls are not cut short.
      const timeout = AbortSignal.timeout(timeoutMs);
      requestInit.signal = requestInit.signal ? AbortSignal.any([requestInit.signal, timeout]) : timeout;
    }
    let response: Response;
    try {
      response = await fetch(url, requestInit);
    } catch (error) {
      opts.onSourceFailure?.(sourceFailureForError(error, url));
      throw error;
    }
    if (response.status < 200 || response.status >= 300) {
      const failure = sourceFailureForStatus(response.status, url);
      if (failure) opts.onSourceFailure?.(failure);
      return response;
    }
    // 204 and 205 have no body (`new Response("", { status: 204 })` throws). Pass an empty answer back, marked and uncached:
    // it is a signal such as "no more pages", not data.
    if (response.status === 204 || response.status === 205) {
      return new Response(null, { status: response.status, headers: { [EMPTY_BODY_HEADER]: "1" } });
    }

    const responseText = await response.text();
    if (validate !== undefined && !validate(responseText)) {
      opts.onSourceFailure?.({ ok: false, reason: "server-error", message: `${hostLabel(url)} returned an unexpected answer.`, since: new Date().toISOString() });
      return new Response(responseText, {
        status: INVALID_BODY_STATUS,
        statusText: "Upstream returned an unexpected body",
        headers: { "x-invalid-body": "1" },
      });
    }
    // A failure that arrived as a 200 is passed back to the caller but never cached.
    if (key !== null && shouldCache(responseText)) {
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
export { isRetryableStatus, mapLimit, withRetry, type AttemptResult, type RetryPolicy, type RetryResult } from "./retry";
