import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature, Geometry } from "geojson";
import "@/layers";
import { createTurn } from "@/lib/agent/turn";
import { toolResultToActions, type LayerCatalog } from "@/lib/agent/applyToolResult";
import { reduce } from "@/lib/render/reducer";
import { initialMapState } from "@/lib/render/state";
import type { LayerResult } from "@/layers/types";

const answers = new Map<string, LayerResult>();
vi.mock("@/lib/layers/run", () => ({
  runLayer: vi.fn(async (id: string) => ({ status: 200, body: answers.get(id) ?? { error: "no fixture" } })),
}));
vi.mock("./reach", async (orig) => ({
  ...(await orig<typeof import("./reach")>()),
  driveReach: vi.fn(async (center: [number, number]) => ({
    area: { type: "Feature", geometry: square(center[0] - 0.05, center[1] - 0.05, 0.1).geometry, properties: { name: "30-minute drive" } },
    method: "straight-line",
    caveat: "The road router did not answer, so this is a straight-line 30 km circle (1 km per minute); winding or mountain roads take longer.",
    citation: { source: "Straight-line distance (no road router answered)", url: "https://valhalla1.openstreetmap.de", retrieved: "2026-10-23" },
  })),
}));

const { runCombine, combineOutputForModel, combineTool } = await import("./tool");

const f = (geometry: Geometry, properties: Record<string, unknown> = {}): Feature => ({ type: "Feature", geometry, properties });
function square(lon: number, lat: number, deg: number, name = "") {
  return f({ type: "Polygon", coordinates: [[[lon, lat], [lon + deg, lat], [lon + deg, lat + deg], [lon, lat + deg], [lon, lat]]] }, { name });
}
const geojson = (features: Feature[]): LayerResult => ({
  kind: "geojson",
  data: { type: "FeatureCollection", features },
  citation: { source: "OpenStreetMap contributors", url: "https://www.openstreetmap.org", retrieved: "2026-10-23" },
});

const BOX: [number, number, number, number] = [-122, 46.7, -121.5, 47];
const north = (m: number) => m / 111_195;

function turnWithQueries(...ids: string[]) {
  const turn = createTurn({ question: "Where can I camp along the Wonderland Trail?" });
  for (const id of ids) turn.queries.push({ layerId: id, bbox: BOX, inputKey: JSON.stringify([["includeParking", false]]), ok: true, drawable: true, wide: false });
  return turn;
}

beforeEach(() => {
  answers.clear();
  answers.set(
    "osm-trails",
    geojson([
      f({ type: "LineString", coordinates: [[-121.8, 46.85], [-121.6, 46.85]] }, { name: "Wonderland Trail" }),
      f({ type: "LineString", coordinates: [[-121.8, 46.95], [-121.6, 46.95]] }, { name: "Northern Loop Trail" }),
    ]),
  );
  answers.set(
    "campsites",
    geojson([
      f({ type: "Point", coordinates: [-121.75, 46.85 + north(300)] }, { name: "Devil's Dream Camp", kind: "camp_site" }),
      f({ type: "Point", coordinates: [-121.7, 46.95 + north(100)] }, { name: "Yellowstone Cliffs Camp", kind: "camp_site" }),
      f({ type: "Point", coordinates: [-121.65, 46.85 + north(5000)] }, { name: "Far Camp", kind: "camp_site" }),
    ]),
  );
  answers.set("grazing-allotments", geojson([square(0, 0, 1, "Beaver Dam Slope"), square(3, 0, 1, "Far Allotment")]));
  answers.set("critical-habitat", geojson([square(0.5, 0, 1, "Upper Virgin River unit")]));
});

