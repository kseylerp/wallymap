import type { Feature, Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import type { StyleHints } from "@/layers/types";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";
import { boundsOf, changeMeasures, defaultView, rankedFilters, viewCaption, viewTarget } from "@/lib/render/views";
import { buildDeckLayers, lostAreas } from "@/lib/render/deck";
import { changeText } from "@/components/CompareControl";

const square = (w: number, s: number, size: number): Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [w + size, s], [w + size, s + size], [w, s + size], [w, s]]],
});
const area = (props: Record<string, unknown>, geometry: Polygon): Feature => ({ type: "Feature", geometry, properties: props });
const point = (lng: number, lat: number, props: Record<string, unknown>): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties: props,
});
const citation = { source: "s", url: "https://example.com", retrieved: "2026-10-14" };
const layer = (id: string, style: StyleHints, features: Feature[]): LoadedLayer => ({
  id,
  title: id,
  style,
  result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation },
  receivedAt: "2026-10-14T00:00:00Z",
});

const monumentStyle: StyleHints = {
  geometry: "polygon",
  color: "#3A3A3C",
  facets: [
    { key: "kind", label: "Boundary", kind: "category", versions: true, values: [{ value: "2021", label: "2021 boundary" }, { value: "current", label: "Current boundary" }] },
  ],
};
/** Bears Ears as the monuments layer returns it: the 2021 outline (two parts) and the much smaller current one inside it. */
const bearsEars = layer("monuments", monumentStyle, [
  area({ name: "Bears Ears", kind: "2021", areaKm2: 5678, v: 5678 }, square(-110.6, 37.0, 1.0)),
  area({ name: "Bears Ears", kind: "2021", areaKm2: 266, v: 266 }, square(-109.4, 37.6, 0.2)),
  area({ name: "Bears Ears", kind: "current", areaKm2: 487, v: 487 }, square(-110.0, 37.4, 0.3)),
]);

function run(state: MapState, ...actions: MapAction[]): MapState {
  return actions.reduce(reduce, state);
}

describe("defaultView: the view the data asks for when the agent names none", () => {
  it("picks change for two versions, detail for one feature, timeline for dates, density for many points", () => {
    expect(defaultView(bearsEars)).toBe("change");
    expect(defaultView(layer("lakes", { geometry: "point", color: "#000" }, [point(0, 0, { v: 1 })]))).toBe("detail");
    const dated = [2019, 2020, 2021].map((y) => point(y, 0, { t: `${y}-07-01` }));
    expect(defaultView(layer("fires", { geometry: "point", color: "#000" }, dated))).toBe("timeline");
    const twoSurveys = [2015, 2015, 2025, 2025].map((y, i) => point(i, 0, { t: `${y}-08-01` }));
    expect(defaultView(layer("glaciers", { geometry: "point", color: "#000" }, twoSurveys))).toBe("change");
    const many = Array.from({ length: 501 }, (_, i) => point(i / 100, 0, {}));
    expect(defaultView(layer("gbif", { geometry: "point", color: "#000" }, many))).toBe("density");
    expect(defaultView(layer("x", { geometry: "point", color: "#000" }, many.slice(0, 20)))).toBeUndefined();
  });
});

describe("the change view (owner, Bears Ears: 'How has Bears Ears changed since 2021?')", () => {
  const named = run(initialMapState, { type: "turn_start" }, { type: "place_named", bbox: [-112, 36, -108, 39] });
  const loaded = run(named, { type: "layer_loaded", layer: bearsEars });
  const s = run(loaded, { type: "render", op: { layerId: "monuments", mode: "polygons", visible: true, view: "change" } });

  it("fits the camera to the union of both versions, not the geocoded region", () => {
    expect(s.camera?.bbox[0]).toBeCloseTo(-110.6);
    expect(s.camera?.bbox[1]).toBeCloseTo(37.0);
    expect(s.camera?.bbox[2]).toBeCloseTo(-109.2);
    expect(s.camera?.bbox[3]).toBeCloseTo(38.0);
  });

  it("opens the compare by version (2021 against current), delta, with swipe and toggle a click away", () => {
    expect(s.compare).toMatchObject({
      layerId: "monuments",
      mode: "delta",
      by: { key: "kind", a: ["2021"], b: ["current"] },
      aLabel: "2021 boundary",
      bLabel: "Current boundary",
    });
    expect(run(s, { type: "set_compare_mode", mode: "swipe" }).compare?.mode).toBe("swipe");
    expect(s.renderOps[0].view).toBe("change");
  });

  it("draws the 2021-only outline as lost (pink hatch) and the current one as gained (purple)", () => {
    const drawn = visibleState(s).layers.monuments;
    if (drawn.result.kind !== "geojson") throw new Error("expected geojson");
    expect(drawn.result.data.features.map((f) => f.properties?.delta)).toEqual(["a-only", "a-only", "b-only"]);
    expect(lostAreas(drawn.result.data).features).toHaveLength(2);
    expect(buildDeckLayers(visibleState(s)).length).toBeGreaterThan(0);
  });

  it("states both areas and the difference in the legend, and names the encoding in words", () => {
    const a = { type: "FeatureCollection" as const, features: bearsEars.result.kind === "geojson" ? bearsEars.result.data.features.slice(0, 2) : [] };
    const b = { type: "FeatureCollection" as const, features: bearsEars.result.kind === "geojson" ? bearsEars.result.data.features.slice(2) : [] };
    const m = changeMeasures(bearsEars, a, b);
    expect(m).toMatchObject({ a: { total: 5944 }, b: { total: 487 }, difference: -5457, unit: "km²" });
    expect(changeText("2021 boundary", "Current boundary", m)).toBe("2021 boundary 5,944 km² · Current boundary 487 km² · difference −5,457 km²");
    expect(viewCaption("change", bearsEars, s.compare)).toBe("Pink hatch: only 2021 boundary · purple: current boundary · grey: both");
  });

  it("never moves the camera for a 'here' question (no place named this turn)", () => {
    const here = run(s, { type: "turn_start" }, { type: "layer_loaded", layer: { ...bearsEars, receivedAt: "later" } });
    expect(here.camera).toEqual(s.camera);
  });
});

