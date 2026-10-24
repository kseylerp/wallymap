import { describe, expect, it } from "vitest";
import { boxAround, isPointLike, nearBox, nearPlace, offPlace, placeCandidates, statedRadiusKm } from "./places";

describe("placeCandidates", () => {
  it.each([
    ["How deep is Lake Tahoe?", ["Lake Tahoe"]],
    ["How full is Lake Powell right now?", ["Lake Powell"]],
    ["Recent earthquakes near Mammoth Lakes", ["Mammoth Lakes"]],
    ["Climbing crags near Red River Gorge", ["Red River Gorge"]],
    ["Outline the Sierra Nevada", ["Sierra Nevada"]],
    ["Show Miami with 3 feet of sea level rise", ["Miami"]],
    ["Is the Carson River running high?", ["Carson River"]],
    ["dams in the colorado river basin", ["colorado river basin"]],
    ["dams in the Colorado River basin", ["Colorado River basin"]],
    ["Which uranium mines near the Navajo Nation score highest?", ["Navajo Nation"]],
    ["wind farms in West Texas @view=[-104,29,-96,35]", ["West Texas"]],
    ["Who owns the land around Bryce Canyon, and is any of it designated wilderness?", ["Bryce Canyon"]],
    ["Show me a walking route from Tahoe City to Emerald Bay", ["Tahoe City", "Emerald Bay"]],
  ])("%s → %j", (question, places) => {
    expect(placeCandidates(question)).toEqual(places);
  });

  it.each(["What fires are here? @view=[-120.2,38.9,-119.8,39.3]", "Which sequoia groves burned in the 2020 and 2021 fires?", "Mountain bike trails nearby"])(
    "names no place in %s",
    (question) => {
      expect(placeCandidates(question)).toEqual([]);
    },
  );
});

describe("near", () => {
  it("reads the place after near", () => {
    expect(nearPlace("Recent earthquakes near Mammoth Lakes")).toBe("Mammoth Lakes");
    expect(nearPlace("Which uranium mines near the Navajo Nation score highest?")).toBe("Navajo Nation");
    expect(nearPlace("Glaciers in the Wind River Range")).toBeNull();
  });

  it("reads a stated radius in km or miles", () => {
    expect(statedRadiusKm("quakes within 80 km of Reno")).toBe(80);
    expect(statedRadiusKm("trails within 10 miles of Moab")).toBeCloseTo(16.09, 1);
    expect(statedRadiusKm("trails near Moab")).toBeNull();
  });

  const mammoth = { bbox: [-119.03, 37.6, -118.93, 37.67] as [number, number, number, number], center: [-118.97, 37.65] as [number, number] };

  it("gives each layer kind its default radius around a town", () => {
    const quakes = nearBox("Recent earthquakes near Mammoth Lakes", "earthquakes", mammoth)!;
    expect((quakes[3] - quakes[1]) * 111.32).toBeCloseTo(100, 0);
    const trails = nearBox("trails near Mammoth Lakes", "osm-trails", mammoth)!;
    expect((trails[3] - trails[1]) * 111.32).toBeCloseTo(50, 0);
    const crags = nearBox("crags near Mammoth Lakes", "climbing", mammoth)!;
    expect((crags[3] - crags[1]) * 111.32).toBeCloseTo(60, 0);
  });

  it("uses the radius the user gave, and leaves a region or a layer without a default alone", () => {
    const box = nearBox("earthquakes within 20 km of Mammoth Lakes", "earthquakes", mammoth)!;
    expect((box[3] - box[1]) * 111.32).toBeCloseTo(40, 0);
    expect(nearBox("dams near Mammoth Lakes", "dams", mammoth)).toBeNull();
    expect(nearBox("mines near the Navajo Nation", "earthquakes", { bbox: [-112, 35, -107.5, 37.5], center: [-109.8, 36.2] })).toBeNull();
    const moab = nearBox("Mountain bike trails near Moab", "mtb-trails", { bbox: [-110.146, 38.188, -109.051, 39.468], center: [-109.551, 38.573], source: "mapbox" })!;
    expect((moab[3] - moab[1]) * 111.32).toBeCloseTo(50, 0);
  });

  it("tells a town from a region", () => {
    expect(isPointLike(mammoth.bbox)).toBe(true);
    // Mapbox's Moab, Utah is its whole census area, 1.1° by 1.3°: still a town.
    expect(isPointLike([-110.146, 38.188, -109.051, 39.468], "mapbox")).toBe(true);
    expect(isPointLike([-112, 35, -107.5, 37.5])).toBe(false);
    expect(isPointLike([-109.2, 36.0, -108.8, 36.3], "wikidata")).toBe(false);
    expect(boxAround([0, 0], 111.32)).toEqual([-1, -1, 1, 1]);
  });
});

describe("offPlace", () => {
  it("reads the coastal place after off", () => {
    expect(offPlace("Where are whales being seen off Monterey this week?")).toBe("Monterey");
    expect(offPlace("Swell off the coast of Oregon")).toBe("Oregon");
    expect(offPlace("Whales near Monterey")).toBeNull();
  });
});

describe("near a small natural feature", () => {
  it("reaches the layer's radius around a valley, not around a range", async () => {
    const { nearBox } = await import("@/lib/agent/places");
    const valley = { bbox: [-119.676, 37.717, -119.547, 37.746] as [number, number, number, number], center: [-119.61, 37.73] as [number, number], source: "openstreetmap" };
    const box = nearBox("Any fires near Yosemite Valley right now?", "fire-detections", valley)!;
    expect(box[2] - box[0]).toBeGreaterThan(1);
    const range = { bbox: [-121, 35.3, -118, 40.5] as [number, number, number, number], center: [-119.5, 37.9] as [number, number], source: "openstreetmap" };
    expect(nearBox("Fires near the Sierra Nevada", "fire-detections", range)).toBeNull();
  });
});
