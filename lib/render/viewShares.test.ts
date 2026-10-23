// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshViewShares, resetViewShares, sampleOf, sharesRequests, viewBox } from "@/lib/render/viewShares";
import { setCountedShares, setInView, tileShares, useInView } from "@/lib/render/inView";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";
import { renderHook, act } from "@testing-library/react";

const forest = (extra: Partial<LoadedLayer> = {}): LoadedLayer =>
  ({
    id: "forest-types",
    title: "Forest types",
    style: { geometry: "polygon", color: "#3A3A3C" },
    result: {
      kind: "tiles",
      data: {
        url: "/api/ee/tiles/forest-types/{z}/{x}/{y}?view=classes&src=2020v1&conf=all",
        minzoom: 3,
        maxzoom: 14,
        format: "raster",
        scenario: { param: "confidence", label: "Pixels shown", unit: "% sure", values: [0, 70], labels: ["All", "Only confident pixels"], tokens: ["all", "confident"], template: "/api/ee/tiles/forest-types/{z}/{x}/{y}?view=classes&src=2020v1&conf={value}" },
      },
      citation: { source: "", url: "", retrieved: "" },
    },
    receivedAt: "",
    shares: true,
    ...extra,
  }) as LoadedLayer;

function state(layers: LoadedLayer[], scenario?: MapState["scenario"]): MapState {
  return {
    ...initialMapState,
    layers: Object.fromEntries(layers.map((l) => [l.id, l])),
    renderOps: layers.map((l) => ({ layerId: l.id, mode: "polygons", visible: true })),
    ...(scenario && { scenario }),
  } as MapState;
}

describe("classes in view for raster layers", () => {
  afterEach(() => {
    resetViewShares();
    setCountedShares("forest-types", undefined);
  });

  it("asks for each visible raster layer that counts its classes, with the view, input and the scenario shown", () => {
    const s = state([forest({ input: { confidence: "all" } })], { layerId: "forest-types", value: 70, playing: false });
    const [req] = sharesRequests(s, s.layers, [116.12345, 4.5, 118.98765, 6.2], 8.04);
    expect(req).toEqual({ layerId: "forest-types", body: { bbox: [116.123, 4.5, 118.988, 6.2], zoom: 8, input: { confidence: "all" }, scenario: 70 } });
    expect(sharesRequests(s, s.layers, [116, 4, 118, 6], 2)).toEqual([]);
    expect(sharesRequests(state([forest({ shares: false })]), {}, [116, 4, 118, 6], 8)).toEqual([]);
    expect(viewBox([170, -10, -170, 10])).toBeNull();
    expect(viewBox([-200, -89, 200, 89])).toEqual([-180, -85, 180, 85]);
  });

  it("reads the route's answer and hands its shares to the legend's in-view snapshot", async () => {
    expect(sampleOf({ field: "class", shares: { "1": 0.7, "5": 0.3, "2": 0, x: "no" } })).toEqual({ field: "class", values: [], shares: { "1": 0.7, "5": 0.3 } });
    expect(sampleOf({ shares: null })).toBeUndefined();
    expect(tileShares({ field: "class", values: [], shares: { "1": 0.7 } })).toEqual(new Map([["1", 0.7]]));

    const { result } = renderHook(() => useInView());
    act(() => setInView({ bounds: [116, 4, 118, 6], tiles: {} }));
    const fetch = vi.fn(async () => Response.json({ field: "class", shares: { "1": 0.6, "6": 0.4 } }));
    const s = state([forest()]);
    const reqs = sharesRequests(s, s.layers, [116, 4, 118, 6], 8);
    await act(async () => {
      refreshViewShares(reqs, fetch as unknown as typeof globalThis.fetch);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetch).toHaveBeenCalledWith("/api/layer/forest-types/shares", expect.objectContaining({ method: "POST" }));
    expect(result.current.tiles["forest-types"]?.shares).toEqual({ "1": 0.6, "6": 0.4 });
    // A later report from the map keeps them; the same view is not asked twice; a removed layer drops them.
    act(() => setInView({ bounds: [116, 4, 118, 6], tiles: {} }));
    expect(result.current.tiles["forest-types"]?.shares).toEqual({ "1": 0.6, "6": 0.4 });
    refreshViewShares(reqs, fetch as unknown as typeof globalThis.fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => refreshViewShares([], fetch as unknown as typeof globalThis.fetch));
    expect(result.current.tiles["forest-types"]).toBeUndefined();
  });
});
