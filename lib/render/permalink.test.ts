import { describe, expect, it, vi } from "vitest";
import type { LayerError, LayerResult } from "@/layers/types";
import { capBox, decodeState, encodeState, restoreFromPermalink, viewportBBox, type PermalinkSource } from "@/lib/render/permalink";
import { bboxAreaKm2 } from "@/layers/types";
import type { LoadedLayer, MapAction } from "@/lib/render/state";

const result: LayerResult = {
  kind: "geojson",
  data: { type: "FeatureCollection", features: [] },
  citation: { source: "S", url: "https://example.com", retrieved: "2026-10-09T00:00:00Z" },
};
const loaded = (id: string): LoadedLayer => ({
  id,
  title: id,
  style: { geometry: "line", color: "#000" },
  result,
  receivedAt: "2026-10-09T00:00:00Z",
});

const source: PermalinkSource = {
  viewport: { longitude: -120.04321, latitude: 39.1, zoom: 11.5, pitch: 45, bearing: -20 },
  basemap: "outdoors",
  layers: { "osm-trails": loaded("osm-trails"), campsites: loaded("campsites") },
  renderOps: [
    { layerId: "osm-trails", mode: "lines", visible: true },
    { layerId: "campsites", mode: "points", visible: false },
  ],
  time: { start: "2016-01-01", end: "2026-01-01" },
};

describe("permalink encode and decode", () => {
  it("round-trips the camera, basemap, layers and time", () => {
    const hash = encodeState(source);
    expect(hash).toBe(
      "#v=-120.04321,39.1,11.5,45,-20&b=outdoors&l=osm-trails:lines:1,campsites:points:0&t=2016-01-01,2026-01-01",
    );
    expect(decodeState(hash)).toEqual({
      viewport: source.viewport,
      basemap: "outdoors",
      layers: [
        { id: "osm-trails", mode: "lines", visible: true },
        { id: "campsites", mode: "points", visible: false },
      ],
      time: { start: "2016-01-01", end: "2026-01-01" },
    });
  });

  it("omits layers and time when there are none, and skips ops whose layer is gone", () => {
    const hash = encodeState({ ...source, time: undefined, layers: {}, renderOps: source.renderOps });
    expect(hash).toBe("#v=-120.04321,39.1,11.5,45,-20&b=outdoors");
  });

  it("leaves out ids the layer API cannot serve when given the catalog", () => {
    const withRoute: PermalinkSource = {
      ...source,
      layers: { ...source.layers, "route-ab12": loaded("route-ab12") },
      renderOps: [...source.renderOps, { layerId: "route-ab12", mode: "lines", visible: true }],
    };
    expect(encodeState(withRoute)).toContain("route-ab12:lines:1");
    const hash = encodeState(withRoute, { "osm-trails": {}, campsites: {} });
    expect(hash).not.toContain("route-");
    expect(decodeState(hash)?.layers.map((l) => l.id)).toEqual(["osm-trails", "campsites"]);
  });

  it("returns null for a malformed hash", () => {
    for (const bad of ["", "#", "#garbage", "#v=abc", "#v=1,2", "#v=500,2,3,0,0", "#b=moon", "#l=", "#v=1,,3"]) {
      expect(decodeState(bad), bad).toBeNull();
    }
  });

  it("reads a partial hash and fills only what it names", () => {
    expect(decodeState("#b=satellite")).toEqual({ basemap: "satellite", layers: [] });
    expect(decodeState("l=osm-trails")).toEqual({ layers: [{ id: "osm-trails", mode: undefined, visible: true }] });
    expect(decodeState("#v=10,20,5")?.viewport).toEqual({ longitude: 10, latitude: 20, zoom: 5, pitch: 0, bearing: 0 });
    expect(decodeState("#v=10,20,5&l=a:lines:1,:x:1,b:nonsense:0")?.layers).toEqual([
      { id: "a", mode: "lines", visible: true },
      { id: "b", mode: undefined, visible: false },
    ]);
  });
});

describe("viewportBBox", () => {
  it("is centered on the camera and shrinks as the zoom grows", () => {
    const view = { longitude: -120, latitude: 39, zoom: 10, pitch: 0, bearing: 0 };
    const [w, s, e, n] = viewportBBox(view, 1000, 800);
    expect((w + e) / 2).toBeCloseTo(-120, 5);
    expect(s).toBeLessThan(39);
    expect(n).toBeGreaterThan(39);
    const [w2, , e2] = viewportBBox({ ...view, zoom: 11 }, 1000, 800);
    expect(e2 - w2).toBeCloseTo((e - w) / 2, 5);
  });
});

