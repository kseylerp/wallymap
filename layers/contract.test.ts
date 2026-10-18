import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { z } from "zod";
import type { Feature, FeatureCollection } from "geojson";
import { defineLayer, type Layer, type LayerResult } from "./types";
import { listLayers, registerLayer, clearRegistry } from "./registry";
import "./index";
import { cardTitle, contractProblems, displayOf, labelsOf, legendOf, sourceStatusOf, timeShapeOf } from "./contract";
import { createLayerFetch, sourceFailureForStatus } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import type { Cache } from "@/lib/fetch";

/** Every real layer, captured before any test clears the registry. */
const registered = listLayers();

const base = defineLayer({
  id: "contract-fake", title: "Fake things, for tests", description: "Fake tiles. More words.", coverage: "global", surface: "any",
  license: "CC0", requiredEnv: [], maxAreaKm2: 100000, input: z.object({}),
  query: async () => ({ error: "nope" }), style: { geometry: "point", color: "#3A3A3C" },
});
const layer = (extra: Partial<Layer>): Layer => ({ ...base, ...extra }) as Layer;

const pt = (properties: Record<string, unknown>): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties });
const fc = (props: Record<string, unknown>[]): FeatureCollection => ({ type: "FeatureCollection", features: props.map(pt) });
const citation = { source: "Fake", url: "https://example.test", retrieved: "2026-10-18T00:00:00Z" };

describe("timeShapeOf", () => {
  it("is none for undated features and for a layer with no time at all", () => {
    expect(timeShapeOf(base, fc([{ name: "a" }, { name: "b" }])).shape).toBe("none");
    expect(timeShapeOf(base).shape).toBe("none");
  });
  it("is single for one date", () => {
    expect(timeShapeOf(base, fc([{ t: "2026-10-01" }, { t: "2026-10-01T12:00:00Z" }]))).toMatchObject({ shape: "single", dates: ["2026-10-01"] });
  });
  it("is snapshots for a few survey dates holding several features each", () => {
    const data = fc([1963, 1963, 1990, 1990, 2019, 2019].map((t) => ({ t })));
    expect(timeShapeOf(base, data)).toEqual({ shape: "snapshots", dates: ["1963", "1990", "2019"], span: { start: "1963", end: "2019" }, step: "year" });
  });
  it("is continuous for many dates, or a few dates of one event each", () => {
    const days = Array.from({ length: 10 }, (_, i) => ({ t: `2026-10-${String(i + 1).padStart(2, "0")}` }));
    expect(timeShapeOf(base, fc(days))).toMatchObject({ shape: "continuous", step: "day", span: { start: "2026-10-01", end: "2026-10-10" } });
    expect(timeShapeOf(base, fc([{ t: "2026-10-01" }, { t: "2026-10-03" }, { t: "2026-10-05" }])).shape).toBe("continuous");
  });
  it("reads the layer's time field and epoch milliseconds", () => {
    const l = layer({ style: { ...base.style, timeField: "when" } });
    expect(timeShapeOf(l, fc([{ when: Date.UTC(2026, 0, 1) }])).shape).toBe("single");
  });
  it("is continuous by the series step and the tile cadence", () => {
    const series: LayerResult = { kind: "geojson", data: fc([{}]), citation, series: { times: ["2026-10-01T00:00Z", "2026-10-02T00:00Z"], step: "day", now: 1 } };
    expect(timeShapeOf(base, series)).toMatchObject({ shape: "continuous", step: "day" });
    const tiles: LayerResult = {
      kind: "tiles", citation,
      data: { url: "https://t/{z}", minzoom: 0, maxzoom: 9, format: "raster", time: { template: "https://t/{year}", cadence: "yearly", from: "2001", to: "2024" } },
    };
    expect(timeShapeOf(base, tiles)).toEqual({ shape: "continuous", step: "year", span: { start: "2001", end: "2024" } });
  });
  it("keeps a declared shape and fills its dates from the data", () => {
    const l = layer({ time: { shape: "snapshots" } });
    expect(timeShapeOf(l, fc([{ t: "2021" }, { t: "2024" }])).dates).toEqual(["2021", "2024"]);
    expect(timeShapeOf(layer({ time: { shape: "single" } }), fc(Array.from({ length: 9 }, (_, i) => ({ t: `200${i}` })))).shape).toBe("single");
  });
  it("keeps today's panel without data: a time attribute or field is continuous", () => {
    expect(timeShapeOf(layer({ style: { ...base.style, timeField: "t" } })).shape).toBe("continuous");
    expect(timeShapeOf(layer({ style: { ...base.style, series: "hour" } }))).toEqual({ shape: "continuous", step: "hour" });
  });
});

