import { describe, expect, it } from "vitest";
import { layerRole } from "./roles";
import { kmFrom, shortPlace, withPlaceDistances } from "./fromPlace";
import { withDataGaps } from "./turnAnswer";

describe("layerRole: an area the question is not about draws as context beside the answer", () => {
  it("public land under campsites is context; asked who manages it, it is the subject", () => {
    expect(layerRole("public-lands", "Camping near Moab", ["campsites", "public-lands"])).toBe("context");
    expect(layerRole("public-lands", "Who manages this land and is it protected?", ["wilderness", "public-lands"])).toBeNull();
  });

  it("ecoregions around vegetation types are context; a wilderness beside threats is context unless protection is asked", () => {
    expect(layerRole("ecoregions", "What ecosystems cover the Great Smoky Mountains, with the share of each?", ["vegetation-types"])).toBe("context");
    expect(layerRole("wilderness", "What threatens the Boundary Waters?", ["mining-claims", "wilderness"])).toBe("context");
    expect(layerRole("wilderness", "What protects Grand Staircase-Escalante?", ["monuments", "mines"])).toBeNull();
  });

  it("an area alone, or a layer that is not an area around the answer, is the subject", () => {
    expect(layerRole("public-lands", "Where can I camp around here?", ["public-lands"])).toBeNull();
    expect(layerRole("campsites", "Camping near Moab", ["public-lands"])).toBeNull();
    expect(layerRole("avalanche", "Is there snow at Lake Tahoe, and any avalanche forecast?", ["snowpack"])).toBeNull();
  });
});

describe("threats say how far they lie from the place", () => {
  const center: [number, number] = [-107.97, 36.06];
  const square = (lon: number, lat: number) => ({ type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [[[lon, lat], [lon + 0.01, lat], [lon + 0.01, lat + 0.01], [lon, lat + 0.01], [lon, lat]]] }, properties: { name: `Lease at ${lon}` } });

  it("measures to the nearest vertex, 0 when an area covers the centre, and names the closest", () => {
    expect(kmFrom(center, square(-107.975, 36.055))).toBe(0);
    const { features, clause } = withPlaceDistances([square(-107.9, 36.06), square(-108.1, 36.06)], { center, name: "Chaco Canyon (valley in San Juan County, New Mexico)" });
    expect(features.map((f) => f.properties?.distanceToPlaceKm)).toEqual([6.3, 11]);
    expect(clause).toBe("closest to the centre of Chaco Canyon: Lease at -107.9, 6.3 km");
    expect(shortPlace("Wonderland Trail (trail in Mount Rainier National Park)")).toBe("Wonderland Trail");
  });
});

describe("withDataGaps", () => {
  const asked = { question: "Class III whitewater near Asheville with enough water this weekend", queries: [{ layerId: "paddling", bbox: [0, 0, 1, 1] as [number, number, number, number], inputKey: "[]", ok: true, drawable: false, wide: false }] };

  it("says plainly that no free source rates US sections by class, with what the map shows instead", () => {
    expect(withDataGaps("French Broad River at Asheville: 852 cfs.", asked)).toMatch(/No free source rates US river sections by whitewater class[^]*flow against normal/);
  });

  it("says it once, and not for a question that does not ask", () => {
    const said = withDataGaps("852 cfs.", asked);
    expect(withDataGaps(said, asked)).toBe(said);
    expect(withDataGaps("852 cfs.", { ...asked, question: "When is the Merced River highest?" })).toBe("852 cfs.");
  });
});
