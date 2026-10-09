import { describe, expect, it } from "vitest";
import {
  ADMIN_LINE_PAINT,
  LABEL_PAINT,
  hybridPaintOverrides,
  isWaterFill,
  occludingLayerIds,
  scaleOpacity,
  type StyleLayerLike,
} from "@/lib/render/hybridStyle";

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
  // Park outline (Outdoors' green band) and land-structure line: hidden.
  { id: "national-park_tint-band", type: "line", "source-layer": "landuse_overlay" },
  { id: "land-structure-line", type: "line", "source-layer": "structure" },
  { id: "contour-line", type: "line", "source-layer": "contour" },
  { id: "waterway", type: "line", "source-layer": "waterway" },
  { id: "road-path", type: "line", "source-layer": "road" },
  { id: "road-primary", type: "line", "source-layer": "road" },
  { id: "cliff", type: "line", "source-layer": "structure" },
  { id: "admin-1-boundary-bg", type: "line", "source-layer": "admin" },
  { id: "admin-1-boundary", type: "line", "source-layer": "admin" },
  { id: "admin-0-boundary", type: "line", "source-layer": "admin" },
  { id: "poi-label", type: "symbol", "source-layer": "poi_label" },
  { id: "natural-point-label", type: "symbol", "source-layer": "natural_label" },
  { id: "settlement-major-label", type: "symbol", "source-layer": "place_label" },
  { id: "road-label", type: "symbol", "source-layer": "road" },
  { id: "road-number-shield", type: "symbol", "source-layer": "road" },
];

describe("occludingLayerIds", () => {
  it("hides area fills, park and land-use outlines and the admin casing; keeps water, roads, contours and labels", () => {
    expect(occludingLayerIds(STYLE_LAYERS)).toEqual([
      "landcover",
      "national-park",
      "outdoors-greenery-v2",
      "wetland-pattern",
      "landuse-outline",
      "national-park_tint-band",
      "land-structure-line",
      "admin-1-boundary-bg",
    ]);
  });

  it("hides a park outline line and keeps a road line", () => {
    const hidden = occludingLayerIds(STYLE_LAYERS);
    expect(hidden).toContain("national-park_tint-band");
    expect(hidden).not.toContain("road-primary");
    expect(hidden).not.toContain("road-path");
  });

  it("returns nothing for a style without such fills", () => {
    expect(occludingLayerIds([{ id: "water", type: "fill", "source-layer": "water" }])).toEqual([]);
  });
});

describe("hybridPaintOverrides", () => {
  const overrides = hybridPaintOverrides(STYLE_LAYERS);
  const idsWith = (property: string) => overrides.filter((o) => o.property === property).map((o) => o.id);

  it("turns admin boundaries into a faint white line, but not their casing", () => {
    expect(idsWith("line-color")).toEqual(["admin-1-boundary", "admin-0-boundary"]);
    expect(overrides.find((o) => o.id === "admin-0-boundary")?.value).toBe(ADMIN_LINE_PAINT["line-color"]);
  });

  it("gives natural, POI and place labels white text on a dark halo, leaving road labels and shields", () => {
    expect(idsWith("text-color")).toEqual(["poi-label", "natural-point-label", "settlement-major-label"]);
    expect(overrides.filter((o) => o.id === "poi-label")).toEqual(
      Object.entries(LABEL_PAINT).map(([property, value]) => ({ id: "poi-label", property, value })),
    );
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

describe("WildMap tile layers under the hybrid", () => {
  // Ids that would otherwise match the park/land-use outline, admin and label rules.
  const OURS: StyleLayerLike[] = [
    { id: "tiles-state-parks", type: "fill", "source-layer": "landuse" },
    { id: "tiles-state-parks-line", type: "line", "source-layer": "national_park" },
    { id: "tiles-admin-areas", type: "line", "source-layer": "admin" },
    { id: "tiles-places", type: "symbol", "source-layer": "place_label" },
  ];

  it("never hides a tiles- layer", () => {
    expect(occludingLayerIds([...STYLE_LAYERS, ...OURS])).toEqual(occludingLayerIds(STYLE_LAYERS));
  });

  it("never repaints a tiles- layer", () => {
    expect(hybridPaintOverrides(OURS)).toEqual([]);
  });
});
