import { describe, expect, it, vi } from "vitest";
import type { LayerError, LayerResult } from "@/layers/types";
import { capBox, decodeState, encodeState, restoreFromPermalink, viewportBBox, type PermalinkSource } from "@/lib/render/permalink";
import { bboxAreaKm2 } from "@/layers/types";
import { toolResultToActions, type LayerCatalog } from "@/lib/agent/applyToolResult";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type CompareState, type LoadedLayer, type MapAction, type MapState, type RenderOp } from "@/lib/render/state";

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
      "#v=-120.04321,39.1,11.5,45,-20&b=outdoors&l=osm-trails:lines:1:::-,campsites:points:0:::-&t=2016-01-01,2026-01-01",
    );
    expect(decodeState(hash)).toEqual({
      viewport: source.viewport,
      basemap: "outdoors",
      layers: [
        { id: "osm-trails", mode: "lines", visible: true, view: null },
        { id: "campsites", mode: "points", visible: false, view: null },
      ],
      time: { start: "2016-01-01", end: "2026-01-01" },
    });
  });

  it("still reads a link written before views, opacity, color, inputs and compare were recorded", () => {
    const old = "#v=-120.04321,39.1,11.5,45,-20&b=outdoors&l=osm-trails:lines:1,climbing:hexbin:1:-:share%3Asport&f=climbing:name*=Muir&t=2016-01-01,2026-01-01";
    expect(decodeState(old)).toEqual({
      viewport: source.viewport,
      basemap: "outdoors",
      layers: [
        { id: "osm-trails", mode: "lines", visible: true },
        { id: "climbing", mode: "hexbin", visible: true, rankBy: "", hexBasis: "share:sport", filters: { name: { match: "Muir" } } },
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

describe("every setting a person can see survives the link", () => {
  const one = (op: RenderOp, extra: Partial<PermalinkSource> = {}) =>
    decodeState(encodeState({ ...source, layers: { [op.layerId]: loaded(op.layerId) }, renderOps: [op], ...extra }));

  it("round-trips each render op setting", () => {
    const op: RenderOp = {
      layerId: "power-plants",
      mode: "hexbin",
      visible: false,
      color: "#1A2B3C",
      opacity: 0.35,
      filters: {
        v: { range: [2.5, 40] },
        kind: { include: ["wind", "a:b,c"] },
        name: { match: "Crag & co" },
        river: { include: ["Colorado River"], within: { bbox: [-115.7, 29.9, -105.6, 43.5], name: "Colorado River basin ~ USGS" } },
      },
      view: "density",
      rankBy: "capacity",
      hexBasis: "share:wind farm",
    };
    expect(one(op)?.layers).toEqual([
      { id: "power-plants", mode: "hexbin", visible: false, color: "#1A2B3C", opacity: 0.35, filters: op.filters, view: "density", rankBy: "capacity", hexBasis: "share:wind farm" },
    ]);
    for (const view of ["change", "timeline", "ranked", "density", "detail", "scenario", "route"] as const) {
      expect(one({ layerId: "x", mode: "points", visible: true, view })?.layers[0].view).toBe(view);
    }
    for (const hexBasis of ["count", "sum", "recency", "share:sport"] as const) {
      expect(one({ layerId: "x", mode: "columns", visible: true, hexBasis })?.layers[0].hexBasis).toBe(hexBasis);
    }
    expect(one({ layerId: "x", mode: "points", visible: true, rankBy: "" })?.layers[0].rankBy).toBe("");
    expect(one({ layerId: "x", mode: "points", visible: true, opacity: 0 })?.layers[0].opacity).toBe(0);
    // Full opacity is the default and is not written.
    expect(one({ layerId: "x", mode: "points", visible: true, opacity: 1 })?.layers[0]).not.toHaveProperty("opacity");
  });

  it("round-trips each layer's query input: the surf forecast, a date, numbers, lists and strings that look like JSON", () => {
    const input = { forecast: true, season: false, month: 10, date: "2026-10-15", region: "europe", text: "10", tags: ["a", "b,c"] };
    const decoded = one({ layerId: "surf", mode: "points", visible: true }, { layers: { surf: { ...loaded("surf"), input } } });
    expect(decoded?.layers[0].input).toEqual(input);
    const hash = encodeState({ ...source, layers: { surf: { ...loaded("surf"), input: { forecast: true } } }, renderOps: [{ layerId: "surf", mode: "points", visible: true }] });
    expect(hash).toContain("&i=surf:forecast:true");
    // A layer without input writes no i=.
    expect(encodeState(source)).not.toContain("&i=");
  });

  it("round-trips the time mode, the compare and the 3D choice", () => {
    const cumulative = one({ layerId: "x", mode: "points", visible: true }, { time: { window: ["2019-01-01", "2020-01-01"], mode: "cumulative" } });
    expect(cumulative?.time).toEqual({ start: "2019-01-01", end: "2020-01-01", mode: "cumulative" });
    expect(one({ layerId: "x", mode: "points", visible: true }, { time: { window: ["2019-01-01", "2020-01-01"], mode: "slide" } })?.time).toEqual({ start: "2019-01-01", end: "2020-01-01" });

    const compare: CompareState = {
      layerId: "x",
      mode: "swipe",
      a: ["2021-01-01", "2021-12-31"],
      b: ["2024-01-01", "2024-12-31"],
      by: { key: "kind", a: ["2021"], b: ["current"] },
      aLabel: "Before",
      bLabel: "After, now",
    };
    expect(one({ layerId: "x", mode: "polygons", visible: true }, { compare })?.compare).toEqual(compare);
    const paused: CompareState = { layerId: "x", mode: "toggle", a: ["", ""], b: ["", ""], scenario: { a: 1, b: 5 }, side: "b", paused: true };
    expect(one({ layerId: "x", mode: "polygons", visible: true }, { compare: paused })?.compare).toEqual(paused);
    // A running toggle's side flips every second: it is not written.
    expect(one({ layerId: "x", mode: "polygons", visible: true }, { compare: { ...paused, paused: false } })?.compare).toEqual({ layerId: "x", mode: "toggle", a: ["", ""], b: ["", ""], scenario: { a: 1, b: 5 } });
    // A compare on a layer the link does not load is left out.
    expect(encodeState({ ...source, compare: { ...compare, layerId: "gone" } })).not.toContain("&c=");
    expect(decodeState("#v=0,0,2&c=%7Bgarbage")?.compare).toBeUndefined();

    expect(one({ layerId: "x", mode: "points", visible: true }, { flattened: true, terrain: false })).toMatchObject({ flattened: true, terrain: false });
    expect(encodeState(source)).not.toMatch(/3d=|relief=/);
  });
});

describe("a restored link draws the sender's map, settings applied after the data arrives", () => {
  const surfFeatures = Array.from({ length: 8 }, (_, i) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [-122.5 + i * 0.01, 37.6] },
    properties: { name: `Spot ${i}`, kind: i % 2 ? "forecast" : "buoy", v: i * 0.5 },
  }));
  const surfResult: LayerResult = { ...result, data: { type: "FeatureCollection", features: surfFeatures } };
  const catalog: LayerCatalog = { surf: { title: "Surf", style: { geometry: "point", color: "#000" } } };
  const run = (state: MapState, actions: MapAction[]) => actions.reduce(reduce, state);
  const agent = (state: MapState, name: string, input: unknown, output: unknown) =>
    run(state, toolResultToActions(name, input, output, { width: 1200, height: 800 }, catalog, state.renderOps));

  function senderMap(): MapState {
    let state = agent(initialMapState, "query_surf", { bbox: [-122.6, 37.5, -122.3, 37.7], zoom: 11, forecast: true }, surfResult);
    state = agent(state, "render", {}, {
      layerId: "surf",
      mode: "hexbin",
      view: "density",
      hexBasis: "share",
      hexShare: "forecast",
      rankBy: "v",
      filters: { kind: { include: ["forecast"] }, v: { range: [1, 3] } },
    });
    // The person then draws it as symbols, fades it and recolors it in the layer row.
    return run(state, [
      { type: "set_style", layerId: "surf", mode: "points", color: "#123456" },
      { type: "set_opacity", layerId: "surf", opacity: 0.4 },
      { type: "set_view", viewport: { longitude: -122.45, latitude: 37.6, zoom: 11, pitch: 0, bearing: 0 } },
    ]);
  }

  async function restore(hash: string, from: MapState) {
    let state = from;
    const fetchLayer = vi.fn(async (): Promise<LayerResult> => {
      await new Promise((r) => setTimeout(r, 5));
      return surfResult;
    });
    await restoreFromPermalink(hash, (a) => (state = reduce(state, a)), fetchLayer, { catalog, canvas: { width: 1200, height: 800 } });
    return { state, fetchLayer };
  }

  it("asks for the forecast again and restores filters, view, hex basis, rank, mode, color and opacity", async () => {
    const sender = senderMap();
    expect(sender.layers.surf.input).toEqual({ forecast: true });
    expect(sender.renderOps[0]).toMatchObject({ mode: "points", view: "density", hexBasis: "share:forecast", rankBy: "v", opacity: 0.4, color: "#123456" });

    const { state, fetchLayer } = await restore(encodeState(sender), initialMapState);
    expect(fetchLayer).toHaveBeenCalledWith("surf", expect.any(Array), 11, { forecast: true });
    expect(state.renderOps).toEqual(sender.renderOps);
    expect(state.layers.surf.input).toEqual({ forecast: true });
    // Shared again, the restored map writes the same link.
    expect(encodeState(state)).toBe(encodeState(sender));
  });

  it("replaces a map that already had the layer with other settings (a link pasted into the same tab)", async () => {
    let other = agent(initialMapState, "query_surf", { bbox: [-122.6, 37.5, -122.3, 37.7] }, surfResult);
    other = run(other, [{ type: "set_style", layerId: "surf", mode: "heat" }, { type: "clear_layers" }]);
    const sender = senderMap();
    const { state } = await restore(encodeState(sender), other);
    expect(state.renderOps).toEqual(sender.renderOps);
  });

  it("an old link without a view still lets the data pick one, as before", async () => {
    const { state } = await restore("#v=-122.45,37.6,11,0,0&l=surf:hexbin:1::share%3Aforecast", initialMapState);
    expect(state.renderOps[0]).toMatchObject({ layerId: "surf", mode: "hexbin", hexBasis: "share:forecast" });
    expect(state.layers.surf.input).toBeUndefined();
  });

  it("restores a paused compare on side B and a cumulative time window", async () => {
    const dated = surfFeatures.map((f, i) => ({ ...f, properties: { ...f.properties, t: `20${18 + i}-06-01` } }));
    const datedResult: LayerResult = { ...result, data: { type: "FeatureCollection", features: dated } };
    let sender = agent(initialMapState, "query_surf", { bbox: [-122.6, 37.5, -122.3, 37.7] }, datedResult);
    sender = run(sender, [
      { type: "set_time_mode", mode: "cumulative" },
      { type: "set_compare", compare: { layerId: "surf", mode: "toggle", a: ["2018-01-01", "2019-12-31"], b: ["2022-01-01", "2025-12-31"] } },
      { type: "compare_flip" },
      { type: "set_compare_paused", paused: true },
    ]);
    let state = initialMapState;
    await restoreFromPermalink(encodeState(sender), (a) => (state = reduce(state, a)), async () => datedResult, { catalog, canvas: { width: 1200, height: 800 } });
    expect(state.compare).toEqual(sender.compare);
    expect(state.time?.mode).toBe("cumulative");
    expect(state.time?.window).toEqual(sender.time?.window);
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
