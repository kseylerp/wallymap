import { describe, expect, it } from "vitest";
import { isWaterFill, occludingLayerIds, scaleOpacity, type StyleLayerLike } from "@/lib/render/hybridStyle";

const STYLE_LAYERS: StyleLayerLike[] = [
  { id: "land", type: "background" },
  { id: "landcover", type: "fill", "source-layer": "landcover" },
  { id: "national-park", type: "fill", "source-layer": "landuse_overlay" },
  // A renamed fill: caught by its source layer, not its id.
  { id: "outdoors-greenery-v2", type: "fill", "source-layer": "landuse" },
  { id: "wetland-pattern", type: "fill", "source-layer": "landuse_overlay" },
  { id: "already-off", type: "fill", "source-layer": "landcover", layout: { visibility: "none" } },
  { id: "water", type: "fill", "source-layer": "water" },
  { id: "hillshade", type: "fill", "source-layer": "hillshade" },
  { id: "landuse-outline", type: "line", "source-layer": "landuse" },
  { id: "contour-line", type: "line", "source-layer": "contour" },
  { id: "road-path", type: "line", "source-layer": "road" },
  { id: "poi-label", type: "symbol", "source-layer": "poi_label" },
];

describe("occludingLayerIds", () => {
  it("hides area fills by id or source layer and keeps water, hillshade, lines and labels", () => {
    expect(occludingLayerIds(STYLE_LAYERS)).toEqual([
      "landcover",
      "national-park",
      "outdoors-greenery-v2",
      "wetland-pattern",
    ]);
  });

  it("returns nothing for a style without such fills", () => {
    expect(occludingLayerIds([{ id: "water", type: "fill", "source-layer": "water" }])).toEqual([]);
  });
});

describe("isWaterFill", () => {
  it("finds water fills only", () => {
    expect(STYLE_LAYERS.filter(isWaterFill).map((l) => l.id)).toEqual(["water"]);
  });
});

describe("scaleOpacity", () => {
  it("scales plain numbers and the implicit default", () => {
    expect(scaleOpacity(0.6, 0.5)).toBe(0.3);
    expect(scaleOpacity(undefined, 0.5)).toBe(0.5);
  });

  it("scales the outputs of a top-level zoom interpolate, keeping it top-level", () => {
    const expr = ["interpolate", ["linear"], ["zoom"], 14, ["match", ["get", "class"], "shadow", 0.08, 0.12], 16, 0];
    expect(scaleOpacity(expr, 0.5)).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      14,
      ["*", ["match", ["get", "class"], "shadow", 0.08, 0.12], 0.5],
      16,
      0,
    ]);
  });

  it("scales step outputs and wraps other expressions", () => {
    expect(scaleOpacity(["step", ["zoom"], 0.4, 10, 0.2], 0.5)).toEqual(["step", ["zoom"], 0.2, 10, 0.1]);
    expect(scaleOpacity(["get", "opacity"], 0.5)).toEqual(["*", ["get", "opacity"], 0.5]);
  });
});
