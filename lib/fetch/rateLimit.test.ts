import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatRules,
  checkRateLimit,
  clientKey,
  ipv6Prefix,
  createKvStore,
  createMemoryStore,
  layerRules,
  tooManyRequests,
  type CounterStore,
  type KvCounterClient,
  type RateLimitRule,
} from "./rateLimit";

const MIN = 60_000;
const DAY = 86_400_000;
// A window boundary, so the arithmetic below is easy to follow.
const T0 = 1_000 * 10 * MIN;

const perClient = (limit: number): RateLimitRule => ({ name: "t", limit, scope: "client", windowMs: 10 * MIN });
const daily = (limit: number): RateLimitRule => ({ name: "d", limit, scope: "global-day", windowMs: DAY });

/** Fake KV: a Map behind the three commands the store uses, with TTLs recorded. */
function fakeKv(): { client: KvCounterClient; data: Map<string, string>; ttl: Map<string, number> } {
  const data = new Map<string, string>();
  const ttl = new Map<string, number>();
  const client: KvCounterClient = {
    mget: async (...keys) => keys.map((k) => data.get(k) ?? null),
    incr: async (key) => {
      const next = Number(data.get(key) ?? 0) + 1;
      data.set(key, String(next));
      return next;
    },
    expire: async (key, seconds) => {
      ttl.set(key, seconds);
      return 1;
    },
  };
  return { client, data, ttl };
}

async function hits(store: CounterStore, rules: RateLimitRule[], n: number, now: number, client = "1.2.3.4") {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await checkRateLimit(client, rules, { store, now }));
  return out;
}

describe.each([
  ["memory", () => createMemoryStore(() => T0)],
  [
    "fake KV",
    () => {
      const { client } = fakeKv();
      return createKvStore(async () => client);
    },
  ],
])("checkRateLimit (%s store)", (_name, makeStore) => {
  it("allows up to the limit in a window, then answers with a wait", async () => {
    const store = makeStore();
    const results = await hits(store, [perClient(20)], 21, T0 + MIN);
    expect(results.slice(0, 20).every((r) => r.ok)).toBe(true);
    const last = results[20];
    expect(last).toMatchObject({ ok: false, scope: "client" });
    // This window alone is full, so the wait runs past the end of it (9 minutes away).
    if (!last.ok) expect(last.retryAfterSeconds).toBeGreaterThanOrEqual(9 * 60);
  });

  it("counts each caller separately", async () => {
    const store = makeStore();
    await hits(store, [perClient(2)], 2, T0, "a");
    expect((await checkRateLimit("a", [perClient(2)], { store, now: T0 })).ok).toBe(false);
    expect((await checkRateLimit("b", [perClient(2)], { store, now: T0 })).ok).toBe(true);
  });

  it("slides: last window's requests fade out across the next window", async () => {
    const store = makeStore();
    await hits(store, [perClient(10)], 10, T0 + 9 * MIN);
    // Just into the next window the previous ten still weigh nearly fully: one more fits, a second does not.
    const early = await hits(store, [perClient(10)], 2, T0 + 10 * MIN + 1000);
    expect(early.map((r) => r.ok)).toEqual([true, false]);
    // Halfway through it they weigh five, plus the one just counted, so four more fit and the fifth does not.
    const half = await hits(store, [perClient(10)], 5, T0 + 15 * MIN);
    expect(half.map((r) => r.ok)).toEqual([true, true, true, true, false]);
    // Two windows on, everything has aged out.
    expect((await checkRateLimit("1.2.3.4", [perClient(10)], { store, now: T0 + 30 * MIN })).ok).toBe(true);
  });

  it("caps everyone together per UTC day and resets at midnight", async () => {
    const store = makeStore();
    const now = 20_000 * DAY + 22 * 60 * MIN; // 22:00 UTC
    const rules = [perClient(100), daily(3)];
    expect((await hits(store, rules, 3, now, "a")).every((r) => r.ok)).toBe(true);
    const blocked = await checkRateLimit("b", rules, { store, now });
    expect(blocked).toEqual({ ok: false, retryAfterSeconds: 2 * 60 * 60, scope: "daily" });
    expect((await checkRateLimit("b", rules, { store, now: 20_001 * DAY })).ok).toBe(true);
  });

  it("does not count a denied request", async () => {
    const store = makeStore();
    const rules = [perClient(1), daily(5)];
    await checkRateLimit("a", rules, { store, now: T0 });
    for (let i = 0; i < 10; i++) await checkRateLimit("a", rules, { store, now: T0 });
    // Only "a"'s single allowed request counts toward the daily cap of 5.
    const others = [];
    for (const c of ["c", "d", "e", "f", "g"]) others.push((await checkRateLimit(c, rules, { store, now: T0 })).ok);
    expect(others).toEqual([true, true, true, true, false]);
  });

  it("turns a rule off at 0", async () => {
    const store = makeStore();
    expect((await hits(store, [perClient(0)], 50, T0)).every((r) => r.ok)).toBe(true);
  });
});

