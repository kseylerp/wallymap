import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { clearMapCache } from "@/lib/ee/client";
import { clearTokenCache } from "@/lib/ee/auth";
import { boxAreaM2, readRegions } from "@/lib/ee/ecoregions";
import { toExpression } from "@/lib/ee/expr";
import { regionsExpression } from "@/lib/ee/ecoregions";
import { fakeEeFetch, testEnv } from "@/lib/ee/__fixtures__/fakeEe";
import recorded from "@/lib/ee/__fixtures__/living-cover.json";
import layer, { regionsSentence } from "./ecoregions";
import { contractProblems, labelsOf, legendOf } from "./contract";
import type { LayerResult } from "./types";

const SMOKIES: [number, number, number, number] = [-84.0, 35.42, -83.1, 35.8];
const SABAH: [number, number, number, number] = [117.6, 4.8, 118.0, 5.1];

function ctx(bbox = SMOKIES) {
  return { bbox, zoom: 10, env: testEnv(), fetch: vi.fn() as unknown as CachedFetch };
}

describe("ecoregions layer", () => {
  let fake: ReturnType<typeof fakeEeFetch>;
  beforeEach(() => {
    clearMapCache();
    clearTokenCache();
    fake = fakeEeFetch({ compute: (expression) => (JSON.stringify(expression).includes("RESOLVE") ? recorded.resolveSabah : recorded.ecoregionsSmokiesL3) });
    vi.stubGlobal("fetch", fake.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("declares outline-only levels, six name labels and a card", () => {
    expect(contractProblems(layer)).toEqual([]);
    expect(legendOf(layer).items?.every((i) => i.symbol === "line")).toBe(true);
    expect(labelsOf(layer)).toMatchObject({ field: "name", max: 6 });
    expect(layer.card?.facts?.map((f) => f.label)).toEqual(["Level", "Share of view", "Area in view", "Within"]);
  });

  it("sends the clip as a mapped function whose body is its own value", () => {
    const wire = toExpression(regionsExpression("epa3", SMOKIES));
    const text = JSON.stringify(wire);
    expect(text).toContain('"functionDefinitionValue":{"argumentNames":["_MAPPING_VAR_0_0"],"body":"');
    expect(text).toContain('"argumentReference":"_MAPPING_VAR_0_0"');
    expect(text).toContain('"leftField":{"constantValue":".geo"}');
  });

  it("answers EPA Level III outlines in the lower 48, named with their share of the box and the place", async () => {
    const r = (await layer.query(ctx(), layer.input.parse({ place: "Great Smoky Mountains" }))) as Extract<LayerResult, { kind: "geojson" }>;
    expect(r.kind).toBe("geojson");
    expect(r.coverageNote).toBe("EPA Level III ecoregions, share of the box in the box asked for Great Smoky Mountains: Blue Ridge 93%, Ridge and Valley 7%");
    expect(r.data.features.map((f) => f.properties?.name)).toEqual(["Blue Ridge", "Ridge and Valley"]);
    expect(r.data.features[0].properties).toMatchObject({ level: "3", levelLabel: "EPA Level III ecoregion", code: "66", share: 0.928 });
    expect(r.data.features[0].properties?.area).toMatch(/^3,1\d\d km² \(1,2\d\d sq mi\)$/);
  });

  it("answers RESOLVE outside the US", async () => {
    const r = (await layer.query(ctx(SABAH), layer.input.parse({}))) as Extract<LayerResult, { kind: "geojson" }>;
    expect(r.coverageNote).toMatch(/^RESOLVE ecoregions \(2017\), share of the box in the box asked: Borneo lowland rain forests 77%, Borneo montane rain forests 23%/);
    expect(r.data.features[0].properties).toMatchObject({ level: "resolve", parent: "Tropical & Subtropical Moist Broadleaf Forests" });
    expect(r.citation.label).toMatch(/RESOLVE/);
  });

  it("merges a region's parts by name and measures the box on the sphere", () => {
    const part = (name: string, area: number) => ({ properties: { name, area }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } });
    const regions = readRegions({ features: [part("A", 2e9), part("B", 1e9), part("A", 1e9), part("N/A", 5e9)] }, [0, 0, 1, 1]);
    expect(regions.map((r) => r.name)).toEqual(["A", "B"]);
    expect(regions[0].geometry.type).toBe("MultiPolygon");
    expect(boxAreaM2([0, 0, 1, 1]) / 1e6).toBeCloseTo(12_364, -1);
    expect(regionsSentence(regions)).toMatch(/^A \d+%, B \d+%$/);
  });
});