describe("runCombine", () => {
  it("along a named trail: the camps within 1 km, a title and a sentence to quote", async () => {
    const turn = turnWithQueries("osm-trails", "campsites");
    const out = await runCombine({ op: "along", a: { layerId: "campsites" }, b: { layerId: "osm-trails", match: "Wonderland Trail" }, distance: 1, unit: "km" }, turn, null);
    if ("error" in out) throw new Error(out.error);
    expect(out.title).toBe("Campsites within 1 km of the Wonderland Trail");
    expect(out.data.features.map((x) => x.properties?.name)).toEqual(["Devil's Dream Camp"]);
    expect(out.data.features[0].properties).toMatchObject({ kind: "camp_site", nearest: "Wonderland Trail" });
    expect(out.combined.statement).toBe("1 of 3 campsites are within 1 km of the Wonderland Trail; the closest is 0.3 km away.");
    expect(out.combined.id).toBe("combine:campsites-along-the-wonderland-trail");
    expect(out.legend).toMatchObject({ kind: "symbol", title: out.title });
    expect(out.combined.facts[0]).toMatchObject({ key: "distanceKm", format: "km" });
  });

  it("asks each layer again with the inputs the turn used", async () => {
    const { runLayer } = await import("@/lib/layers/run");
    const turn = turnWithQueries("osm-trails", "campsites");
    await runCombine({ op: "near", a: { layerId: "campsites" }, b: { layerId: "osm-trails" }, unit: "mi", distance: 0.5 }, turn, null);
    expect(vi.mocked(runLayer)).toHaveBeenCalledWith("campsites", { bbox: BOX, input: { includeParking: false } });
  });

  it("filters A first, like render.filters", async () => {
    const turn = turnWithQueries("osm-trails", "campsites");
    const out = await runCombine(
      { op: "near", a: { layerId: "campsites", filters: { name: { match: "far" } } }, b: { layerId: "osm-trails" }, distance: 10, unit: "km" },
      turn,
      null,
    );
    if ("error" in out) throw new Error(out.error);
    expect(out.data.features.map((x) => x.properties?.name)).toEqual(["Far Camp"]);
  });

  it("overlap: allotments clipped to habitat, with acres in the statement", async () => {
    const turn = turnWithQueries("grazing-allotments", "critical-habitat");
    const out = await runCombine({ op: "overlap", a: { layerId: "grazing-allotments" }, b: { layerId: "critical-habitat" }, unit: "km" }, turn, null);
    if ("error" in out) throw new Error(out.error);
    expect(out.data.features.map((x) => [x.properties?.name, x.properties?.overlapShare])).toEqual([["Beaver Dam Slope", 0.5]]);
    expect(out.combined.statement).toMatch(/^1 of 2 BLM grazing allotments are overlapping .*: [\d,.]+ km² \([\d,]+ acres\), 25% of their [\d,.]+ km²\.$/);
    expect(out.combined.style.geometry).toBe("polygon");
  });

  it("keeps a side to the question's own filters when the model sets none: \"in drought\" is D1 to D4, not D0", async () => {
    const turn = createTurn({ question: "Wild horse areas in Nevada that are in drought right now" });
    for (const id of ["grazing-allotments", "drought"]) turn.queries.push({ layerId: id, bbox: BOX, inputKey: "[]", ok: true, drawable: true, wide: false });
    answers.set("grazing-allotments", geojson([square(0, 0, 1, "Beaver Dam Slope"), square(3, 0, 1, "Far Allotment")].map((x) => ({ ...x, properties: { ...x.properties, animals: ["horses"] } }))));
    answers.set("drought", geojson([{ ...square(0, 0, 1), properties: { kind: "D0" } }, { ...square(3, 0, 1), properties: { kind: "D2" } }]));
    const out = await runCombine({ op: "overlap", a: { layerId: "grazing-allotments" }, b: { layerId: "drought" }, unit: "km" }, turn, null);
    if ("error" in out) throw new Error(out.error);
    expect(out.data.features.map((x) => x.properties?.name)).toEqual(["Far Allotment"]);
  });

  it("outside on areas that carry an amount: shares the amount by area, and says it is spread evenly", async () => {
    answers.set("old-growth", geojson([{ ...square(0, 0, 1, "Battle Peak"), properties: { name: "Battle Peak", v: 50_000 } }]));
    answers.set("wilderness", geojson([square(0, 0, 0.5, "Kalmiopsis Wilderness")]));
    const turn = turnWithQueries("old-growth", "wilderness");
    const out = await runCombine({ op: "outside", a: { layerId: "old-growth" }, b: { layerId: "wilderness" }, unit: "km" }, turn, null);
    if ("error" in out) throw new Error(out.error);
    expect(out.data.features[0].properties?.apportioned).toBe(37_500);
    expect(out.combined.statement).toBe("Of 50,000 acres of old-growth forest in 1 area, about 37,500 acres (75%) lie outside wilderness areas, in 1 of them, counting each area's amount as spread evenly over it.");
    expect(out.combined.facts.map((f) => f.key)).toContain("apportioned");
  });

  it("drive_time: from the place geocoded this turn, with the router's caveat", async () => {
    const turn = turnWithQueries("campsites");
    turn.place = { bbox: BOX, center: [-121.75, 46.86], name: "Paradise, Washington", source: "mapbox" } as never;
    const out = await runCombine({ op: "drive_time", a: { layerId: "campsites" }, minutes: 30, unit: "km" }, turn, null);
    if ("error" in out) throw new Error(out.error);
    expect(out.title).toBe("Campsites within 30 minutes' drive of Paradise");
    expect(out.combined.caveat).toMatch(/straight-line/);
    expect(out.coverageNote).toMatch(/straight-line/);
  });

  it("explains what it cannot do instead of throwing", async () => {
    const turn = turnWithQueries("osm-trails", "campsites");
    expect(await runCombine({ op: "within", a: { layerId: "campsites" }, b: { layerId: "osm-trails" }, unit: "km" }, turn, null)).toEqual({
      error: expect.stringMatching(/needs areas/),
    });
    expect(await runCombine({ op: "along", a: { layerId: "campsites" }, b: { layerId: "osm-trails", match: "Pacific Crest Trail" }, unit: "km" }, turn, null)).toEqual({
      error: expect.stringMatching(/No feature of osm-trails is named like "Pacific Crest Trail"/),
    });
    expect(await runCombine({ op: "near", a: { layerId: "campsites" }, unit: "km" }, turn, null)).toEqual({ error: expect.stringMatching(/needs b/) });
  });
});

