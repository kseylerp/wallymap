/**
 * Per-caller request limits for the public API routes (`/api/chat`, `/api/layer/[id]`), so one caller
 * cannot spend the deployer's model credits or third-party quotas without bound.
 *
 * Counters live in Vercel KV when KV_REST_API_URL and KV_REST_API_TOKEN are set (shared by every
 * serverless instance). Otherwise they live in this process's memory, which is per instance: each
 * instance counts on its own and forgets on restart, so the effective limit is looser. If KV fails,
 * requests are allowed (the limiter fails open) rather than taking the app down.
 *
 * Per-client rules use a sliding window (the weighted sum of the previous and current fixed windows).
 * The global daily rule is one counter for every caller, reset at midnight UTC.
 * Reads and increments are separate calls, so a burst of concurrent requests can overshoot by a few.
 */
import { kvClient, kvConfig } from "./cache";

export type CounterStore = {
  /** Current values of the counters, 0 for a missing one, in the order asked. */
  read(keys: string[]): Promise<number[]>;
  /** Adds one to the counter and keeps it for at least `ttlSeconds`. */
  increment(key: string, ttlSeconds: number): Promise<void>;
};

export type RateLimitRule = {
  /** Counter name, e.g. "chat". */
  name: string;
  /** Most requests allowed per window; 0 or less turns the rule off. */
  limit: number;
  /** "client": one sliding window per caller of `windowMs`. "global-day": one counter for everyone per UTC day. */
  scope: "client" | "global-day";
  windowMs: number;
};

/** Which limit refused a request: the caller's own, or the daily cap shared by everyone. */
export type RateLimitScope = "client" | "daily";

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number; scope: RateLimitScope };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const TEN_MINUTES_MS = 10 * MINUTE_MS;

export const DEFAULT_CHAT_LIMIT = 20;
export const DEFAULT_LAYER_LIMIT = 120;
export const DEFAULT_CHAT_DAILY_LIMIT = 500;
/** Earth Engine tiles per caller per 10 minutes: a full-screen map at one zoom is 20 to 40 tiles, and the CDN serves repeats. */
export const DEFAULT_EE_TILE_LIMIT = 1500;

