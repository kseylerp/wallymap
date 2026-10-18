import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureCollection, Geometry, MultiPolygon, Polygon, Position } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { attributeProblems } from "./attributes";
import { contractProblems, legendOf } from "./contract";
import layer, { clipGeometry, clipRing, normalizeDrought, paddedBbox, simplifyOffset, weekChunks, weekDates } from "./drought";
import rowsRaw from "./__fixtures__/drought.fourcorners.json";
import latestRaw from "./__fixtures__/drought.latest.json";

const rows = rowsRaw as unknown as FeatureCollection;
const FOUR_CORNERS: [number, number, number, number] = [-111, 36, -109, 37.5];
const LATEST = 1791244800000; // 2026-10-06, a Tuesday
const WEEK = 7 * 86_400_000;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = FOUR_CORNERS, cacheKey?: string) {
  return { bbox, zoom: 8, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

/** Answers the max(ddate) statistics call with the recorded response and every other call with `rowBody`. */
function serviceStub(rowBody: unknown = rows, latestBody: unknown = latestRaw) {
  return vi.fn(async (url: string) => (url.includes("outStatistics") ? json(latestBody) : json(rowBody)));
}

function allPositions(g: Geometry): Position[] {
  if (g.type === "Polygon") return g.coordinates.flat();
  if (g.type === "MultiPolygon") return g.coordinates.flat(2);
  return [];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("drought layer", () => {
  it("declares US coverage, a license that flags the Esri-hosted copy, no env and the weeks input", () => {
    expect(layer.id).toBe("drought");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toMatch(/NDMC/);
    expect(layer.license).toMatch(/Esri/);
    expect(layer.license).not.toMatch(/free to use/i);
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(16_000_000);
    expect(layer.input.parse({})).toEqual({ weeks: 1 });
    expect(layer.input.safeParse({ weeks: 13 }).success).toBe(false);
    expect(layer.input.safeParse({ weeks: 0 }).success).toBe(false);
    expect(layer.style).toMatchObject({ geometry: "polygon" });
  });

  it("lists weekly dates newest first and splits them so no request exceeds 10 weeks", () => {
    expect(weekDates(LATEST, 3)).toEqual([LATEST, LATEST - WEEK, LATEST - 2 * WEEK]);
    expect(weekChunks(weekDates(LATEST, 1))).toEqual([{ from: LATEST, to: LATEST }]);
    const chunks = weekChunks(weekDates(LATEST, 12));
    expect(chunks).toEqual([
      { from: LATEST - 9 * WEEK, to: LATEST },
      { from: LATEST - 11 * WEEK, to: LATEST - 10 * WEEK },
    ]);
  });

  it("pads the view by a tenth each side without leaving the world, and simplifies coarser for wide views", () => {
    expect(paddedBbox([-111, 36, -109, 37.5])).toEqual([-111.2, 35.85, -108.8, 37.65]);
    expect(paddedBbox([-180, -90, 180, 90])).toEqual([-180, -90, 180, 90]);
    expect(simplifyOffset([-111, 36, -110.8, 36.2])).toBe(0.005);
    expect(simplifyOffset([-111, 36, -109, 37.5])).toBe(0.013);
    expect(simplifyOffset([-125, 24, -66, 50])).toBe(0.12);
    // State scale keeps the categories on the land (audit 2026-10-17: triangles spilling into Mexico and the Gulf at 0.25°).
    expect(simplifyOffset([-106.7, 25.8, -93.5, 36.5])).toBe(0.088);
  });

  it("colors the categories D0 to D4 on the ordinal ramp, with the chips and key from the same levels (audit 2026-10-17: one hatch)", () => {
    expect(layer.style.encode).toEqual({ color: "kind" });
    expect(attributeProblems(layer)).toEqual([]);
    expect(contractProblems(layer)).toEqual([]);
    expect(legendOf(layer).items?.map((i) => i.value)).toEqual(["D0", "D1", "D2", "D3", "D4"]);
  });

  it("clips a ring to the bbox and rounds to three decimals", () => {
    const ring: Position[] = [[-1, -1], [3, -1], [3, 3], [-1, 3], [-1, -1]];
    const clipped = clipRing(ring, [0, 0, 2, 2]);
    expect(clipped).not.toBeNull();
    const xs = clipped!.map((p) => p[0]);
    const ys = clipped!.map((p) => p[1]);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(2);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(2);
    expect(clipped![0]).toEqual(clipped![clipped!.length - 1]);

    expect(clipRing([[0.12345, 0.5], [1.6789, 0.5], [1.6789, 1.5], [0.12345, 0.5]], [0, 0, 2, 2])).toEqual([
      [0.123, 0.5],
      [1.679, 0.5],
      [1.679, 1.5],
      [0.123, 0.5],
    ]);
  });

  it("drops rings and polygons that miss the bbox, keeps the ones that touch it", () => {
    const far: Position[] = [[10, 10], [11, 10], [11, 11], [10, 10]];
    expect(clipRing(far, [0, 0, 2, 2])).toBeNull();
    const near: Polygon = { type: "Polygon", coordinates: [[[1, 1], [3, 1], [3, 3], [1, 1]]] };
    const multi: MultiPolygon = { type: "MultiPolygon", coordinates: [near.coordinates, [far]] };
    const clipped = clipGeometry(multi, [0, 0, 2, 2]);
    expect(clipped?.type).toBe("MultiPolygon");
    expect((clipped as MultiPolygon).coordinates).toHaveLength(1);
    expect(clipGeometry({ type: "Polygon", coordinates: [far] }, [0, 0, 2, 2])).toBeNull();
    expect(clipGeometry({ type: "Point", coordinates: [1, 1] }, [0, 0, 2, 2])).toBeNull();
    expect(clipGeometry(null, [0, 0, 2, 2])).toBeNull();
  });

  it("normalizes service rows to clipped category polygons with kind, v, t and week", () => {
    const bbox = paddedBbox(FOUR_CORNERS);
    const fc = normalizeDrought(rows, bbox);
    // The 2026-09-29 D0 area lies wholly outside this view, so five of the six recorded rows remain.
    expect(fc.features).toHaveLength(5);
    for (const f of fc.features) {
      for (const [x, y] of allPositions(f.geometry)) {
        expect(x).toBeGreaterThanOrEqual(bbox[0]);
        expect(x).toBeLessThanOrEqual(bbox[2]);
        expect(y).toBeGreaterThanOrEqual(bbox[1]);
        expect(y).toBeLessThanOrEqual(bbox[3]);
      }
    }
    // Newest week first, mildest category first within a week.
    expect(fc.features.map((f) => `${f.properties?.week}:${f.properties?.kind}`)).toEqual([
      "2026-10-06:D0",
      "2026-10-06:D1",
      "2026-10-06:D2",
      "2026-09-29:D1",
      "2026-09-29:D2",
    ]);
    expect(fc.features[2].properties).toEqual({
      kind: "D2",
      category: "Severe drought",
      v: 2,
      t: "2026-10-06T00:00:00.000Z",
      week: "2026-10-06",
    });
  });

  it("skips rows with no geometry, a bad category or no date", () => {
    const square: Polygon = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const fc = normalizeDrought(
      {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: square, properties: { dm: 9, ddate: LATEST } },
          { type: "Feature", geometry: square, properties: { dm: 1 } },
          { type: "Feature", geometry: null as never, properties: { dm: 1, ddate: LATEST } },
          { type: "Feature", geometry: square, properties: { dm: 4, ddate: LATEST } },
        ],
      },
      [-1, -1, 2, 2],
    );
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toMatchObject({ kind: "D4", category: "Exceptional drought" });
  });

  it("finds the newest week, then asks for that one week over the padded view with simplification", async () => {
    const stub = serviceStub();
    const r = await layer.query(ctx(stub, FOUR_CORNERS, "drought:k"), { weeks: 1 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");

    const calls = stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }][];
    expect(calls).toHaveLength(2);
    const stats = new URL(calls[0][0]);
    expect(stats.origin + stats.pathname).toBe(
      "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/US_Drought_Intensity_v1/FeatureServer/2/query",
    );
    expect(JSON.parse(stats.searchParams.get("outStatistics") ?? "[]")).toEqual([
      { statisticType: "max", onStatisticField: "ddate", outStatisticFieldName: "latest" },
    ]);
    expect(calls[0][1].cacheKey).toBe("drought:usdm-latest");

    const q = new URL(calls[1][0]);
    expect(q.searchParams.get("where")).toBe("ddate >= timestamp '2026-10-06 00:00:00' AND ddate <= timestamp '2026-10-06 00:00:00'");
    expect(q.searchParams.get("geometry")).toBe(paddedBbox(FOUR_CORNERS).join(","));
    expect(q.searchParams.get("outFields")).toBe("dm,ddate");
    expect(q.searchParams.get("maxAllowableOffset")).toBe("0.013");
    expect(calls[1][1].cacheKey).toBe("drought:k:usdm-2026-10-06-2026-10-06");
    expect(calls[1][1].ttlSeconds).toBe(6 * 3600);

    expect(r.data.features).toHaveLength(5);
    expect(r.coverageNote).toBeUndefined();
    expect(r.citation.source).toContain("Drought Monitor");
  });

  it("asks for 12 weeks in two requests so the service's 52-row cap is never hit", async () => {
    const stub = serviceStub();
    await layer.query(ctx(stub), { weeks: 12 });
    const wheres = (stub.mock.calls as unknown as [string][])
      .map(([u]) => new URL(u))
      .filter((u) => !u.searchParams.has("outStatistics"))
      .map((u) => u.searchParams.get("where"));
    expect(wheres).toHaveLength(2);
    expect(wheres).toContain("ddate >= timestamp '2026-08-04 00:00:00' AND ddate <= timestamp '2026-10-06 00:00:00'");
    expect(wheres).toContain("ddate >= timestamp '2026-07-21 00:00:00' AND ddate <= timestamp '2026-07-28 00:00:00'");
  });

  it("keeps what loaded and notes it when only one chunk of weeks fails", async () => {
    let chunk = 0;
    const stub = vi.fn(async (url: string) => {
      if (url.includes("outStatistics")) return json(latestRaw);
      return ++chunk === 1 ? json(rows) : new Response("down", { status: 500 });
    });
    const r = await layer.query(ctx(stub), { weeks: 12 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(5);
    expect(r.coverageNote).toMatch(/older weeks could not be loaded/);
  });

  it("says when the area has no drought, and when the newest map is stale", async () => {
    const none = await layer.query(ctx(serviceStub({ type: "FeatureCollection", features: [] })), { weeks: 1 });
    if (!("kind" in none) || none.kind !== "geojson") throw new Error("expected geojson");
    expect(none.data.features).toEqual([]);
    expect(none.coverageNote).toMatch(/No part of this area is in drought/);

    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const stale = await layer.query(ctx(serviceStub()), { weeks: 1 });
    if (!("kind" in stale) || stale.kind !== "geojson") throw new Error("expected geojson");
    expect(stale.coverageNote).toMatch(/newest drought map available is from 2026-10-06/);
  });

  it("maps upstream failures to upstream errors", async () => {
    const down = vi.fn(async () => new Response("nope", { status: 503 }));
    expect(await layer.query(ctx(down), { weeks: 1 })).toMatchObject({ hint: "upstream" });

    const noDate = serviceStub(rows, { features: [{ attributes: { latest: null } }] });
    expect(await layer.query(ctx(noDate), { weeks: 1 })).toMatchObject({ hint: "upstream" });

    const arcgisError = serviceStub({ error: { code: 400, message: "Unable to complete operation." } });
    expect(await layer.query(ctx(arcgisError), { weeks: 1 })).toMatchObject({
      hint: "upstream",
      error: expect.stringContaining("Unable to complete operation."),
    });

    const offline = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await layer.query(ctx(offline), { weeks: 1 })).toMatchObject({ hint: "upstream" });
  });

  it("returns a coverage note without calling upstream outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, [2, 45, 3, 46]), { weeks: 1 });
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toEqual([]);
    expect(r.coverageNote).toMatch(/outside the United States/i);
  });

  it("is registered, validates weeks and rejects an oversized area through runLayer", async () => {
    expect((await runLayer("drought", { bbox: FOUR_CORNERS, input: { weeks: 13 } })).status).toBe(400);
    expect((await runLayer("drought", { bbox: [-170, 20, -60, 70] })).status).toBe(422);
  });

  it("describes drought in the words people use, the categories, and the weeks input", () => {
    expect(layer.description).toMatch(/drought/i);
    for (const category of ["D0", "D4"]) expect(layer.description).toContain(category);
    expect(layer.description).toMatch(/weeks/);
    expect(layer.description).toMatch(/not a measurement at a point/);
  });
});
