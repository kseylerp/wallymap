import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { cardContent } from "@/lib/render/card";
import { attributeProblems } from "./attributes";
import { contractProblems, legendOf } from "./contract";
import layer, { ageClassOf, faultsNote, locationOf, nearestFaults, normalizeFaults, slipRateOf } from "./faults";
import fixture from "./__fixtures__/faults.zion.json";

/** A trimmed real answer of the USGS Quaternary fault database around Zion (-113.6,36.9 to -112.6,37.6), 2026-10-23. */
const ZION_REGION: [number, number, number, number] = [-113.6, 36.9, -112.6, 37.6];

function ctx(stub: ReturnType<typeof vi.fn>, bbox = ZION_REGION) {
  return { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey: "faults:test" };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("faults layer", () => {
  it("declares a keyless US line layer colored by age, dashed by location, with a clean contract", () => {
    expect(layer.id).toBe("faults");
    expect(layer.coverage).toBe("us");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.license).toContain("Public domain");
    expect(layer.style).toMatchObject({ geometry: "line", encode: { color: "ageClass" } });
    expect(layer.attributes?.find((a) => a.encode === "dash")?.key).toBe("location");
    expect(contractProblems(layer)).toEqual([]);
    expect(attributeProblems(layer)).toEqual([]);
    expect(layer.description).toContain("no mapped Quaternary faults here");
  });

  it("reads the database's age classes, location classes and slip rates in words", () => {
    expect(["historic", "latest Quaternary", "late Quaternary", "middle and late Quaternary", "undifferentiated Quaternary", "class B"].map((a) => ageClassOf(a))).toEqual([
      "historic",
      "latest",
      "late",
      "middle-late",
      "quaternary",
      "unproven",
    ]);
    expect(ageClassOf("late Quaternary", "B")).toBe("unproven");
    expect(["Well Constrained", "Moderately Constrained", "Inferred", ""].map(locationOf)).toEqual(["well", "approximate", "inferred", undefined]);
    expect(slipRateOf("Less than 0.2 mm/yr")).toEqual({ text: "Under 0.2 mm a year", rank: 1 });
    expect(slipRateOf("Between 1.0 and 5.0 mm/yr")).toEqual({ text: "1 to 5 mm a year", rank: 3 });
    expect(slipRateOf("0.2 +/- 0.1 mm/yr")).toEqual({ text: "0.2 ± 0.1 mm a year", rank: 2 });
    expect(slipRateOf("Unspecified")).toEqual({ text: "Not known" });
  });

  it("joins a section's segments per location class, names only the longest line of each section, youngest first", () => {
    const fc = normalizeFaults(fixture as FeatureCollection);
    const headings = new Set(fc.features.map((f) => f.properties?.heading));
    const named = fc.features.filter((f) => f.properties?.name);
    expect(named).toHaveLength(headings.size);
    expect(fc.features[0].properties).toMatchObject({ ageClass: "latest", fault: expect.stringMatching(/Hurricane|Washington/) });
    for (const f of fc.features) expect(["LineString", "MultiLineString"]).toContain(f.geometry.type);
    const hurricane = fc.features.find((f) => f.properties?.name && String(f.properties.fault).startsWith("Hurricane"));
    expect(hurricane?.properties).toMatchObject({ slipSense: "Normal", location: expect.any(String), url: expect.stringContaining("earthquake.usgs.gov") });
  });

  it("notes the count and the youngest, most active faults by name", async () => {
    const stub = vi.fn(async () => json(fixture));
    const r = await layer.query(ctx(stub), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error(JSON.stringify(r));
    expect(r.data.features.length).toBeGreaterThan(5);
    expect(r.coverageNote).toMatch(/^\d+ mapped Quaternary faults \(\d+ sections\) in the box/);
    expect(r.coverageNote).toContain("Hurricane fault zone (latest Quaternary, under 15,000 years; slip 0.2 to 1 mm a year)");
    const [url] = stub.mock.calls[0] as unknown as [string];
    expect(url).toContain("MapServer/21/query?");
    expect(url).toContain("f=geojson");
  });

  it("says there are none in a box without faults and names the nearest", async () => {
    const empty = { type: "FeatureCollection", features: [] };
    const stub = vi.fn().mockResolvedValueOnce(json(empty)).mockResolvedValueOnce(json(fixture));
    const r = await layer.query(ctx(stub, [-113.02, 37.19, -112.9, 37.33]), {});
    if (!("kind" in r) || r.kind !== "geojson") throw new Error(JSON.stringify(r));
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/^No mapped Quaternary faults here/);
    expect(r.coverageNote).toMatch(/The nearest are .*km (north|south|east|west)/);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("finds the nearest faults by distance and direction from the box's centre", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "LineString", coordinates: [[-113.3, 37.2], [-113.3, 37.3]] }, properties: { fault_name: "West fault" } },
        { type: "Feature", geometry: { type: "LineString", coordinates: [[-113.0, 37.6], [-112.9, 37.6]] }, properties: { fault_name: "North fault" } },
      ],
    };
    expect(nearestFaults(fc, [-113.02, 37.19, -112.9, 37.33])).toEqual([
      { name: "West fault", km: 30, dir: "west" },
      { name: "North fault", km: 38, dir: "north" },
    ]);
  });

  it("returns nothing outside the United States without asking the service", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(stub, [10, 45, 11, 46]), {});
    expect(stub).not.toHaveBeenCalled();
    expect(r).toMatchObject({ kind: "geojson", coverageNote: "No data outside the United States" });
  });

  it("cards a fault with its name, age, slip rate, slip sense and location in words, and keys age with how dashes read", () => {
    const fc = normalizeFaults(fixture as FeatureCollection);
    const f = fc.features.find((x) => x.properties?.name)!;
    const card = cardContent(f, { card: layer.card, fieldHelp: layer.fieldHelp });
    const labels = card.facts.map((r) => r.label);
    expect(labels.slice(0, 2)).toEqual(["Name", "Section"]);
    expect(labels).toEqual(expect.arrayContaining(["Age", "Slip rate", "Slip sense", "Location"]));
    expect(card.facts.find((r) => r.label === "Age")?.value).toMatch(/Quaternary|Historic/i);
    expect(card.links[0]).toMatchObject({ label: "USGS fault report" });
    const legend = legendOf(layer);
    expect(legend).toMatchObject({ kind: "categories", title: "Age of last movement", field: "ageClass" });
    expect(legend.items).toHaveLength(5);
    expect(legend.note).toContain("Solid lines are well located, dashed approximate, dotted inferred");
  });

  it("states a truncated answer", () => {
    expect(faultsNote(normalizeFaults(fixture as FeatureCollection), true)).toContain("first 2000 segments");
  });
});
