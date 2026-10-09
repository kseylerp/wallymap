import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { parseFirmsCsv } from "./fire-detections";

const CSV = readFileSync(path.join(__dirname, "__fixtures__/fire-detections.sample.csv"), "utf8");
const BBOX: [number, number, number, number] = [-125, 32, -114, 42];
const KEY = "TESTKEY0000000000000000000000000";

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: BBOX, zoom: 6, env: { FIRMS_MAP_KEY: KEY }, fetch: stub as unknown as CachedFetch, cacheKey };
}

const INPUT = { days: 3, source: "VIIRS_SNPP_NRT" } as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseFirmsCsv", () => {
  it("parses the fixture into points with t, v, confidence and daynight", () => {
    const fc = parseFirmsCsv(CSV);
    expect(fc.features).toHaveLength(100);
    const first = fc.features[0];
    expect(first.geometry).toEqual({ type: "Point", coordinates: [-121.93367, 37.45572] });
    expect(first.properties).toEqual({
      t: "2026-10-05T09:30:00Z",
      v: 0.63,
      confidence: "n",
      daynight: "N",
    });
  });

  it("formats acq_time with zero padding", () => {
    const csv = [
      "latitude,longitude,acq_date,acq_time,frp,confidence,daynight",
      "40,-120,2026-10-05,342,2.5,h,D",
      "40,-120,2026-10-05,1342,3,n,D",
      "40,-120,2026-10-05,5,1,l,N",
      "40,-120,2026-10-05,0,1,l,N",
    ].join("\n");
    const times = parseFirmsCsv(csv).features.map((f) => f.properties?.t);
    expect(times).toEqual([
      "2026-10-05T03:42:00Z",
      "2026-10-05T13:42:00Z",
      "2026-10-05T00:05:00Z",
      "2026-10-05T00:00:00Z",
    ]);
  });

  it("keeps numeric MODIS confidence as a number and tolerates CRLF and a trailing blank line", () => {
    const csv =
      "latitude,longitude,acq_date,acq_time,frp,confidence,daynight\r\n40,-120,2026-10-05,1342,3.1,85,D\r\n\r\n";
    const fc = parseFirmsCsv(csv);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toMatchObject({ confidence: 85, v: 3.1, daynight: "D" });
  });

  it("skips rows without a usable date or time", () => {
    const csv = [
      "latitude,longitude,acq_date,acq_time,frp,confidence,daynight",
      "40,-120,,1342,3,n,D",
      "40,-120,2026-10-05,99,3,n,D",
      "40,-120,2026-10-05,2575,3,n,D",
      "40,-120,2026-10-05,1342,3,n,D",
    ].join("\n");
    expect(parseFirmsCsv(csv).features).toHaveLength(1);
  });

  it("skips rows with bad coordinates and returns an empty collection for a header-only body", () => {
    const header = "latitude,longitude,acq_date,acq_time,frp,confidence,daynight";
    expect(parseFirmsCsv(`${header}\n`).features).toHaveLength(0);
    expect(parseFirmsCsv("").features).toHaveLength(0);
    expect(parseFirmsCsv(`${header}\nabc,-120,2026-10-05,1342,3,n,D\n40,,2026-10-05,1342,3,n,D`).features).toHaveLength(0);
  });
});

