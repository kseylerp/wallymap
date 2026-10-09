import { createHash } from "node:crypto";
import type { BBox } from "@/layers/types";

export type Cache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
};

type MemoryEntry = { value: string; expiresAt: number };

// Module-level so every createCache() call in a process shares one store.
const memory = new Map<string, MemoryEntry>();

const memoryCache: Cache = {
  async get(key) {
    const entry = memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      memory.delete(key);
      return null;
    }
    return entry.value;
  },
  async set(key, value, ttlSeconds) {
    memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },
};

function kvCache(url: string, token: string): Cache {
  // Loaded lazily so local runs and tests never import @vercel/kv.
  const clientPromise = import("@vercel/kv").then(({ createClient }) =>
    createClient({ url, token, automaticDeserialization: false }),
  );
  return {
    async get(key) {
      const client = await clientPromise;
      const value = await client.get<unknown>(key);
      if (value === null || value === undefined) return null;
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    async set(key, value, ttlSeconds) {
      const client = await clientPromise;
      await client.set(key, value, { ex: Math.max(1, Math.ceil(ttlSeconds)) });
    },
  };
}

/** KV-backed when KV_REST_API_URL and KV_REST_API_TOKEN are set, else in-memory. */
export function createCache(): Cache {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (url && token) return kvCache(url, token);
  return memoryCache;
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
