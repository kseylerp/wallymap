import type { Feature, FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";

const feat = (t?: string): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [0, 0] },
  properties: t === undefined ? {} : { t },
});
const fc = (...ts: (string | undefined)[]): FeatureCollection => ({ type: "FeatureCollection", features: ts.map(feat) });
const layer = (id: string, data: FeatureCollection): LoadedLayer => ({
  id,
  title: id,
  style: { geometry: "polygon", color: "#000000" },
  result: { kind: "geojson", data, citation: { source: "s", url: "u", retrieved: "r" } },
  receivedAt: "now",
});

/** Fires dated every year 2016 through 2025 (ten yearly buckets, over the 10-year month limit by a day or so). */
const years = Array.from({ length: 10 }, (_, k) => `${2016 + k}-07-01T00:00:00.000Z`);
const fires = layer("fire-perimeters", fc(...years, undefined));
const trails = layer("osm-trails", fc(undefined, undefined));

const y = (year: number) => `${year}-01-01T00:00:00.000Z`;
const yEnd = (year: number) => `${year}-12-31T23:59:59.999Z`;

function run(state: MapState, ...actions: MapAction[]): MapState {
  return actions.reduce(reduce, state);
}

const loaded = run(initialMapState, { type: "layer_loaded", layer: fires });

describe("time state in the reducer", () => {
  it("opens the scrubber over the whole span when a dated layer loads, paused, sliding, by year", () => {
    expect(loaded.time?.index.bucket).toBe("year");
    expect(loaded.time?.index.buckets).toHaveLength(10);
    expect(loaded.time?.window).toEqual([y(2016), yEnd(2025)]);
    expect(loaded.time).toMatchObject({ playing: false, mode: "slide" });
  });

  it("does not open a scrubber for undated layers", () => {
    expect(run(initialMapState, { type: "layer_loaded", layer: trails }).time).toBeUndefined();
  });

  it("set_time_window clamps the window to the data and orders its ends", () => {
    const s = run(loaded, { type: "set_time_window", window: [y(2030), y(2019)] });
    expect(s.time?.window).toEqual([y(2019), yEnd(2025)]);
    const before = run(loaded, { type: "set_time_window", window: [y(1990), yEnd(2017)] });
    expect(before.time?.window).toEqual([y(2016), yEnd(2017)]);
  });

  it("a window asked for before any dated layer waits, then applies with its mode and play", () => {
    const early = run(
      initialMapState,
      { type: "set_time_window", window: [y(2016), yEnd(2016)] },
      { type: "set_time_playing", playing: true },
    );
    expect(early.time).toBeUndefined();
    expect(early.pendingTime).toEqual({ window: [y(2016), yEnd(2016)], playing: true });
    const s = run(early, { type: "layer_loaded", layer: fires });
    expect(s.pendingTime).toBeUndefined();
    expect(s.time).toMatchObject({ window: [y(2016), yEnd(2016)], playing: true, mode: "slide" });
  });

  it("time_tick steps one bucket while playing and stops at the end", () => {
    let s = run(loaded, { type: "set_time_window", window: [y(2023), yEnd(2023)] }, { type: "set_time_playing", playing: true });
    s = run(s, { type: "time_tick" });
    expect(s.time?.window).toEqual([y(2024), yEnd(2024)]);
    s = run(s, { type: "time_tick" }, { type: "time_tick" });
    expect(s.time?.window).toEqual([y(2025), yEnd(2025)]);
    expect(s.time?.playing).toBe(false);
    // A paused scrubber ignores ticks.
    expect(run(s, { type: "time_tick" })).toBe(s);
  });

  it("play from the end or with the whole span starts over at the first bucket", () => {
    const whole = run(loaded, { type: "set_time_playing", playing: true });
    expect(whole.time?.window).toEqual([y(2016), yEnd(2016)]);
    const atEnd = run(loaded, { type: "set_time_window", window: [y(2024), yEnd(2025)] }, { type: "set_time_playing", playing: true });
    expect(atEnd.time?.window).toEqual([y(2016), yEnd(2017)]);
  });

  it("cumulative mode keeps the first date as the start and grows the end", () => {
    let s = run(loaded, { type: "set_time_window", window: [y(2019), yEnd(2019)] }, { type: "set_time_mode", mode: "cumulative" });
    expect(s.time?.window[0]).toBe(s.time?.index.min);
    expect(s.time?.window[1]).toBe(yEnd(2019));
    s = run(s, { type: "set_time_playing", playing: true }, { type: "time_tick" });
    expect(s.time?.window).toEqual([s.time?.index.min, yEnd(2020)]);
  });

  it("clear_time hides the scrubber; removing a layer does not bring it back, loading one does", () => {
    const both = run(loaded, { type: "layer_loaded", layer: trails });
    const cleared = run(both, { type: "clear_time" });
    expect(cleared.time).toBeUndefined();
    expect(run(cleared, { type: "remove_layer", layerId: "osm-trails" }).time).toBeUndefined();
    expect(run(cleared, { type: "layer_loaded", layer: fires }).time).toBeDefined();
  });

  it("clears the scrubber when the last dated layer goes, and clamps the window when the span shrinks", () => {
    const narrowed = run(loaded, { type: "set_time_window", window: [y(2018), yEnd(2025)] });
    const shorter = layer("fire-perimeters", fc(...years.slice(0, 5)));
    const reloaded = run(narrowed, { type: "layer_loaded", layer: shorter });
    // Five years of data buckets by month, so the span now ends with July 2020.
    expect(reloaded.time?.index.bucket).toBe("month");
    expect(reloaded.time?.window).toEqual([y(2018), "2020-07-31T23:59:59.999Z"]);
    expect(run(narrowed, { type: "remove_layer", layerId: "fire-perimeters" }).time).toBeUndefined();
    expect(run(narrowed, { type: "clear_layers" }).time).toBeUndefined();
  });
});
