import { createHash } from "node:crypto";
import type { VercelKV } from "@vercel/kv";
import type { BBox } from "@/layers/types";

export type Cache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
};

type MemoryEntry = { value: string; expiresAt: number; size: number };

/**
 * Most the in-memory cache holds, in bytes (string length of key plus value; station lists and API bodies are
 * almost all ASCII). Large shared station lists (NOAA tides about 2 MB) fit many times over, so one busy layer
 * no longer flushes the lists every other layer depends on.
 */
export const MEMORY_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** One entry may use at most this share of the budget, so a single huge body cannot empty the cache. */
const MAX_ENTRY_SHARE = 4;

export type MemoryCache = Cache & {
  /** Bytes currently held. */
  readonly bytes: () => number;
};

/** A process-memory cache bounded by bytes, least recently used out first. */
export function createMemoryCache(maxBytes: number = MEMORY_CACHE_MAX_BYTES): MemoryCache {
  // Maps iterate in insertion order; a hit re-inserts its key, so the first key is the least recently used.
  const entries = new Map<string, MemoryEntry>();
  let bytes = 0;

  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    bytes -= entry.size;
  };

  return {
    bytes: () => bytes,
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        remove(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      remove(key);
      const size = key.length + value.length;
      if (size > maxBytes / MAX_ENTRY_SHARE) return;
      for (const [oldest, entry] of entries) {
        if (bytes + size <= maxBytes) break;
        // Expired or not, the least recently used entry goes first.
        entries.delete(oldest);
        bytes -= entry.size;
      }
      entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000, size });
      bytes += size;
    },
  };
}

// Module-level so every createCache() call in a process shares one store.
const memoryCache = createMemoryCache();

type KvConfig = { url: string; token: string };

/** The KV REST credentials when both are set, else null (callers then use process memory). */
export function kvConfig(): KvConfig | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

const kvClients = new Map<string, Promise<VercelKV>>();

/**
 * A lazily created KV client, shared by the cache and the rate limiter. Loaded on first use so
 * local runs and tests never import @vercel/kv, and a failed import surfaces as a catchable error.
 */
export function kvClient({ url, token }: KvConfig): Promise<VercelKV> {
  const id = `${url}\n${token}`;
  let client = kvClients.get(id);
  if (!client) {
    client = import("@vercel/kv")
      .then(({ createClient }) => createClient({ url, token, automaticDeserialization: false }))
      .catch((error: unknown) => {
        kvClients.delete(id);
        throw error;
      });
    kvClients.set(id, client);
  }
  return client;
}

/**
 * Largest value written to KV. Upstash refuses requests over about 1 MB on its free plan, and the NOAA tide
 * station list alone is about 2 MB, so larger values stay in process memory instead.
 */
export const KV_MAX_VALUE_BYTES = 900_000;

const warnedKeys = new Set<string>();
const MAX_WARNED_KEYS = 1_000;

/** One warning per key, so a value that never fits KV says so once, not on every request and not just once per process. */
function warnOncePerKey(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  if (warnedKeys.size >= MAX_WARNED_KEYS) warnedKeys.clear();
  warnedKeys.add(key);
  console.warn(message);
}

/** Tests only. */
export function resetCacheWarnings(): void {
  warnedKeys.clear();
}

/**
 * KV first, with process memory as the fallback for values KV cannot take: one over KV_MAX_VALUE_BYTES, or one
 * whose write KV rejects. Reads look in memory first, which only ever holds those fallback values in this mode.
 */
export function kvCache(getClient: () => Promise<Pick<VercelKV, "get" | "set">>, memory: Cache = memoryCache): Cache {
  return {
    async get(key) {
      const local = await memory.get(key);
      if (local !== null) return local;
      const client = await getClient();
      const value = await client.get<unknown>(key);
      if (value === null || value === undefined) return null;
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    async set(key, value, ttlSeconds) {
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes > KV_MAX_VALUE_BYTES) {
        warnOncePerKey(key, `Cache: ${key} is ${bytes} bytes, over the ${KV_MAX_VALUE_BYTES}-byte KV limit; kept in process memory instead`);
        await memory.set(key, value, ttlSeconds);
        return;
      }
      try {
        const client = await getClient();
        await client.set(key, value, { ex: Math.max(1, Math.ceil(ttlSeconds)) });
      } catch (error) {
        warnOncePerKey(key, `Cache: KV refused ${key} (${bytes} bytes); kept in process memory instead: ${String(error)}`);
        await memory.set(key, value, ttlSeconds);
      }
    },
  };
}

/** KV-backed when KV_REST_API_URL and KV_REST_API_TOKEN are set, else in-memory. */
export function createCache(): Cache {
  const config = kvConfig();
  return config ? kvCache(() => kvClient(config)) : memoryCache;
}

/** Short deterministic hash of a request body; empty body gives an empty string. */
export function bodyHash(body: string): string {
  if (!body) return "";
  return createHash("sha1").update(body).digest("hex").slice(0, 12);
}

function sortKeys(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return sorted;
}

/** Stable cache key: layer id, bbox rounded to 3 decimals, input with sorted keys. */
export function cacheKeyFor(layerId: string, bbox: BBox, input: unknown): string {
  const rounded = bbox.map((n) => Number(n.toFixed(3))).join(",");
  return `${layerId}:${rounded}:${JSON.stringify(sortKeys(input))}`;
}