describe("fire-detections layer", () => {
  it("declares the key it needs and global coverage", () => {
    expect(layer.requiredEnv).toContain("FIRMS_MAP_KEY");
    expect(layer.coverage).toBe("global");
    expect(layer.maxAreaKm2).toBe(2_000_000);
  });

  it("requests the FIRMS area CSV endpoint with a timeout and a cache key", async () => {
    const stub = vi.fn(async () => new Response(CSV, { status: 200 }));
    const r = await layer.query(ctx(stub, "fire-detections:k"), { days: 3, source: "MODIS_NRT" });
    expect(r).toMatchObject({ kind: "geojson" });
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit & { cacheKey?: string }];
    expect(url).toBe(
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/MODIS_NRT/-125,32,-114,42/3`,
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.cacheKey).toBe("fire-detections:k:firms");
    expect((init as { ttlSeconds?: number }).ttlSeconds).toBe(1800);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(100);
    expect(r.citation.source).toContain("NASA FIRMS");
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("maps a body starting with Invalid to an upstream error carrying that line", async () => {
    const stub = vi.fn(async () => new Response("Invalid MAP_KEY.\nsecond line", { status: 200 }));
    const r = await layer.query(ctx(stub), INPUT);
    expect(r).toEqual({ error: "FIRMS rejected the request: Invalid MAP_KEY.", hint: "upstream" });
  });

  it("maps a 400 with an Invalid body to an upstream error carrying that line", async () => {
    const stub = vi.fn(async () => new Response("Invalid MAP_KEY.", { status: 400 }));
    const r = await layer.query(ctx(stub), INPUT);
    expect(r).toMatchObject({ hint: "upstream" });
    expect((r as { error: string }).error).toContain("Invalid MAP_KEY.");
  });

  it("treats a 200 HTML body as an upstream error, not as zero fires", async () => {
    const html = "<!DOCTYPE html><html><head><title>Maintenance</title></head><body>Back soon</body></html>\nmore";
    const stub = vi.fn(async () => new Response(html, { status: 200 }));
    const r = await layer.query(ctx(stub), INPUT);
    expect(r).toEqual({
      error: `FIRMS returned an unexpected response: ${html.split("\n")[0].slice(0, 80)}`,
      hint: "upstream",
    });
  });

  it("returns an empty collection for an empty 200 body or a header-only CSV", async () => {
    for (const body of ["", "latitude,longitude,acq_date,acq_time,frp,confidence,daynight\n"]) {
      const stub = vi.fn(async () => new Response(body, { status: 200 }));
      const r = await layer.query(ctx(stub), INPUT);
      if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
      expect(r.data.features).toHaveLength(0);
      expect(r.coverageNote).toBeUndefined();
    }
  });

  it("caps output at the 5,000 strongest detections and says so", async () => {
    const rows = ["latitude,longitude,acq_date,acq_time,frp,confidence,daynight"];
    for (let i = 0; i < 5001; i++) rows.push(`40,-120,2026-10-05,1342,${i},n,D`);
    const stub = vi.fn(async () => new Response(rows.join("\n"), { status: 200 }));
    const r = await layer.query(ctx(stub), INPUT);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(5000);
    expect(r.coverageNote).toBe("Showing the 5,000 strongest detections");
    const values = r.data.features.map((f) => f.properties?.v as number);
    expect(Math.max(...values)).toBe(5000);
    expect(Math.min(...values)).toBe(1); // the weakest (v = 0) was dropped
  });

  it("does not add a note at exactly 5,000 points", async () => {
    const rows = ["latitude,longitude,acq_date,acq_time,frp,confidence,daynight"];
    for (let i = 0; i < 5000; i++) rows.push(`40,-120,2026-10-05,1342,${i},n,D`);
    const stub = vi.fn(async () => new Response(rows.join("\n"), { status: 200 }));
    const r = await layer.query(ctx(stub), INPUT);
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(5000);
    expect(r.coverageNote).toBeUndefined();
  });

  it("maps a non-2xx response to an upstream error", async () => {
    const stub = vi.fn(async () => new Response("down", { status: 503 }));
    const r = await layer.query(ctx(stub), INPUT);
    expect(r).toEqual({ error: "FIRMS returned 503", hint: "upstream" });
  });

  it("maps a thrown timeout to an upstream error", async () => {
    const stub = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const r = await layer.query(ctx(stub), INPUT);
    expect(r).toMatchObject({ hint: "upstream" });
    expect((r as { error: string }).error).toContain("timed out");
  });

  it("reports unavailable without calling upstream when the key is missing from the context", async () => {
    const stub = vi.fn();
    const r = await layer.query(
      { bbox: BBOX, zoom: 6, env: {}, fetch: stub as unknown as CachedFetch },
      INPUT,
    );
    expect(r).toMatchObject({ hint: "unavailable" });
    expect(stub).not.toHaveBeenCalled();
  });

  it("returns 503 unavailable from runLayer when FIRMS_MAP_KEY is unset", async () => {
    vi.stubEnv("FIRMS_MAP_KEY", "");
    const res = await runLayer("fire-detections", { bbox: BBOX });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ hint: "unavailable" });
  });

  it("returns 422 zoom_in from runLayer for a bbox over 2,000,000 km2", async () => {
    vi.stubEnv("FIRMS_MAP_KEY", KEY);
    const res = await runLayer("fire-detections", { bbox: [-130, 20, -90, 60] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in" });
  });

  it("rejects an unknown source or out-of-range days through runLayer", async () => {
    vi.stubEnv("FIRMS_MAP_KEY", KEY);
    expect((await runLayer("fire-detections", { bbox: BBOX, input: { days: 6 } })).status).toBe(400);
    expect((await runLayer("fire-detections", { bbox: BBOX, input: { source: "GOES" } })).status).toBe(400);
  });
});