describe("createKvStore", () => {
  it("keeps counters for two windows and reads missing ones as 0", async () => {
    const kv = fakeKv();
    const store = createKvStore(async () => kv.client);
    await checkRateLimit("1.2.3.4", [perClient(5)], { store, now: T0 });
    const key = `rl:t:1.2.3.4:${T0 / (10 * MIN)}`;
    expect(kv.data.get(key)).toBe("1");
    expect(kv.ttl.get(key)).toBe(20 * 60);
    expect(await store.read(["missing", key])).toEqual([0, 1]);
  });

  it("fails open when KV errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createKvStore(async () => {
      throw new Error("kv down");
    });
    expect(await checkRateLimit("a", [perClient(1)], { store, now: T0 })).toEqual({ ok: true });
    warn.mockRestore();
  });
});

describe("rules and request helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads limits from env with defaults", () => {
    vi.stubEnv("RATE_LIMIT_CHAT", "");
    vi.stubEnv("RATE_LIMIT_CHAT_DAILY", "not a number");
    vi.stubEnv("RATE_LIMIT_LAYER", "7");
    expect(chatRules().map((r) => r.limit)).toEqual([20, 500]);
    expect(layerRules()[0]).toMatchObject({ limit: 7, windowMs: 10 * MIN, scope: "client" });
  });

  it("keys callers by the first forwarded hop, then x-real-ip, else anon", () => {
    const req = (headers: Record<string, string>) => new Request("https://x.test/api/chat", { headers });
    expect(clientKey(req({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-real-ip": "10.0.0.2" }))).toBe("203.0.113.9");
    expect(clientKey(req({ "x-real-ip": "10.0.0.2" }))).toBe("10.0.0.2");
    expect(clientKey(req({}))).toBe("anon");
    expect(clientKey(req({ "x-forwarded-for": "2001:db8:abcd:12:aaaa:bbbb:cccc:1" }))).toBe("2001:db8:abcd:12::/64");
  });

  it("keys IPv6 callers by their first 64 bits", () => {
    expect(ipv6Prefix("2001:0db8:abcd:0012:0000:0000:0000:0001")).toBe("2001:db8:abcd:12::/64");
    expect(ipv6Prefix("2001:db8:abcd:12::1")).toBe("2001:db8:abcd:12::/64");
    expect(ipv6Prefix("2001:db8:abcd:12::ffff:2")).toBe(ipv6Prefix("2001:db8:abcd:12:9:9:9:9"));
    expect(ipv6Prefix("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipv6Prefix("::1")).toBe("0:0:0:0::/64");
    expect(ipv6Prefix("[2001:db8:1:2::5]:443")).toBe("2001:db8:1:2::/64");
    expect(ipv6Prefix("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipv6Prefix("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipv6Prefix("203.0.113.9")).toBeNull();
    expect(ipv6Prefix("not:an:address:zz")).toBeNull();
  });

  it("answers 429 with plain JSON and Retry-After", async () => {
    const res = tooManyRequests(120, "daily");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(await res.json()).toEqual({ error: "Too many requests", retryAfterSeconds: 120, scope: "daily" });
  });
});