describe("a named place's answer fits the returned features (spec §12)", () => {
  it("fits each load to the union so far, falls back to the place when nothing drawable came back, and stops after set_view", () => {
    const s0 = run(initialMapState, { type: "place_named", bbox: [-111, 38, -109, 39] });
    const s1 = run(s0, { type: "layer_loaded", layer: layer("peaks", { geometry: "point", color: "#000" }, [point(-110, 38.5, {}), point(-109.8, 38.6, {})]) });
    expect(s1.camera?.bbox).toEqual([-110, 38.5, -109.8, 38.6]);
    const settled = run(initialMapState, { type: "place_named", bbox: [-111, 38, -109, 39] }, { type: "place_settle" });
    expect(settled.camera?.bbox).toEqual([-111, 38, -109, 39]);
    const framed = run(s0, { type: "place_framed" }, { type: "layer_loaded", layer: layer("peaks", { geometry: "point", color: "#000" }, [point(-110, 38.5, {})]) });
    expect(framed.camera).toBeUndefined();
  });
});

describe("the ranked and detail views", () => {
  const style: StyleHints = { geometry: "point", color: "#000", unit: "score", facets: [{ key: "hazardScore", label: "Hazard score", kind: "range", encode: "size" }] };
  const mines = layer("uranium", style, Array.from({ length: 30 }, (_, i) => point(-109 + i / 100, 36, { name: `Mine ${i}`, hazardScore: (i + 1) * 10, v: (i + 1) * 10 })));

  it("puts the facet slider at the top ten and fits the camera to them", () => {
    expect(rankedFilters(mines, undefined)).toEqual({ hazardScore: { range: [210, 300] } });
    const s = run(
      initialMapState,
      { type: "place_named", bbox: [-112, 35, -106, 38] },
      { type: "layer_loaded", layer: mines },
      { type: "render", op: { layerId: "uranium", mode: "points", visible: true, view: "ranked" } },
    );
    expect(s.renderOps[0]).toMatchObject({ view: "ranked", filters: { hazardScore: { range: [210, 300] } } });
    expect(viewTarget("ranked", mines)?.[0]).toBeCloseTo(-109 + 20 / 100);
    expect(viewCaption("ranked", mines)).toBe("Symbol size: hazard score; the top 10 named");
  });

  it("selects the one feature and frames it in the lower third", () => {
    const lake = layer("lakes", { geometry: "point", color: "#000" }, [point(-120, 39, { name: "Tahoe", v: 501 })]);
    const s = run(
      initialMapState,
      { type: "place_named", bbox: [-121, 38, -119, 40] },
      { type: "layer_loaded", layer: lake },
      { type: "render", op: { layerId: "lakes", mode: "points", visible: true }, defaultMode: true },
    );
    expect(s.selected?.feature.properties?.name).toBe("Tahoe");
    expect(s.camera?.lowerThird).toBe(true);
    expect(boundsOf([s.selected!.feature])).toEqual([-120, 39, -120, 39]);
  });

  it("draws a density view as clusters, keeping heat when asked", () => {
    const many = layer("gbif", { geometry: "point", color: "#000" }, Array.from({ length: 600 }, (_, i) => point(i / 1000, 0, {})));
    const s = run(initialMapState, { type: "layer_loaded", layer: many }, { type: "render", op: { layerId: "gbif", mode: "points", visible: true, view: "density" } });
    expect(s.renderOps[0].mode).toBe("clusters");
    const heat = run(s, { type: "render", op: { layerId: "gbif", mode: "heat", visible: true, view: "density" } });
    expect(heat.renderOps[0].mode).toBe("heat");
  });
});
