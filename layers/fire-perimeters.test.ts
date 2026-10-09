import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { historyWhere, normalizeFirePerimeters, wfigsWhere } from "./fire-perimeters";
import raw from "./__fixtures__/fire-perimeters.tahoe.json";
import type { FeatureCollection } from "geojson";

const fixture = raw as unknown as { history: FeatureCollection; wfigs: FeatureCollection };

const CALDOR_AREA: [number, number, number, number] = [-120.6, 38.6, -119.8, 39.3];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Answers the history service with the history fixture and the WFIGS service with the WFIGS fixture. */
function routedStub() {
  return vi.fn(async (url: string) =>
    json(url.includes("InterAgencyFirePerimeterHistory_All_Years_View") ? fixture.history : fixture.wfigs),
  );
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: CALDOR_AREA, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function whereOf(url: unknown): string {
  return new URL(String(url)).searchParams.get("where") ?? "";
}

describe("fire-perimeters layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes both services to polygons with t, v, name, year and acres", () => {
    const fc = normalizeFirePerimeters(fixture.history, fixture.wfigs);
    expect(fc.features.length).toBeGreaterThan(0);
    for (const f of fc.features) {
      expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
      const p = f.properties ?? {};
      expect(typeof p.name).toBe("string");
      expect(typeof p.year).toBe("number");
      expect(typeof p.acres).toBe("number");
      expect(p.v).toBe(p.acres);
      expect(typeof p.t).toBe("string");
      expect(new Date(p.t).toISOString()).toBe(p.t);
    }

    const caldor = fc.features.find((f) => f.properties?.name === "Caldor");
    expect(caldor?.properties).toMatchObject({ year: 2021, acres: 221783.9, agency: "USFS" });
    expect(caldor?.properties?.t).toBe("2021-08-15T01:54:24.000Z");

    // History rows only carry a year, so t falls back to January 1.
    const voltaire = fc.features.find((f) => f.properties?.name === "Voltaire");
    expect(voltaire?.properties).toMatchObject({ year: 2018, t: "2018-01-01T00:00:00.000Z", agency: "USFS" });
  });

  it("drops the duplicate history rows that share an IRWIN id", () => {
    const fc = normalizeFirePerimeters(fixture.history, { type: "FeatureCollection", features: [] });
    const littleValley = fc.features.filter((f) => f.properties?.name === "Little Valley");
    expect(littleValley).toHaveLength(1);
  });

  it("keeps the most recent perimeter for a fire that has daily and final polygons", () => {
    const feature = (category: string, acres: number, current: number) => ({
      type: "Feature" as const,
      geometry: { type: "Polygon" as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      properties: {
        poly_IncidentName: "Test",
        poly_IRWINID: "{X}",
        poly_GISAcres: acres,
        poly_DateCurrent: current,
        poly_FeatureCategory: category,
        attr_FireDiscoveryDateTime: Date.UTC(2023, 6, 1),
      },
    });
    const wfigs = {
      type: "FeatureCollection" as const,
      features: [feature("Wildfire Daily Fire Perimeter", 100, 1000), feature("Wildfire Final Fire Perimeter", 900, 2000)],
    };
    const fc = normalizeFirePerimeters({ type: "FeatureCollection", features: [] }, wfigs);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties?.acres).toBe(900);
  });

  it("builds a history where clause from the verified year and acre fields", () => {
    expect(historyWhere(2016, 100)).toBe(
      "FIRE_YEAR_INT >= 2016 AND FIRE_YEAR_INT < 2020 AND GIS_ACRES >= 100 AND (FEATURE_CA <> 'Prescribed Fire' OR FEATURE_CA IS NULL)",
    );
    expect(wfigsWhere(2021, 250)).toBe(
      "attr_FireDiscoveryDateTime >= DATE '2021-01-01' AND poly_GISAcres >= 250 AND attr_IncidentTypeCategory = 'WF'",
    );
  });

  it("asks the history service for FIRE_YEAR_INT >= 2016 when yearsBack is 10", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub), { yearsBack: 10, minAcres: 100 });
    expect(r).toMatchObject({ kind: "geojson" });

    const urls = stub.mock.calls.map((c) => String(c[0]));
    const history = urls.find((u) => u.includes("InterAgencyFirePerimeterHistory_All_Years_View"));
    const wfigs = urls.find((u) => u.includes("WFIGS_Interagency_Perimeters"));
    expect(whereOf(history)).toContain("FIRE_YEAR_INT >= 2016");
    expect(whereOf(history)).toContain("GIS_ACRES >= 100");
    expect(whereOf(wfigs)).toContain("DATE '2020-01-01'");
    expect(new URL(String(history)).searchParams.get("maxAllowableOffset")).toBe("0.0005");
  });

  it("with yearsBack 7 queries history for 2019 and WFIGS from 2020, largest first, with a 1 hour cache", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub), { yearsBack: 7, minAcres: 100 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBeUndefined();
    const calls = stub.mock.calls as unknown as [string, RequestInit & { ttlSeconds?: number }][];
    expect(calls).toHaveLength(2);
    const history = calls.find(([u]) => u.includes("InterAgencyFirePerimeterHistory_All_Years_View"));
    const wfigs = calls.find(([u]) => u.includes("WFIGS_Interagency_Perimeters"));
    if (!history || !wfigs) throw new Error("expected both services to be called");
    expect(whereOf(history[0])).toContain("FIRE_YEAR_INT >= 2019");
    expect(whereOf(wfigs[0])).toContain("DATE '2020-01-01'");
    expect(new URL(history[0]).searchParams.get("orderByFields")).toBe("GIS_ACRES DESC");
    expect(new URL(wfigs[0]).searchParams.get("orderByFields")).toBe("poly_GISAcres DESC");
    expect(wfigs[1].ttlSeconds).toBe(3600);
    expect(r.data.features.some((f) => f.properties?.name === "Caldor")).toBe(true);
  });

  it("adds a coverage note when a service reports it capped the result", async () => {
    const stub = vi.fn(async (url: string) =>
      json(
        url.includes("WFIGS_Interagency_Perimeters")
          ? { ...fixture.wfigs, exceededTransferLimit: true }
          : fixture.history,
      ),
    );
    const r = await layer.query(ctx(stub), { yearsBack: 10, minAcres: 100 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toBe("Showing the 2,000 largest fires; zoom in for all");
    expect(r.data.features.length).toBeGreaterThan(0);
  });

  it("skips the stale history service when the window starts in 2020 or later", async () => {
    const stub = routedStub();
    await layer.query(ctx(stub), { yearsBack: 5, minAcres: 100 });
    const urls = stub.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("WFIGS_Interagency_Perimeters");
    expect(whereOf(urls[0])).toContain("DATE '2021-01-01'");
  });

  it("returns a cited FeatureCollection with Caldor in the window", async () => {
    const r = await layer.query(ctx(routedStub(), "fire-perimeters:k"), { yearsBack: 10, minAcres: 100 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.some((f) => f.properties?.name === "Caldor")).toBe(true);
    expect(r.citation.source).toContain("NIFC");
  });

  it("maps a 200 with an ArcGIS error body to an upstream error", async () => {
    const stub = vi.fn(async () => json({ error: { code: 400, message: "Unable to complete operation." } }));
    const r = await layer.query(ctx(stub), { yearsBack: 10, minAcres: 100 });
    expect(r).toMatchObject({ hint: "upstream" });
    expect((r as { error: string }).error).toContain("Unable to complete operation.");
  });

  it("maps a non-2xx response to an upstream error", async () => {
    const stub = vi.fn(async () => new Response("nope", { status: 500 }));
    const r = await layer.query(ctx(stub), { yearsBack: 10, minAcres: 100 });
    expect(r).toMatchObject({ hint: "upstream" });
  });

  it("returns a coverage note without calling upstream when the bbox is outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query(
      { bbox: [2, 45, 3, 46], zoom: 9, env: {}, fetch: stub as unknown as CachedFetch },
      { yearsBack: 10, minAcres: 100 },
    );
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toBe("No data outside the United States");
  });

  it("rejects an oversized bbox with zoom_in through runLayer", async () => {
    const res = await runLayer("fire-perimeters", { bbox: [-125, 32, -110, 45], zoom: 5 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ hint: "zoom_in" });
  });

  it("rejects out-of-range input through runLayer", async () => {
    const res = await runLayer("fire-perimeters", { bbox: CALDOR_AREA, input: { yearsBack: 99 } });
    expect(res.status).toBe(400);
  });
});
