import { describe, expect, it } from "vitest";
import type { Feature } from "geojson";
import { attachPayoffs, buildPayoffQuery, parsePayoffs, pointToLineM } from "./payoffs";

const hike = (name: string, coordinates: [number, number][]): Feature => ({ type: "Feature", geometry: { type: "LineString", coordinates }, properties: { name, shape: "out-and-back" } });

describe("hike payoffs", () => {
  it("asks Overpass for waterfalls, viewpoints, named summits and hot springs in the box", () => {
    const q = buildPayoffQuery([-82.7, 35.4, -82.4, 35.7]);
    expect(q).toContain('node["waterway"="waterfall"](35.4,-82.7,35.7,-82.4)');
    expect(q).toContain('node["natural"="peak"]["name"]');
    expect(q).toContain('node["tourism"="viewpoint"]');
  });

  it("reads the kinds and names of the nodes, skipping anything else", () => {
    const payoffs = parsePayoffs({
      elements: [
        { type: "node", lat: 35.6, lon: -82.5, tags: { waterway: "waterfall", name: "Catawba Falls" } },
        { type: "node", lat: 35.6, lon: -82.5, tags: { tourism: "viewpoint" } },
        { type: "node", lat: 35.6, lon: -82.5, tags: { amenity: "bench" } },
        { type: "way", id: 1 },
      ],
    });
    expect(payoffs.map((p) => [p.kind, p.name])).toEqual([
      ["waterfall", "Catawba Falls"],
      ["viewpoint", undefined],
    ]);
  });

  it("measures metres from a point to a line", () => {
    // 0.001° of latitude is about 110 m.
    expect(pointToLineM([0, 0.001], [[-0.01, 0], [0.01, 0]])).toBeCloseTo(110.6, 0);
    expect(pointToLineM([0, 0], [[0, 0]])).toBe(0);
  });

  it("puts what a hike passes within 250 m on it, named first, and leaves the others alone", () => {
    const falls = hike("Falls Trail", [[-82.5, 35.6], [-82.49, 35.6]]);
    const far = hike("Far Trail", [[-82.3, 35.6], [-82.29, 35.6]]);
    const n = attachPayoffs(
      [falls, far],
      [
        { kind: "viewpoint", at: [-82.495, 35.6005] },
        { kind: "waterfall", name: "Catawba Falls", at: [-82.4905, 35.6012] },
        { kind: "summit", name: "Too Far Knob", at: [-82.495, 35.61] },
      ],
    );
    expect(n).toBe(1);
    expect(falls.properties).toMatchObject({ payoff: ["waterfall", "viewpoint"], passes: "Catawba Falls (waterfall) · a viewpoint" });
    expect(far.properties?.payoff).toBeUndefined();
  });
});
