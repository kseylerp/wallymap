import { afterEach, describe, expect, it, vi } from "vitest";
import snowpack, { STATION_LIST_BODY as SNOTEL_LIST } from "@/layers/snowpack";
import tides, { STATION_LIST_BODY as NOAA_LIST } from "@/layers/tides";
import surf, { LATEST_OBS_BODY, STATION_LIST_BODY as NDBC_LIST } from "@/layers/surf";
import smoke, { HMS_KML_BODY } from "@/layers/smoke";
import type { Layer, QueryContext } from "@/layers/types";
import snotelStations from "@/layers/__fixtures__/snotel-stations.json";
import coopsStations from "@/layers/__fixtures__/coops-stations.sf.json";
import { readFileSync } from "node:fs";
import { createLayerFetch, INVALID_BODY_STATUS, type Cache } from "./index";
import { jsonArrayBody, jsonObjectBody, textBody } from "./validate";

const fixture = (name: string) => readFileSync(new URL(`../../layers/__fixtures__/${name}`, import.meta.url), "utf8");

/** What an upstream serves during maintenance: HTTP 200 and an HTML page. */
const MAINTENANCE =
  "<!DOCTYPE html><html><head><title>Scheduled maintenance</title></head><body><h1>This service is down for maintenance</h1></body></html>";

function mapCache(): Cache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      store.set(k, v);
    },
  };
}

describe("body validators", () => {
  it("accept the recorded upstream bodies", () => {
    expect(SNOTEL_LIST(JSON.stringify(snotelStations))).toBe(true);
    expect(NOAA_LIST(JSON.stringify(coopsStations))).toBe(true);
    expect(LATEST_OBS_BODY(fixture("ndbc-latest-obs.txt"))).toBe(true);
    expect(NDBC_LIST(fixture("ndbc-stations.xml"))).toBe(true);
    expect(HMS_KML_BODY(fixture("smoke.hms.kml"))).toBe(true);
  });

  it("reject a maintenance page", () => {
    for (const check of [SNOTEL_LIST, NOAA_LIST, LATEST_OBS_BODY, NDBC_LIST, HMS_KML_BODY, jsonObjectBody()]) {
      expect(check(MAINTENANCE)).toBe(false);
    }
  });

  it("reject empty or wrongly shaped JSON", () => {
    expect(SNOTEL_LIST("[]")).toBe(false);
    expect(SNOTEL_LIST('[{"name":"x"}]')).toBe(false);
    expect(NOAA_LIST('{"count":0,"stations":[]}')).toBe(false);
    expect(NOAA_LIST('{"error":"busy"}')).toBe(false);
    expect(jsonArrayBody({ minLength: 0 })("[]")).toBe(true);
    expect(jsonObjectBody()("[1]")).toBe(false);
    expect(jsonObjectBody()("null")).toBe(false);
    expect(textBody({ markers: [/x/], minChars: 5 })("xx")).toBe(false);
  });
});

describe("createLayerFetch validate", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("does not cache a rejected body and answers 502, then caches a good one", async () => {
    let body = MAINTENANCE;
    globalThis.fetch = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const cache = mapCache();
    const f = createLayerFetch("validate-unit", { capacity: 100, refillPerSecond: 100, cache });
    const validate = jsonObjectBody();

    const bad = await f("https://up.test/list", { cacheKey: "shared:list", validate });
    expect(bad.status).toBe(INVALID_BODY_STATUS);
    expect(bad.ok).toBe(false);
    expect(cache.store.size).toBe(0);

    body = '{"stations":[1]}';
    const good = await f("https://up.test/list", { cacheKey: "shared:list", validate });
    expect(good.status).toBe(200);
    expect(cache.store.get("shared:list")).toBe(body);
  });
});

/**
 * Each layer's shared, day-long entries, end to end: the real fetch wrapper, an upstream that answers every call
 * with HTTP 200 and a maintenance page, and a private cache. The layer must report an upstream error, and the
 * page must not be stored under any key.
 */
describe("a maintenance page from upstream", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  let seq = 0;
  async function runWithMaintenance(layer: Layer, bbox: QueryContext["bbox"], input: Record<string, unknown> = {}) {
    globalThis.fetch = vi.fn(async () => new Response(MAINTENANCE, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const cache = mapCache();
    const ctx: QueryContext = {
      bbox,
      zoom: 9,
      env: {},
      fetch: createLayerFetch(`maintenance-${layer.id}-${seq++}`, { capacity: 100, refillPerSecond: 100, cache }),
      cacheKey: `${layer.id}:test`,
    };
    const result = await layer.query(ctx, layer.input.parse(input));
    return { result, cache };
  }

  it.each([
    ["snowpack (SNOTEL station list)", snowpack, [-120.3, 38.8, -119.8, 39.3]],
    ["tides (NOAA station lists)", tides, [-122.7, 37.6, -122.2, 38.0]],
    ["surf (NDBC latest observations)", surf, [-123.2, 37.0, -122.2, 38.0]],
    ["smoke (HMS daily KML)", smoke, [-124, 36, -118, 40]],
  ] as const)("%s is an upstream error and is not cached", async (_name, layer, bbox) => {
    const { result, cache } = await runWithMaintenance(layer as Layer, [...bbox] as QueryContext["bbox"]);
    expect(result).toMatchObject({ hint: "upstream" });
    expect([...cache.store.values()].some((v) => v.includes("maintenance"))).toBe(false);
  });

  it("surf seasonal mode is an upstream error and caches neither NDBC file", async () => {
    const { result, cache } = await runWithMaintenance(surf as Layer, [-158.4, 21.2, -157.6, 21.8], { season: true });
    expect(result).toMatchObject({ hint: "upstream" });
    expect(cache.store.size).toBe(0);
  });
});
