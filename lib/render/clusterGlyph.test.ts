import type { Feature } from "geojson";
import { IconLayer } from "@deck.gl/layers";
import { describe, expect, it } from "vitest";
import { buildDeckLayers } from "@/lib/render/deck";
import { initialMapState, type MapState } from "@/lib/render/state";

const crag = (lng: number, lat: number, name: string): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties: { name, kind: "crag", v: 5 },
});

describe("the layer's glyph shows in every render mode (owner, Red River Gorge card)", () => {
  it("draws clusters mode's lone crags with the climbing glyph, never a generic ring", () => {
    // Two crags close together cluster; one far away stands alone.
    const features = [crag(-83.68, 37.78, "A"), crag(-83.6801, 37.7801, "B"), crag(-80, 40, "Lone")];
    const state: MapState = {
      ...initialMapState,
      viewport: { ...initialMapState.viewport, zoom: 8, latitude: 38 },
      terrain: false,
      layers: {
        climbing: {
          id: "climbing",
          title: "Climbing",
          style: { geometry: "point", color: "#3A3A3C" },
          result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation: { source: "s", url: "u", retrieved: "r" } },
          receivedAt: "",
        },
      },
      renderOps: [{ layerId: "climbing", mode: "clusters", visible: true }],
    };
    const layers = buildDeckLayers(state);
    const icons = layers.find((l) => l instanceof IconLayer) as IconLayer<Feature> | undefined;
    expect(icons).toBeDefined();
    const getIcon = icons!.props.getIcon as unknown as (f: Feature) => { id: string };
    const lone = (icons!.props.data as Feature[]).find((f) => f.properties?.name === "Lone")!;
    expect(getIcon(lone).id).toMatch(/^bolts-/);
  });
});
