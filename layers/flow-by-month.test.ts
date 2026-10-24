import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import layer, { flowStrip, parseMonthlyStats, peakWords, type GaugeMonths } from "./flow-by-month";
import iv from "./__fixtures__/flow-by-month.iv-yosemite.json";

/**
 * Fixtures are real USGS answers (2026-10-23): the discharge gauges in a Yosemite Valley box (Happy Isles 8.49 cfs,
 * Pohono Bridge 18.8 cfs), and both gauges' monthly mean flows, trimmed to 2016–2025.
 */
const RDB = readFileSync(new URL("./__fixtures__/flow-by-month.stat-merced.rdb", import.meta.url), "utf8");
const VALLEY: [number, number, number, number] = [-119.75, 37.7, -119.5, 37.78];

function stubFetch(stat = RDB) {
  return vi.fn(async (url: string) => {
    if (url.includes("/nwis/iv/")) return new Response(JSON.stringify(iv));
    if (url.includes("/nwis/stat/")) return new Response(stat);
    return new Response("", { status: 404 });
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = VALLEY) {
  return { bbox, zoom: 12, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "flow-by-month:test" };
}

async function geojson(stub: ReturnType<typeof vi.fn>, input: Record<string, unknown> = {}, bbox = VALLEY) {
  const r = await layer.query(ctx(stub, bbox), layer.input.parse(input));
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("flow-by-month layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T03:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("declares US coverage, no env, a site input and a card led by the highest month's flow", () => {
    expect(layer.id).toBe("flow-by-month");
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.input.parse({ site: "11266500" })).toEqual({ site: "11266500" });
    expect(layer.input.parse({ site: "USGS-11266500" })).toEqual({ site: "USGS-11266500" });
    expect(() => layer.input.parse({ site: "Merced" })).toThrow();
    expect(layer.card?.measure).toMatchObject({ key: "v", unit: "cfs" });
    expect(layer.description).toMatch(/when is the river highest/);
  });

  it("parses the monthly report into each gauge's median by calendar month over its years", () => {
    const stats = parseMonthlyStats(RDB);
    expect([...stats.keys()].sort()).toEqual(["11264500", "11266500"]);
    const pohono = stats.get("11266500") as GaugeMonths;
    expect(pohono).toMatchObject({ firstYear: 2016, lastYear: 2025, years: 10 });
    expect(pohono.medianCfs).toHaveLength(12);
    // Medians worked out from the fixture by hand: May 2,126.5, June 1,138.75, September 34.8.
    expect(pohono.medianCfs[4]).toBe(2127);
    expect(pohono.medianCfs[5]).toBe(1139);
    expect(pohono.medianCfs[8]).toBe(34.8);
    expect(stats.get("11264500")?.medianCfs[4]).toBe(1215);
    expect(parseMonthlyStats("# nothing\n").size).toBe(0);
  });

  it("names a neighbouring month close to the peak", () => {
    const m: GaugeMonths = { siteNo: "1", medianCfs: [1, 1, 1, 100, 2000, 1900, 50, 1, 1, 1, 1, 1], meanCfs: [], firstYear: 1990, lastYear: 2020, years: 31 };
    expect(peakWords(m)).toBe("May, median 2,000 cfs for the month (June close behind at 1,900 cfs)");
    expect(peakWords({ ...m, medianCfs: m.medianCfs.map((v, i) => (i === 5 ? 900 : v)) })).toBe("May, median 2,000 cfs for the month");
    expect(flowStrip("River", m).rows[0]).toMatchObject({ kind: "bars", unit: "cfs", legend: "Bars: median of each month's mean flow, 1990–2020 (31 years)" });
  });

  it("answers Yosemite Valley: the larger river first, its peak and low months in cfs, the strip of its months", async () => {
    const stub = stubFetch();
    const r = await geojson(stub);
    const urls = stub.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("parameterCd=00060");
    expect(urls[1]).toBe("https://waterservices.usgs.gov/nwis/stat/?format=rdb&sites=11264500,11266500&statReportType=monthly&statTypeCd=mean&parameterCd=00060");
    expect(r.data.features.map((f) => f.properties?.name)).toEqual(["Merced River at Pohono Bridge near Yosemite, CA", "Merced River at Happy Isles Bridge near Yosemite, CA"]);
    const top = r.data.features[0].properties;
    expect(top).toMatchObject({ siteNo: "11266500", v: 2127, peak: "May: 2,127 cfs", peakMonth: "May", nowCfs: 18.8, period: "2016–2025 (10 years)" });
    expect(r.coverageNote).toMatch(/^Merced River at Pohono Bridge near Yosemite, CA \(USGS 11266500\) runs highest in May, median 2,127 cfs for the month/);
    expect(r.coverageNote).toContain("By month (median cfs): Jan");
    expect(r.coverageNote).toContain("Other gauges: Merced River at Happy Isles Bridge near Yosemite, CA: highest in May, 1,215 cfs");
    expect(r.months).toMatchObject({ place: "Merced River at Pohono Bridge near Yosemite, CA", period: "2016–2025" });
    expect(r.months?.rows[0]).toMatchObject({ kind: "bars", key: "flow" });
  });

  it("site picks one gauge", async () => {
    const r = await geojson(stubFetch(), { site: "USGS-11264500" });
    expect(r.data.features.map((f) => f.properties?.siteNo)).toEqual(["11264500"]);
  });

  it("answers empty outside the US and when no gauge has a record, and errors when the statistics service fails", async () => {
    const out = await geojson(stubFetch(), {}, [7, 46, 8, 47]);
    expect(out.data.features).toEqual([]);
    expect(out.coverageNote).toMatch(/outside the United States/);
    const none = await geojson(stubFetch("# no data\n"));
    expect(none.coverageNote).toMatch(/no monthly flow record/);
    const down = vi.fn(async (url: string) => (url.includes("/nwis/iv/") ? new Response(JSON.stringify(iv)) : new Response("", { status: 503 })));
    expect(await layer.query(ctx(down), {})).toMatchObject({ hint: "upstream" });
  });
});