describe("encodeState with the scrubber's state", () => {
  it("writes the window of a TimeState as t=", () => {
    const hash = encodeState({ ...source, time: { window: ["2019-01-01T00:00:00.000Z", "2019-12-31T23:59:59.999Z"] } });
    expect(decodeState(hash)?.time).toEqual({ start: "2019-01-01T00:00:00.000Z", end: "2019-12-31T23:59:59.999Z" });
  });
});

describe("restoreFromPermalink", () => {
  const catalog = {
    "osm-trails": { title: "Trails", style: { geometry: "line" as const, color: "#111" } },
    campsites: { title: "Campsites", style: { geometry: "point" as const, color: "#222" } },
  };
  const canvas = { width: 1000, height: 800 };

  it("sets the camera, then dispatches layer_loaded and render for each layer in order", async () => {
    const actions: MapAction[] = [];
    const fetchLayer = vi.fn(async () => result);
    const outcome = await restoreFromPermalink(encodeState(source), (a) => actions.push(a), fetchLayer, { catalog, canvas });
    expect(outcome).toEqual({ restored: ["osm-trails", "campsites"], failed: [] });
    expect(fetchLayer).toHaveBeenCalledTimes(2);
    expect(actions.map((a) => a.type)).toEqual([
      "set_basemap",
      "set_view",
      "layer_loaded",
      "render",
      "layer_loaded",
      "render",
      "set_time_window",
    ]);
    // The time window comes last, once the layers that build the time index are in.
    expect(actions[6]).toEqual({ type: "set_time_window", window: ["2016-01-01", "2026-01-01"] });
    expect(actions[2]).toMatchObject({ layer: { id: "osm-trails", title: "Trails" } });
    expect(actions[5]).toMatchObject({ op: { layerId: "campsites", mode: "points", visible: false } });
  });

  it("reports a failed layer as a layer error and keeps the rest", async () => {
    const actions: MapAction[] = [];
    const fetchLayer = vi.fn(async (id: string): Promise<LayerResult | LayerError> =>
      id === "campsites" ? { error: "down", hint: "upstream" } : result,
    );
    const outcome = await restoreFromPermalink(encodeState(source), (a) => actions.push(a), fetchLayer, { catalog, canvas });
    expect(outcome).toEqual({ restored: ["osm-trails"], failed: ["campsites"] });
    expect(actions).toContainEqual({ type: "layer_error", layerId: "campsites", message: "down" });
  });

  it("retries once on a zoom_in error with the central quarter of the box", async () => {
    const calls: number[][] = [];
    const fetchLayer = vi.fn(async (_id: string, bbox: number[]): Promise<LayerResult | LayerError> => {
      calls.push(bbox);
      return calls.length === 1 ? { error: "too big", hint: "zoom_in" } : result;
    });
    const outcome = await restoreFromPermalink("#l=osm-trails&v=0,0,8", () => {}, fetchLayer, { catalog, canvas });
    expect(outcome?.restored).toEqual(["osm-trails"]);
    const [first, second] = calls;
    expect(second[2] - second[0]).toBeCloseTo((first[2] - first[0]) / 2, 8);
  });

  it("returns null and dispatches nothing for a malformed hash", async () => {
    const dispatch = vi.fn();
    expect(await restoreFromPermalink("#nonsense", dispatch, vi.fn(), { catalog, canvas })).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("capBox", () => {
  it("shrinks a restored box about its center to the layer's largest area, so the request is not refused", () => {
    const wide: [number, number, number, number] = [-110.5, 38, -108.5, 39.4];
    const capped = capBox(wide, 10_000);
    expect(bboxAreaKm2(capped)).toBeLessThan(10_000);
    expect(bboxAreaKm2(capped)).toBeGreaterThan(9_000);
    expect((capped[0] + capped[2]) / 2).toBeCloseTo(-109.5, 6);
    expect(capBox(wide, undefined)).toBe(wide);
    expect(capBox(wide, 1e9)).toBe(wide);
  });
});