describe("the combine tool on the turn and the map", () => {
  it("records the new layer as drawn, gives the model a compact answer, and the browser draws it over the hidden source", async () => {
    const turn = turnWithQueries("osm-trails", "campsites");
    const t = combineTool({ turn, view: null });
    const input = { op: "along" as const, a: { layerId: "campsites" }, b: { layerId: "osm-trails", match: "Wonderland Trail" }, unit: "km" as const };
    const output = await t.execute!(input, { toolCallId: "c1", messages: [] } as never);
    expect(turn.drawn.has("campsites")).toBe(true);
    expect(turn.drawn.has("combine:campsites-along-the-wonderland-trail")).toBe(true);
    const model = combineOutputForModel(output) as Record<string, unknown>;
    expect(model).toMatchObject({ count: 1, of: 3, top: [{ name: "Devil's Dream Camp", distanceKm: 0.3, nearest: "Wonderland Trail" }] });
    expect(JSON.stringify(model)).not.toContain("coordinates");

    const catalog: LayerCatalog = {
      campsites: { title: "Campsites", style: { geometry: "point", color: "#3A3A3C" }, card: { facts: [{ key: "kind", label: "Kind" }] } },
    };
    let state = initialMapState;
    state = reduce(state, { type: "layer_loaded", layer: { id: "campsites", title: "Campsites", style: { geometry: "point", color: "#3A3A3C" }, result: answers.get("campsites")!, receivedAt: "" } });
    state = reduce(state, { type: "render", op: { layerId: "campsites", mode: "points", visible: true } });
    for (const action of toolResultToActions("combine", input, output, { width: 1000, height: 800 }, catalog, state.renderOps)) state = reduce(state, action);
    const layer = state.layers["combine:campsites-along-the-wonderland-trail"];
    expect(layer.title).toBe("Campsites within 1 km of the Wonderland Trail");
    expect(layer.card?.facts?.map((x) => x.key)).toEqual(["distanceKm", "nearest", "kind"]);
    expect(state.renderOps.find((o) => o.layerId === layer.id)?.visible).toBe(true);
    expect(state.renderOps.find((o) => o.layerId === "campsites")?.visible).toBe(false);
  });

  it("dims the areas tested against under a join of areas, and a later render keeps them dimmed", async () => {
    const turn = turnWithQueries("grazing-allotments", "critical-habitat");
    const input = { op: "overlap" as const, a: { layerId: "grazing-allotments" }, b: { layerId: "critical-habitat" }, unit: "km" as const };
    const output = await combineTool({ turn, view: null }).execute!(input, { toolCallId: "c2", messages: [] } as never);
    let state = initialMapState;
    for (const id of ["grazing-allotments", "critical-habitat"]) {
      state = reduce(state, { type: "layer_loaded", layer: { id, title: id, style: { geometry: "polygon", color: "#3A3A3C" }, result: answers.get(id)!, receivedAt: "" } });
      state = reduce(state, { type: "render", op: { layerId: id, mode: "polygons", visible: true } });
    }
    for (const action of toolResultToActions("combine", input, output, { width: 1000, height: 800 }, {}, state.renderOps)) state = reduce(state, action);
    state = reduce(state, { type: "render", op: { layerId: "critical-habitat", mode: "polygons", visible: true } });
    expect(state.renderOps.find((o) => o.layerId === "critical-habitat")).toMatchObject({ visible: true, opacity: 0.4 });
    expect(state.renderOps.find((o) => o.layerId === "grazing-allotments")?.visible).toBe(false);
  });

  it("names a side by what was asked of it", async () => {
    const { sideNoun } = await import("./tool");
    const features = { id: "outdoor-features", title: "Huts, springs, peaks and other backcountry features" };
    expect(sideNoun(features, { kinds: ["waterfall"] })).toBe("Waterfalls");
    expect(sideNoun(features, { kinds: ["spring", "drinking_water"] })).toBe("Springs and drinking water");
    expect(sideNoun({ id: "critical-habitat", title: "Critical habitat" }, { species: "desert tortoise" })).toBe("Desert tortoise critical habitat");
    expect(sideNoun({ id: "campsites", title: "Campsites and parking lots" })).toBe("Campsites");
  });

  it("reads a render of \"combine\" as the combined layer drawn last", () => {
    const ops = [
      { layerId: "campsites", mode: "points" as const, visible: false },
      { layerId: "combine:campsites-along-the-wonderland-trail", mode: "points" as const, visible: true },
    ];
    const actions = toolResultToActions("render", {}, { layerId: "combine", view: "ranked" }, { width: 1, height: 1 }, {}, ops);
    expect(actions[0]).toMatchObject({ type: "render", op: { layerId: "combine:campsites-along-the-wonderland-trail", view: "ranked" } });
    expect(toolResultToActions("render", {}, { layerId: "combine" }, { width: 1, height: 1 }, {}, [])).toEqual([]);
  });

  it("maps an error or junk to no map actions", () => {
    expect(toolResultToActions("combine", {}, { error: "x" }, { width: 1, height: 1 }, {})).toEqual([]);
    expect(toolResultToActions("combine", {}, { kind: "geojson", data: {}, combined: { id: "not-prefixed" } }, { width: 1, height: 1 }, {})).toEqual([]);
  });
});
