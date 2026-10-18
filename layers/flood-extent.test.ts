import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import { contractProblems, legendOf, timeShapeOf } from "./contract";
import layer, { gfmTileUrl, gibsDomainsUrl, lastDomainDay } from "./flood-extent";

const MEMPHIS: [number, number, number, number] = [-90.3, 34.9, -89.8, 35.3];
/** GIBS DescribeDomains answers recorded 2026-10-18 ~06:10 UTC (OPERA HLS ended 2026-10-11; MODIS ran to that day). */
const OPERA_DOMAINS =
  "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><SpaceDomain><BoundingBox crs='urn:ogc:def:crs:EPSG::3857' maxy='20037508.342789' minx='-20037508.342789' miny='-20037508.342789' maxx='20037508.342789'/></SpaceDomain><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2016-01-07/2019-12-31/P1D,2023-01-01/2023-01-04/P1D,2023-01-06/2024-06-02/P1D,2024-06-04/2025-08-06/P1D,2025-08-08/2026-10-11/P1D</Domain><Size>5</Size></DimensionDomain></Domains>";
const MODIS_DOMAINS = OPERA_DOMAINS.replace("2025-08-08/2026-10-11/P1D", "2023-07-26/2026-10-18/P1D");

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: MEMPHIS, zoom: 10, env: {}, fetch: stub as unknown as CachedFetch };
}

function gibs(down = false) {
  return vi.fn(async (url: string, _init?: unknown) => {
    if (down) return new Response("busy", { status: 503 });
    return new Response(url.includes("MODIS") ? MODIS_DOMAINS : OPERA_DOMAINS, { status: 200 });
  });
}

async function tiles(input: Record<string, unknown>, stub = gibs()) {
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("flood-extent layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T06:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("declares global coverage, no env and no area cap", () => {
    expect(layer.id).toBe("flood-extent");
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults to Copernicus GFM radar flood water over the last 12 days ending today, with no upstream call", async () => {
    const stub = gibs();
    const r = await tiles({}, stub);
    expect(stub).not.toHaveBeenCalled();
    const u = new URL(r.data.url.replace("{bbox-epsg-3857}", "0,0,1,1"));
    expect(u.origin + u.pathname).toBe("https://geoserver.gfm.eodc.eu/geoserver/gfm/wms");
    expect(u.searchParams.get("layers")).toBe("observed_flood_extent");
    expect(u.searchParams.get("time")).toBe("P12D/2026-10-18T23:59:59Z");
    expect(r.data).toMatchObject({ minzoom: 7, maxzoom: 14, format: "raster" });
    expect(r.data.time).toEqual({ template: gfmTileUrl("{date}", 12), cadence: "daily", from: "2015-01-01", daysBack: 0 });
    expect(r.coverageNote).toBe("Flood water seen by Sentinel-1 radar from 2026-10-07 to 2026-10-18 (12 days); empty means no flooding seen; visible from about zoom 7 in");
    const short = await tiles({ days: 3, date: "2026-09-30" });
    expect(short.data.url).toContain("time=P3D/2026-09-30T23:59:59Z");
    // The scrubber moves the window's last day; the window keeps its length.
    expect(tileUrlForTime(r.data.url, r.data.time, ["2025-01-01", "2025-05-17T00:00:00Z"], Date.now())).toContain("time=P12D/2025-05-17T23:59:59Z");
  });

  it("reads the newest published day from GIBS for OPERA and MODIS instead of assuming a lag (audit 2026-10-17: the default day was blank)", async () => {
    const stub = gibs();
    const r = await tiles({ source: "opera" }, stub);
    expect(stub.mock.calls[0][0]).toBe(gibsDomainsUrl("OPERA_L3_Dynamic_Surface_Water_Extent-HLS", "GoogleMapsCompatible_Level12"));
    expect(stub.mock.calls[0][1]).toMatchObject({ cacheKey: "gibs-domains:OPERA_L3_Dynamic_Surface_Water_Extent-HLS", ttlSeconds: 10_800 });
    expect(r.data.url).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/OPERA_L3_Dynamic_Surface_Water_Extent-HLS/default/2026-10-11/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png",
    );
    expect(r.data.time).toMatchObject({ from: "2023-01-01", to: "2026-10-11", daysBack: 0 });
    // The scrubber cannot go past the archive's end either.
    expect(tileUrlForTime(r.data.url, r.data.time, ["2026-10-01", "2026-10-18T00:00:00Z"], Date.now())).toContain("/default/2026-10-11/");
    const late = await tiles({ source: "opera", date: "2026-10-15" });
    expect(late.data.url).toContain("/default/2026-10-11/");
    expect(late.coverageNote).toContain("showing 2026-10-11");
    const modis = await tiles({ source: "modis" });
    expect(modis.data.url).toContain("/MODIS_Combined_Flood_1-Day/default/2026-10-18/GoogleMapsCompatible_Level9/");
    expect(modis.data.maxzoom).toBe(9);
  });

  it("falls back to a week's lag for OPERA, and says so, when GIBS does not answer", async () => {
    const r = await tiles({ source: "opera" }, gibs(true));
    expect(r.data.url).toContain("/default/2026-10-11/");
    expect(r.coverageNote).toContain("the day was guessed");
  });

  it("reads the last day of a domains answer", () => {
    expect(lastDomainDay(OPERA_DOMAINS)).toBe("2026-10-11");
    expect(lastDomainDay("<Domain>2026-10-01</Domain>")).toBe("2026-10-01");
    expect(lastDomainDay("<html>busy</html>")).toBeNull();
  });

  it("rejects a date before the archive, an unknown source or date format, and a window over a month", async () => {
    expect(await layer.query(ctx(gibs()), layer.input.parse({ source: "opera", date: "2022-12-31" }))).toMatchObject({ error: expect.stringContaining("2023-01-01") });
    expect(await layer.query(ctx(gibs()), layer.input.parse({ date: "2014-12-31" }))).toMatchObject({ error: expect.stringContaining("2015-01-01") });
    expect(layer.input.safeParse({ source: "sentinel" }).success).toBe(false);
    expect(layer.input.safeParse({ date: "yesterday" }).success).toBe(false);
    expect(layer.input.safeParse({ days: 60 }).success).toBe(false);
  });

  it("names what the color means, continuous daily time, and the user's words", () => {
    expect(contractProblems(layer)).toEqual([]);
    expect(legendOf(layer)).toMatchObject({ kind: "categories", items: [{ label: "Flood water seen by radar" }] });
    expect(timeShapeOf(layer)).toMatchObject({ shape: "continuous", step: "day" });
    for (const word of ["gfm", "opera", "modis", "daily", "flooded", "flood extent", "cloud", "surface-water", "radar"]) {
      expect(layer.description).toContain(word);
    }
  });

  it("summarizes to the tile URL and time range for the model", async () => {
    expect(summarizeLayerResult(await layer.query(ctx(gibs()), layer.input.parse({ source: "opera" })))).toMatchObject({
      kind: "tiles",
      time: { cadence: "daily", from: "2023-01-01", to: "2026-10-11" },
    });
  });

  it("runs through runLayer", async () => {
    expect((await runLayer("flood-extent", { bbox: MEMPHIS, zoom: 10 })).status).toBe(200);
    expect((await runLayer("flood-extent", { bbox: MEMPHIS, input: { source: "x" } })).status).toBe(400);
  });
});
