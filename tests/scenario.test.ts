import { describe, expect, it } from "vitest";
import { SLR_SCENARIO, slrTileUrl } from "@/layers/sea-level-rise";
import { toolResultToActions } from "@/lib/agent/applyToolResult";
import { compareEntries, compareSideText, compareSides, defaultCompare, isComparable, modesFor } from "@/lib/render/compareView";
import { decodeState, encodeState, restoreFromPermalink } from "@/lib/render/permalink";
import { isMapReset, reduce } from "@/lib/render/reducer";
import { currentScenarioValue, loadedScenarioValue, scenarioReadout, scenarioTileUrl, scenarioValueText, snapScenarioValue } from "@/lib/render/scenario";
import { initialMapState, type CompareState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";
import { isTileSwipe, tileSwipeLayers } from "@/lib/render/tileSides";
import { visibleState } from "@/lib/render/view";

const slr = (feet = 3): LoadedLayer => ({
  id: "sea-level-rise",
  title: "Sea level rise flooding",
  style: { geometry: "polygon", color: "#000000" },
  result: {
    kind: "tiles",
    data: { url: slrTileUrl(feet), minzoom: 0, maxzoom: 16, format: "raster", scenario: SLR_SCENARIO },
    citation: { source: "NOAA", url: "https://coast.noaa.gov/slr/", retrieved: "r" },
  },
  receivedAt: "2026-10-14T00:00:00.000Z",
});

const lights: LoadedLayer = {
  id: "night-lights",
  title: "Night lights",
  style: { geometry: "polygon", color: "#000000" },
  result: {
    kind: "tiles",
    data: { url: "https://t/{z}/{y}/{x}", minzoom: 0, maxzoom: 8, format: "raster" },
    citation: { source: "s", url: "u", retrieved: "r" },
  },
  receivedAt: "2026-10-13T00:00:00.000Z",
};

function run(state: MapState, ...actions: MapAction[]): MapState {
  return actions.reduce(reduce, state);
}

const loaded = run(
  initialMapState,
  { type: "layer_loaded", layer: slr() },
  { type: "render", op: { layerId: "sea-level-rise", mode: "polygons", visible: true } },
);

function urlOf(state: MapState, id = "sea-level-rise"): string | undefined {
  const layer = visibleState(state).layers[id];
  return layer?.result.kind === "tiles" ? layer.result.data.url : undefined;
}

describe("scenario helpers", () => {
  it("fills the template per value through the service tokens", () => {
    expect(scenarioTileUrl(SLR_SCENARIO, 0)).toContain("/slr_0ft/");
    expect(scenarioTileUrl(SLR_SCENARIO, 0.5)).toContain("/slr_0_5ft/");
    expect(scenarioTileUrl(SLR_SCENARIO, 10)).toContain("/slr_10ft/");
    // Without tokens the number is written as is.
    expect(scenarioTileUrl({ ...SLR_SCENARIO, tokens: undefined, template: "x/{value}/y" }, 2.5)).toBe("x/2.5/y");
  });

  it("snaps to the nearest listed value and reads the loaded value back from the URL", () => {
    expect(snapScenarioValue(SLR_SCENARIO, 3.2)).toBe(3);
    expect(snapScenarioValue(SLR_SCENARIO, 3.3)).toBe(3.5);
    expect(snapScenarioValue(SLR_SCENARIO, 40)).toBe(10);
    expect(snapScenarioValue(SLR_SCENARIO, Number.NaN)).toBeUndefined();
    expect(loadedScenarioValue(slr(7).result)).toBe(7);
    expect(loadedScenarioValue(lights.result)).toBeUndefined();
  });

  it("reads out feet, metres and inches with each other's conversions", () => {
    expect(scenarioReadout(3, "ft")).toBe("3 ft · 0.9 m · 36 in");
    expect(scenarioReadout(0.5, "ft")).toBe("0.5 ft · 0.2 m · 6 in");
    expect(scenarioReadout(10, "ft")).toBe("10 ft · 3 m · 120 in");
    expect(scenarioReadout(0, "ft")).toBe("0 ft · 0 m · 0 in");
    expect(scenarioReadout(1, "m")).toBe("1 m · 3.3 ft · 39 in");
    expect(scenarioReadout(36, "in")).toBe("36 in · 3 ft · 0.9 m");
    expect(scenarioReadout(2, "°C")).toBe("2 °C");
    expect(scenarioValueText(1.5, "ft")).toBe("1.5 ft");
  });
});

describe("scenario reducer", () => {
  it("starts at the queried amount and moves with set_scenario, snapped", () => {
    expect(loaded.scenario).toBeUndefined();
    expect(currentScenarioValue(loaded, "sea-level-rise")).toBe(3);
    const six = run(loaded, { type: "set_scenario", layerId: "sea-level-rise", value: 6.1 });
    expect(six.scenario).toEqual({ layerId: "sea-level-rise", value: 6, playing: false });
    expect(currentScenarioValue(six, "sea-level-rise")).toBe(6);
    // The same amount again changes nothing.
    expect(run(six, { type: "set_scenario", layerId: "sea-level-rise", value: 6 })).toBe(six);
  });

  it("ignores layers without a scenario", () => {
    const state = run(loaded, { type: "layer_loaded", layer: lights });
    expect(run(state, { type: "set_scenario", layerId: "night-lights", value: 2 })).toBe(state);
    expect(run(state, { type: "set_scenario", layerId: "missing", value: 2 })).toBe(state);
    expect(run(state, { type: "set_scenario_playing", layerId: "night-lights", playing: true })).toBe(state);
  });

  it("plays one half foot per tick and stops on 10 ft; play from the end starts over at 0", () => {
    let state = run(loaded, { type: "set_scenario", layerId: "sea-level-rise", value: 9 });
    state = run(state, { type: "set_scenario_playing", layerId: "sea-level-rise", playing: true });
    expect(state.scenario).toEqual({ layerId: "sea-level-rise", value: 9, playing: true });
    state = run(state, { type: "scenario_tick" }, { type: "scenario_tick" });
    expect(state.scenario).toEqual({ layerId: "sea-level-rise", value: 10, playing: true });
    state = run(state, { type: "scenario_tick" });
    expect(state.scenario).toEqual({ layerId: "sea-level-rise", value: 10, playing: false });
    // A tick while paused does nothing.
    expect(run(state, { type: "scenario_tick" })).toBe(state);
    state = run(state, { type: "set_scenario_playing", layerId: "sea-level-rise", playing: true });
    expect(state.scenario).toEqual({ layerId: "sea-level-rise", value: 0, playing: true });
    state = run(state, { type: "set_scenario_playing", layerId: "sea-level-rise", playing: false });
    expect(state.scenario?.playing).toBe(false);
  });

  it("is cleared by clear_scenario, a re-query, removing the layer, clear_layers and reset_map", () => {
    const moved = run(loaded, { type: "set_scenario", layerId: "sea-level-rise", value: 6 });
    expect(run(moved, { type: "clear_scenario" }).scenario).toBeUndefined();
    const requeried = run(moved, { type: "layer_loaded", layer: slr(2) });
    expect(requeried.scenario).toBeUndefined();
    expect(currentScenarioValue(requeried, "sea-level-rise")).toBe(2);
    expect(run(moved, { type: "remove_layer", layerId: "sea-level-rise" }).scenario).toBeUndefined();
    expect(run(moved, { type: "clear_layers" }).scenario).toBeUndefined();
    const reset = run(moved, { type: "reset_map" });
    expect(reset.scenario).toBeUndefined();
    expect(isMapReset(reset)).toBe(true);
  });
});

describe("scenario tile URL", () => {
  it("rewrites the drawn URL per value and leaves the queried one alone", () => {
    expect(urlOf(loaded)).toBe(slrTileUrl(3));
    for (const feet of [0, 0.5, 6, 10]) {
      const state = run(loaded, { type: "set_scenario", layerId: "sea-level-rise", value: feet });
      expect(urlOf(state)).toBe(scenarioTileUrl(SLR_SCENARIO, feet));
      // The loaded result is untouched: × goes back to it.
      expect(state.layers["sea-level-rise"].result).toBe(loaded.layers["sea-level-rise"].result);
    }
  });

  it("gives the same layer object for the same value (the map sees no change)", () => {
    const a = run(loaded, { type: "set_scenario", layerId: "sea-level-rise", value: 6 });
    const b = run(a, { type: "set_view", viewport: { zoom: 9, pitch: 0 } });
    expect(visibleState(b).layers["sea-level-rise"]).toBe(visibleState(a).layers["sea-level-rise"]);
  });
});

describe("scenario permalink", () => {
  it("round-trips s=<layer>:<value>", () => {
    const state = run(loaded, { type: "set_scenario", layerId: "sea-level-rise", value: 6.5 });
    const hash = encodeState({ ...state, scenario: state.scenario });
    expect(hash).toContain("s=sea-level-rise:6.5");
    expect(decodeState(hash)?.scenario).toEqual({ layerId: "sea-level-rise", value: 6.5 });
  });

  it("leaves s= out for a layer the link does not load, and skips a malformed one", () => {
    const hash = encodeState({ ...loaded, scenario: { layerId: "other", value: 2 } });
    expect(hash).not.toContain("s=");
    expect(decodeState("#v=0,0,2&s=sea-level-rise:abc")?.scenario).toBeUndefined();
    expect(decodeState("#v=0,0,2&s=:3")?.scenario).toBeUndefined();
  });

  it("restores the amount after the layer loads", async () => {
    const hash = "#v=-80.55843,25.78556,8.67,0,0&b=outdoors-satellite&l=sea-level-rise:polygons:1&s=sea-level-rise:6";
    let state = initialMapState;
    const dispatch = (action: MapAction) => {
      state = reduce(state, action);
    };
    const catalog = { "sea-level-rise": { title: "Sea level rise", style: slr().style } };
    await restoreFromPermalink(hash, dispatch, async () => slr().result, { catalog, canvas: { width: 1200, height: 800 } });
    expect(state.scenario).toEqual({ layerId: "sea-level-rise", value: 6, playing: false });
    expect(urlOf(state)).toContain("/slr_6ft/");
  });
});

describe("scenario compare", () => {
  const compare: CompareState = { layerId: "sea-level-rise", a: ["", ""], b: ["", ""], mode: "swipe", scenario: { a: 1, b: 5 } };

  it("compares a scenario layer by swipe or toggle", () => {
    expect(isComparable(slr())).toBe(true);
    expect(modesFor(slr())).toEqual(["swipe", "toggle"]);
    expect(modesFor(lights)).toEqual(["toggle"]);
  });

  it("points side A and side B at their amounts", () => {
    const sides = compareSides(slr(), undefined, compare);
    expect(sides.a.result.kind === "tiles" && sides.a.result.data.url).toContain("/slr_1ft/");
    expect(sides.b.result.kind === "tiles" && sides.b.result.data.url).toContain("/slr_5ft/");
    expect(sides.b.id).toBe("sea-level-rise~b");
    const entries = compareEntries(slr(), undefined, compare, "swipe");
    expect(Object.keys(entries)).toEqual(["sea-level-rise", "sea-level-rise~b"]);
  });

  it("keeps time compares on tiles unchanged", () => {
    const timeCompare: CompareState = { layerId: "night-lights", a: ["2020-01-01", "2020-01-01"], b: ["2026-10-10", "2026-10-10"], mode: "toggle" };
    const sides = compareSides(lights, undefined, timeCompare);
    expect(sides.a.result.kind === "tiles" && sides.a.result.data.url).toBe("https://t/{z}/{y}/{x}");
  });

  it("opens on A 1 ft and B 5 ft, swiping, and names the sides by amount", () => {
    const opened = defaultCompare(slr(), new Date("2026-10-14"));
    expect(opened).toMatchObject({ layerId: "sea-level-rise", mode: "swipe", scenario: { a: 1, b: 5 } });
    expect(compareSideText(opened, "a", slr())).toBe("1 ft");
    expect(compareSideText({ ...opened, bLabel: "High 2100" }, "b", slr())).toBe("High 2100");
  });

  it("snaps the amounts in the reducer and pauses the scenario scrubber", () => {
    const playing = run(loaded, { type: "set_scenario_playing", layerId: "sea-level-rise", playing: true });
    const state = run(playing, { type: "set_compare", compare: { ...compare, scenario: { a: 1.1, b: 4.8 } } });
    expect(state.compare?.scenario).toEqual({ a: 1, b: 5 });
    expect(state.scenario?.playing).toBe(false);
    // A layer without a scenario drops the amounts.
    const other = run(loaded, { type: "layer_loaded", layer: lights }, { type: "set_compare", compare: { ...compare, layerId: "night-lights" } });
    expect(other.compare?.scenario).toBeUndefined();
  });

  it("draws a swipe's sides as deck tile layers and hides nothing else", () => {
    const state = run(loaded, { type: "set_compare", compare });
    expect(isTileSwipe(state)).toBe(true);
    const sides = tileSwipeLayers(visibleState(state));
    expect(sides.a).toHaveLength(1);
    expect(sides.b).toHaveLength(1);
    expect((sides.a[0].props as { data: string }).data).toContain("/slr_1ft/");
    expect((sides.b[0].props as { data: string }).data).toContain("/slr_5ft/");
    const toggled = run(state, { type: "set_compare_mode", mode: "toggle" });
    expect(isTileSwipe(toggled)).toBe(false);
    expect(tileSwipeLayers(visibleState(toggled))).toEqual({ a: [], b: [] });
    const hidden = run(state, { type: "toggle_layer", layerId: "sea-level-rise" });
    expect(tileSwipeLayers(visibleState(hidden))).toEqual({ a: [], b: [] });
  });
});

describe("scenario from the agent", () => {
  const canvas = { width: 1200, height: 800 };

  it("render.scenario sets the amount after the render op", () => {
    const actions = toolResultToActions("render", {}, { layerId: "sea-level-rise", scenario: 6 }, canvas, {});
    expect(actions).toEqual([
      { type: "render", op: { layerId: "sea-level-rise", mode: "points", visible: true }, defaultMode: true },
      { type: "set_scenario", layerId: "sea-level-rise", value: 6 },
    ]);
  });

  it("compare with scenario [a, b] needs no windows and swipes by default", () => {
    const [action] = toolResultToActions("compare", {}, { layerId: "sea-level-rise", scenario: [1, 5], mode: "delta" }, canvas, {});
    expect(action).toEqual({
      type: "set_compare",
      compare: { layerId: "sea-level-rise", a: ["", ""], b: ["", ""], mode: "swipe", scenario: { a: 1, b: 5 } },
    });
    const [toggle] = toolResultToActions("compare", {}, { layerId: "sea-level-rise", scenario: [1, 5], mode: "toggle", aLabel: "2050" }, canvas, {});
    expect(toggle).toMatchObject({ compare: { mode: "toggle", aLabel: "2050" } });
    expect(toolResultToActions("compare", {}, { layerId: "sea-level-rise", scenario: [1] }, canvas, {})).toEqual([]);
  });
});
