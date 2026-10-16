import { describe, expect, it, vi } from "vitest";
import type { Feature, FeatureCollection } from "geojson";

/**
 * The Rank by half of the duplicates check against the list as it was before 9a73dd3 (every feature ranked, one name
 * listed again and again): the check reuses the row's own function, so here that function is put back to the old one.
 */
vi.mock("@/lib/render/attributes", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/render/attributes")>();
  return {
    ...real,
    rankedTop: (layer: Parameters<typeof real.rankedTop>[0], op: { rankBy?: string }, data: FeatureCollection, shown: FeatureCollection, n: number) => {
      const measures = real.rankableMeasures(layer, data);
      const key = real.effectiveRankBy(op, layer, measures);
      return { key, measures, top: key ? real.topFeatures(shown, key, n) : [] };
    },
  };
});

const { checkDuplicates, drawnLayers } = await import("@/lib/checks/mapChecks");
const { getLayer } = await import("@/layers");
const { reduce } = await import("@/lib/render/reducer");
const { initialMapState } = await import("@/lib/render/state");

function stateWith(id: string, features: Feature[], mode: "lines" | "points") {
  const meta = getLayer(id)!;
  let state = reduce(initialMapState, {
    type: "layer_loaded",
    layer: {
      id,
      title: meta.title,
      style: meta.style,
      result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation: { source: "t", url: "https://example.org", retrieved: "2026-10-16" } },
      receivedAt: "2026-10-16",
      ...(meta.attributes && { attributes: meta.attributes }),
      ...(meta.card && { card: meta.card }),
    },
  });
  state = reduce(state, { type: "render", op: { layerId: id, mode, visible: true } });
  return state;
}

describe("Rank by duplicates (the list before 9a73dd3)", () => {
  it("fails the owner's Tahoe popularity list: Rubicon Trail in rows 1 to 4", () => {
    const seg = (x: number, v: number): Feature => ({ type: "Feature", geometry: { type: "LineString", coordinates: [[x, 39], [x + 0.005, 39.005]] }, properties: { name: "Rubicon Trail", v } });
    const state = stateWith("popularity", [seg(-120.1, 78), seg(-120.095, 76), seg(-120.09, 74), seg(-120.085, 72)], "lines");
    const result = checkDuplicates(drawnLayers(state, (id) => getLayer(id)));
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/Trail popularity estimate \(popularity\): the Rank by top 4 \(by popularity[^)]*\) lists the same place twice: "Rubicon Trail" \(rows 1 and 2\)/);
  });

  it("fails the owner's crag listed twice (an OSM point and its cliff line)", () => {
    const state = stateWith(
      "climbing",
      [
        { type: "Feature", geometry: { type: "Point", coordinates: [-83.6601, 37.7201] }, properties: { name: "Bob Marley Crag", v: 120 } },
        { type: "Feature", geometry: { type: "LineString", coordinates: [[-83.6605, 37.7205], [-83.6595, 37.7209]] }, properties: { name: "Bob Marley Crag", v: 118 } },
      ],
      "points",
    );
    const result = checkDuplicates(drawnLayers(state, (id) => getLayer(id)));
    expect(result.failures.some((f) => /Rank by top 2 \(by routes\) lists the same place twice: "Bob Marley Crag" \(rows 1 and 2\)/.test(f))).toBe(true);
  });
});
