import { describe, expect, it } from "vitest";
import { identifyRequests } from "@/lib/render/identify";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";

const raster = (id: string, extra: Partial<LoadedLayer> = {}, minzoom = 0, time?: object): LoadedLayer =>
  ({
    id,
    title: id,
    style: { geometry: "polygon", color: "#000000" },
    result: { kind: "tiles", data: { url: "https://x/{z}/{x}/{y}.png?year=2020", minzoom, maxzoom: 14, format: "raster", ...(time && { time }) }, citation: { source: "", url: "", retrieved: "" } },
    receivedAt: "",
    identify: true,
    ...extra,
  }) as LoadedLayer;

function state(layers: LoadedLayer[]): MapState {
  return {
    ...initialMapState,
    layers: Object.fromEntries(layers.map((l) => [l.id, l])),
    renderOps: layers.map((l) => ({ layerId: l.id, mode: "polygons", visible: true })),
  } as MapState;
}

describe("identifyRequests", () => {
  it("asks the top visible raster layer that can identify, at a zoom it draws, with its input", () => {
    const s = state([raster("fire-hazard"), raster("flood-zones", {}, 14), raster("land-cover", { input: { nlcd: true } })]);
    const asked = identifyRequests(s, s.layers, [-105, 40], 10);
    expect(asked.map((r) => r.layerId)).toEqual(["land-cover", "fire-hazard"]);
    expect(asked[0].body).toEqual({ lon: -105, lat: 40, zoom: 10, input: { nlcd: true } });
  });

  it("skips layers without identify, vector tiles and hidden rows", () => {
    const s = state([raster("a", { identify: false }), raster("b")]);
    s.renderOps[1] = { ...s.renderOps[1], visible: false };
    expect(identifyRequests(s, s.layers, [0, 0], 10)).toEqual([]);
  });
});