describe("legendOf", () => {
  it("every registered layer resolves to a non-empty legend", () => {
    expect(registered.length).toBeGreaterThanOrEqual(81);
    for (const l of registered) {
      const legend = legendOf(l);
      expect((legend.items?.length ?? 0) + (legend.stops?.length ?? 0) + (legend.imageUrl ? 1 : 0), l.id).toBeGreaterThan(0);
      for (const entry of [...(legend.items ?? []), ...(legend.stops ?? [])]) expect(entry.label.trim(), l.id).not.toBe("");
    }
  });
  it("uses the color attribute's levels, then a size measure, then one swatch", () => {
    const ordinal = layer({ attributes: [{ key: "v", type: "ordinal", label: "Class", encode: "color", scale: "x", levels: [{ value: 1, label: "I" }, { value: 2, label: "II" }, { value: 3, label: "II" }] }] });
    expect(legendOf(ordinal)).toEqual({ kind: "categories", title: "Class", field: "v", items: [{ label: "I", value: 1 }, { label: "II", value: 2 }] });
    const size = layer({ attributes: [{ key: "mw", type: "measure", label: "Capacity", unit: "MW", encode: "size", presets: [{ label: "Big", min: 100 }, { label: "Small", min: 1 }] }] });
    expect(legendOf(size)).toMatchObject({ kind: "size", unit: "MW", stops: [{ label: "Small", value: 1 }, { label: "Big", value: 100 }] });
    expect(legendOf(base)).toEqual({ kind: "symbol", items: [{ label: "Fake things", color: "#3A3A3C", symbol: "point" }] });
  });
  it("takes an open category's chips from the data, and a raster's note from its description", () => {
    const cat = layer({ attributes: [{ key: "kind", type: "category", label: "Kind" }] });
    expect(legendOf(cat, fc([{ kind: "rapid" }, { kind: "put-in" }, { kind: "rapid" }])).items?.map((i) => i.label)).toEqual(["Rapid", "Put in"]);
    const raster = layer({ style: { ...base.style, raster: { swatch: "#ABCDEF" } } });
    expect(legendOf(raster)).toMatchObject({ kind: "symbol", note: "Fake tiles.", items: [{ color: "#ABCDEF", symbol: "raster" }] });
  });
  it("rejects a declared legend that cannot draw", () => {
    expect(contractProblems(layer({ legend: { kind: "ramp", stops: [{ label: "low" }] } }))).toEqual([expect.stringMatching(/two or more stops/)]);
    expect(contractProblems(layer({ legend: { kind: "image" } }))).toEqual([expect.stringMatching(/imageUrl/)]);
  });
});

describe("contract validation", () => {
  beforeEach(clearRegistry);
  it("accepts every registered layer", () => {
    for (const l of registered) expect(contractProblems(l), l.id).toEqual([]);
  });
  it("refuses bad time, labels and display at registration", () => {
    expect(() => registerLayer(layer({ time: { shape: "snapshots", dates: ["2024", "2021"] } }))).toThrow(/oldest first/);
    expect(() => registerLayer(layer({ labels: { field: "name", max: 0 } }))).toThrow(/max/);
    expect(() => registerLayer(layer({ display: { units: "imperial" as "us" } }))).toThrow(/units/);
  });
});

describe("labelsOf and displayOf", () => {
  it("labels the top five by the card's measure, else nothing", () => {
    expect(labelsOf(layer({ card: { measure: { key: "elevation", label: "Elevation" } } }))).toEqual({ field: "name", max: 5, rankBy: "elevation" });
    expect(labelsOf(base)).toBeUndefined();
    expect(labelsOf(layer({ labels: { field: "name", max: 3, minZoom: 8 } }))).toEqual({ field: "name", max: 3, minZoom: 8 });
  });
  it("shows US units first for US data, metric first elsewhere, local time with its zone", () => {
    expect(displayOf(layer({ coverage: "us" }))).toEqual({ units: "us", secondaryUnits: "metric", timeZone: "local", showZone: true });
    expect(displayOf(layer({ coverage: { bbox: [-125, 32, -114, 42] } })).units).toBe("us");
    expect(displayOf(base).units).toBe("metric");
    expect(displayOf(layer({ display: { timeZone: "utc" } })).timeZone).toBe("utc");
  });
});

