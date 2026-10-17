import { afterEach, describe, expect, it, vi } from "vitest";
import { basemapStyle, basemapStyleUrl, dataOnlyStyle, DATA_ONLY_STYLE } from "@/lib/render/basemaps";
import { decodeState } from "@/lib/render/permalink";
import { isDenseNetwork, preferredBasemap } from "@/lib/render/views";
import type { LoadedLayer } from "@/lib/render/state";

const OUTDOORS = "mapbox://styles/mapbox/outdoors-v12";

describe("basemapStyleUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps outdoors-satellite to the Outdoors style (imagery is added on style load)", () => {
    expect(basemapStyleUrl("outdoors-satellite")).toBe(OUTDOORS);
  });

  it("maps outdoors to the Mapbox Outdoors style", () => {
    expect(basemapStyleUrl("outdoors")).toBe(OUTDOORS);
  });

  it("maps satellite to the Mapbox Satellite Streets style", () => {
    expect(basemapStyleUrl("satellite")).toBe("mapbox://styles/mapbox/satellite-streets-v12");
  });

  it("uses NEXT_PUBLIC_NATURAL_EARTH_STYLE for natural-earth-2 when set", () => {
    vi.stubEnv("NEXT_PUBLIC_NATURAL_EARTH_STYLE", "mapbox://styles/someone/natural-earth-2");
    expect(basemapStyleUrl("natural-earth-2")).toBe("mapbox://styles/someone/natural-earth-2");
  });

  it("falls back to outdoors for natural-earth-2 when the env var is blank", () => {
    vi.stubEnv("NEXT_PUBLIC_NATURAL_EARTH_STYLE", "");
    expect(basemapStyleUrl("natural-earth-2")).toBe(OUTDOORS);
  });

  it("falls back to outdoors for natural-earth-2 when the env var is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_NATURAL_EARTH_STYLE", undefined);
    expect(basemapStyleUrl("natural-earth-2")).toBe(OUTDOORS);
  });
});

describe("the data-only basemap (spec §13)", () => {
  it("is WallyMap's own style: land, water and lakes, a hairline coast, faint borders and major places, no roads or relief", () => {
    const style = dataOnlyStyle();
    expect(style.layers.map((l) => l.id)).toEqual([
      "data-only-land",
      "data-only-water",
      "data-only-coast",
      "data-only-states",
      "data-only-countries",
      "data-only-state-labels",
      "data-only-cities",
    ]);
    expect(style.layers.some((l) => l.type === "hillshade" || ("source-layer" in l && l["source-layer"] === "road"))).toBe(false);
    expect(basemapStyleUrl("data-only")).toBe(DATA_ONLY_STYLE);
    expect(typeof basemapStyle("data-only")).toBe("object");
    expect(basemapStyle("outdoors")).toBe(OUTDOORS);
  });

  it("travels in a share link", () => {
    expect(decodeState("#b=data-only")?.basemap).toBe("data-only");
  });

  it("is offered for a dense network: a series, a flow field, or 150 lines and more", () => {
    const line: GeoJSON.Feature = { type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: {} };
    const layer = (n: number, extra = {}): LoadedLayer => ({
      id: "l",
      title: "L",
      style: { geometry: "line", color: "#9FB693" },
      result: { kind: "geojson", data: { type: "FeatureCollection", features: Array.from({ length: n }, () => line) }, citation: { source: "s", url: "https://e.org", retrieved: "x" }, ...extra },
      receivedAt: "x",
    });
    expect(isDenseNetwork(layer(200), { visible: true, mode: "lines" })).toBe(true);
    expect(isDenseNetwork(layer(20), { visible: true, mode: "lines" })).toBe(false);
    expect(isDenseNetwork(layer(3, { series: { times: ["2026-10-01"], step: "day", now: 0 } }), { visible: true, mode: "lines" })).toBe(true);
    expect(isDenseNetwork(layer(200), { visible: false, mode: "lines" })).toBe(false);
    // Wind over mountains reads best over the terrain: its row offers Topographical, never Data only.
    const wind = { ...layer(3), style: { geometry: "point" as const, color: "#3A3A3C", basemap: "outdoors" as const } };
    expect(preferredBasemap(wind, { visible: true, mode: "points" })).toBe("outdoors");
    expect(preferredBasemap(layer(200), { visible: true, mode: "lines" })).toBe("data-only");
  });
});