/** A non-negative integer from the env, or the fallback when unset or not a valid count. */
function envCount(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** RATE_LIMIT_CHAT per caller per 10 minutes, and RATE_LIMIT_CHAT_DAILY across all callers per UTC day. */
export function chatRules(): RateLimitRule[] {
  return [
    { name: "chat", limit: envCount("RATE_LIMIT_CHAT", DEFAULT_CHAT_LIMIT), scope: "client", windowMs: TEN_MINUTES_MS },
    { name: "chat-daily", limit: envCount("RATE_LIMIT_CHAT_DAILY", DEFAULT_CHAT_DAILY_LIMIT), scope: "global-day", windowMs: DAY_MS },
  ];
}

/** RATE_LIMIT_LAYER per caller per 10 minutes. */
export function layerRules(): RateLimitRule[] {
  return [{ name: "layer", limit: envCount("RATE_LIMIT_LAYER", DEFAULT_LAYER_LIMIT), scope: "client", windowMs: TEN_MINUTES_MS }];
}

/** RATE_LIMIT_EE_TILES Earth Engine tiles per caller per 10 minutes (only CDN misses reach the function). */
export function eeTileRules(): RateLimitRule[] {
  return [{ name: "ee-tiles", limit: envCount("RATE_LIMIT_EE_TILES", DEFAULT_EE_TILE_LIMIT), scope: "client", windowMs: TEN_MINUTES_MS }];
}

/**
 * An IPv6 address reduced to its first 64 bits ("2001:db8:1:2::/64"), since one subscriber usually holds a
 * whole /64 and could otherwise rotate addresses to dodge the limit. IPv4-mapped addresses give the IPv4.
 * Returns null for anything that is not IPv6.
 */
export function ipv6Prefix(ip: string): string | null {
  const addr = ip.replace(/^\[|\](:\d+)?$/g, "").split("%")[0];
  if (!addr.includes(":")) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) return mapped[1];
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // A trailing dotted IPv4 part fills two groups.
  const tailGroups = tail.length + (tail.at(-1)?.includes(".") ? 1 : 0);
  const groups = halves.length === 2 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tailGroups)).fill("0"), ...tail] : head;
  const prefix = groups.slice(0, 4);
  if (prefix.length < 4 || !prefix.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return `${prefix.map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/**
 * The caller's key: first hop of x-forwarded-for, then x-real-ip, else "anon" (all unknown callers share one
 * counter). IPv6 callers are keyed by their /64.
 */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || req.headers.get("x-real-ip")?.trim() || "anon";
  return (ipv6Prefix(ip) ?? ip).slice(0, 64);
}

type MemoryCounter = { value: number; expiresAt: number };

/** Sweep expired counters once the map grows past this many. */
const MEMORY_SWEEP_AT = 10_000;

/** A per-process counter store. `now` is injectable for tests. */
export function createMemoryStore(now: () => number = Date.now): CounterStore {
  const counters = new Map<string, MemoryCounter>();
  const live = (key: string): MemoryCounter | undefined => {
    const c = counters.get(key);
    if (c && c.expiresAt <= now()) {
      counters.delete(key);
      return undefined;
    }
    return c;
  };
  return {
    async read(keys) {
      return keys.map((k) => live(k)?.value ?? 0);
    },
    async increment(key, ttlSeconds) {
      if (counters.size >= MEMORY_SWEEP_AT) {
        const t = now();
        for (const [k, c] of counters) if (c.expiresAt <= t) counters.delete(k);
      }
      const c = live(key);
      const expiresAt = now() + ttlSeconds * 1000;
      if (c) {
        c.value += 1;
        c.expiresAt = Math.max(c.expiresAt, expiresAt);
      } else {
        counters.set(key, { value: 1, expiresAt });
      }
    },
  };
}

/** The subset of the KV (Upstash Redis) client the limiter uses; a fake can stand in for tests. */
export type KvCounterClient = {
  mget(...keys: string[]): Promise<unknown[]>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
};

/** A counter store on KV, shared by every instance. */
export function createKvStore(getClient: () => Promise<KvCounterClient>): CounterStore {
  return {
    async read(keys) {
      const client = await getClient();
      const values = await client.mget(...keys);
      return keys.map((_, i) => {
        const n = Number(values[i] ?? 0);
        return Number.isFinite(n) ? n : 0;
      });
    },
    async increment(key, ttlSeconds) {
      const client = await getClient();
      await client.incr(key);
      await client.expire(key, Math.max(1, Math.ceil(ttlSeconds)));
    },
  };
}

// Module-level so every request in a process shares one memory store.
const memoryStore = createMemoryStore();

function defaultStore(): CounterStore {
  const config = kvConfig();
  return config ? createKvStore(() => kvClient(config)) : memoryStore;
}

let warnedAboutStore = false;

type Check = {
  rule: RateLimitRule;
  /** Keys to read: [previous, current] window for a client rule, [today] for the daily rule. */
  keys: string[];
  current: string;
  ttlSeconds: number;
  /** Given the counter values, null when allowed, else milliseconds until a request would be allowed. */
  wait(values: number[]): number | null;
};

function planCheck(rule: RateLimitRule, client: string, now: number): Check {
  if (rule.scope === "global-day") {
    const day = Math.floor(now / DAY_MS);
    const key = `rl:${rule.name}:${day}`;
    return {
      rule,
      keys: [key],
      current: key,
      ttlSeconds: (2 * DAY_MS) / 1000,
      wait: ([count]) => (count < rule.limit ? null : (day + 1) * DAY_MS - now),
    };
  }
  const w = rule.windowMs;
  const bucket = Math.floor(now / w);
  const elapsed = now - bucket * w;
  const prevKey = `rl:${rule.name}:${client}:${bucket - 1}`;
  const currKey = `rl:${rule.name}:${client}:${bucket}`;
  return {
    rule,
    keys: [prevKey, currKey],
    current: currKey,
    ttlSeconds: (2 * w) / 1000,
    wait: ([prev, curr]) => {
      const estimate = (prev * (w - elapsed)) / w + curr;
      if (estimate < rule.limit) return null;
      // Still inside this window: wait until the previous window's weight has faded enough.
      if (curr < rule.limit) return Math.max(0, w - ((rule.limit - curr) * w) / prev - elapsed) + 1;
      // This window alone is full: wait for it to become the previous window and fade.
      return w - elapsed + w * (1 - rule.limit / curr) + 1;
    },
  };
}

/**
 * Checks every rule for this caller and, when all allow it, counts the request against each.
 * A denied request is not counted. Fails open when the store errors.
 */
export async function checkRateLimit(
  client: string,
  rules: RateLimitRule[],
  opts: { store?: CounterStore; now?: number } = {},
): Promise<RateLimitResult> {
  const active = rules.filter((r) => r.limit > 0);
  if (active.length === 0) return { ok: true };
  const now = opts.now ?? Date.now();
  const store = opts.store ?? defaultStore();
  const checks = active.map((rule) => planCheck(rule, client, now));

  try {
    const values = await store.read(checks.flatMap((c) => c.keys));
    let offset = 0;
    let waitMs = 0;
    let scope: RateLimitScope = "client";
    for (const check of checks) {
      const wait = check.wait(values.slice(offset, offset + check.keys.length));
      offset += check.keys.length;
      if (wait !== null && wait > waitMs) {
        waitMs = wait;
        scope = check.rule.scope === "global-day" ? "daily" : "client";
      }
    }
    if (waitMs > 0) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)), scope };
    await Promise.all(checks.map((c) => store.increment(c.current, c.ttlSeconds)));
    return { ok: true };
  } catch (error) {
    if (!warnedAboutStore) {
      warnedAboutStore = true;
      console.warn("Rate limit store unavailable, allowing requests:", error);
    }
    return { ok: true };
  }
}

/** The 429 answer: plain JSON `{ error, retryAfterSeconds, scope }` plus a Retry-After header. */
export function tooManyRequests(retryAfterSeconds: number, scope: RateLimitScope = "client"): Response {
  return Response.json(
    { error: "Too many requests", retryAfterSeconds, scope },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

/** Runs the rules for this request; returns the 429 response to send, or null to carry on. */
export async function limitRequest(req: Request, rules: RateLimitRule[]): Promise<Response | null> {
  const result = await checkRateLimit(clientKey(req), rules);
  return result.ok ? null : tooManyRequests(result.retryAfterSeconds, result.scope);
}