describe("cardTitle", () => {
  const quakes = layer({ title: "Earthquakes" });
  it("uses the name first", () => expect(cardTitle(quakes, pt({ name: "Half Dome", kind: "peak" }))).toBe("Half Dome"));
  it("uses kind and nearest place", () => {
    expect(cardTitle(quakes, pt({ kind: "earthquake", place: "10 km WSW of South Lake Tahoe, CA" }))).toBe("Earthquake 10 km WSW of South Lake Tahoe, CA");
    expect(cardTitle(quakes, pt({ kind: "rapid", town: "Fayetteville" }))).toBe("Rapid near Fayetteville");
  });
  it("reads the kind through the layer's levels", () => {
    const l = layer({ attributes: [{ key: "kind", type: "category", label: "Kind", levels: [{ value: "pi", label: "Put-in" }] }] });
    expect(cardTitle(l, pt({ kind: "pi" }), 2)).toBe("Put-in #2");
  });
  it("falls back to the layer and rank, and never says Feature", () => {
    expect(cardTitle(layer({ title: "Wolf packs (Washington)" }), pt({ name: "Feature" }), 3)).toBe("Wolf packs #3");
    expect(cardTitle(quakes, { properties: null })).toBe("Earthquakes");
    expect(cardTitle(layer({ title: "Feature" }), pt({}))).toBe("contract-fake");
  });
});

describe("sourceStatus", () => {
  const memory: Cache = { get: async () => null, set: async () => {} };
  afterEach(() => vi.unstubAllGlobals());

  it("maps 5xx, 429 and other statuses", () => {
    expect(sourceFailureForStatus(503, "https://waterservices.usgs.gov/x")).toMatchObject({ ok: false, reason: "server-error", message: "USGS's server is returning errors (503)." });
    // A host without a known agency is named by its host.
    expect(sourceFailureForStatus(500, "https://tiles.example.org/x")?.message).toBe("tiles.example.org's server is returning errors (500).");
    expect(sourceFailureForStatus(429, "https://a.test")?.reason).toBe("rate-limited");
    expect(sourceFailureForStatus(404, "https://a.test")).toBeNull();
  });

  it("the fetch wrapper reports a 5xx and an unreachable host", async () => {
    const seen: string[] = [];
    const f = createLayerFetch("contract-fetch", { cache: memory, onSourceFailure: (s) => seen.push(s.reason) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 502 })));
    await f("https://a.test/1");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(f("https://a.test/2")).rejects.toThrow();
    expect(seen).toEqual(["server-error", "offline"]);
  });

  it("runLayer copies the first failure onto the answer; a clean answer has none", async () => {
    clearRegistry();
    const fake = layer({
      id: "contract-run",
      query: async (ctx) => {
        const res = await ctx.fetch("https://b.test/q");
        return res.ok ? { kind: "geojson", data: fc([]), citation } : { error: "upstream failed", hint: "upstream" };
      },
    });
    registerLayer(fake);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    const failed = await runLayer("contract-run", { bbox: [-120, 38, -119.9, 38.1] });
    expect(sourceStatusOf(failed.body)).toMatchObject({ ok: false, reason: "server-error" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const ok = await runLayer("contract-run", { bbox: [-120, 38, -119.8, 38.1] });
    expect("sourceStatus" in ok.body).toBe(false);
    expect(sourceStatusOf(ok.body)).toEqual({ ok: true });
  });

  it("an error from a layer under a documented outage says offline since when", async () => {
    clearRegistry();
    registerLayer(layer({ id: "contract-outage", outage: { since: "2026-09-01", reason: "BLM moved the service" }, query: async () => ({ error: "gone", hint: "unavailable" }) }));
    const res = await runLayer("contract-outage", { bbox: [-120, 38, -119.9, 38.1] });
    expect(res.body.sourceStatus).toEqual({ ok: false, reason: "offline", message: "BLM moved the service", since: "2026-09-01" });
  });
});
