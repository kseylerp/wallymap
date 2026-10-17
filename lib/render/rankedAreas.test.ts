import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { buildDeckLayers } from "@/lib/render/deck";
import { SAGE } from "@/lib/render/palette";
import { PlacedLabelLayer } from "@/lib/render/placedLabels";
import { initialMapState, type MapState, type RenderOp } from "@/lib/render/state";

/** A square glacier outline of `size` degrees at (lng, lat), with its area as v. */
const glacier = (lng: number, lat: number, size: number, v: number, name: string): Feature => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [[[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]] },
  properties: { name, v },
});

const glaciers = [glacier(-73.5, -50, 0.2, 188, "Unnamed glacier"), glacier(-73, -50.5, 0.1, 59.7, "Noroeste 09"), glacier(-72.5, -51, 0.08, 41.4, "Galería")];

function stateWith(op: Partial<RenderOp>): MapState {
  return {
    ...initialMapState,
    viewport: { ...initialMapState.viewport, zoom: 7 },
    layers: {
      glaciers: {
        id: "glaciers",
        title: "Glaciers",
        style: { geometry: "polygon", color: SAGE, unit: "km²", extrude: "v" },
        attributes: [{ key: "v", label: "Area", type: "measure", unit: "km²" }],
        result: { kind: "geojson", data: { type: "FeatureCollection", features: glaciers }, citation: { source: "GLIMS", url: "https://glims.org", retrieved: "2026-10-17" } },
        receivedAt: "2026-10-17T00:00:00Z",
      },
    },
    renderOps: [{ layerId: "glaciers", mode: "polygons", visible: true, ...op }],
  };
}

describe("a ranked view labels its top areas on the map", () => {
  it("names the top named areas at their centers, leaving placeholders such as Unnamed glacier to the row", () => {
    const placed = buildDeckLayers(stateWith({ view: "ranked" })).find((l) => l.id === "glaciers:polygons:placed") as PlacedLabelLayer<Feature> | undefined;
    expect(placed).toBeInstanceOf(PlacedLabelLayer);
    expect(placed!.props.data.map((f) => f.properties?.name)).toEqual(["Noroeste 09", "Galería"]);
  });

  it("draws no labels outside the ranked view", () => {
    expect(buildDeckLayers(stateWith({ view: "detail" })).some((l) => l.id.endsWith(":placed"))).toBe(false);
  });
});
