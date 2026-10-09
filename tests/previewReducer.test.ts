import { describe, expect, it } from "vitest";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type MapState, type RouteState } from "@/lib/render/state";

const route = (id: string): RouteState => ({
  id,
  line: { type: "LineString", coordinates: [[-120, 39], [-120, 39.01]] },
  source: "tool",
  distanceKm: 1.1,
  waypoints: [],
});

const withRoutes: MapState = { ...initialMapState, routes: { a: route("a"), b: route("b") } };
const playing = reduce(withRoutes, { type: "preview_start", routeId: "a" });

describe("route preview actions", () => {
  it("preview_start plays a known route from the start at 1x and closes the inspect card", () => {
    expect(playing.playback).toEqual({ routeId: "a", fraction: 0, playing: true, speed: 1 });
    const selected = { ...withRoutes, selected: { layerId: "x", feature: { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [0, 0] }, properties: {} }, lngLat: [0, 0] as [number, number] } };
    expect(reduce(selected, { type: "preview_start", routeId: "a", speed: 2 })).toMatchObject({ selected: undefined, playback: { speed: 2 } });
    expect(reduce(withRoutes, { type: "preview_start", routeId: "zzz" })).toBe(withRoutes);
  });

  it("preview_tick clamps, and reaching the end pauses there", () => {
    expect(reduce(playing, { type: "preview_tick", fraction: 0.4 }).playback).toMatchObject({ fraction: 0.4, playing: true });
    expect(reduce(playing, { type: "preview_tick", fraction: 1.5 }).playback).toMatchObject({ fraction: 1, playing: false });
    expect(reduce(playing, { type: "preview_tick", fraction: -1 }).playback?.fraction).toBe(0);
    expect(reduce(playing, { type: "preview_tick", fraction: Number.NaN })).toBe(playing);
    expect(reduce(withRoutes, { type: "preview_tick", fraction: 0.5 })).toBe(withRoutes);
  });

  it("preview_toggle pauses and plays, starting over from the end", () => {
    const paused = reduce(playing, { type: "preview_toggle" });
    expect(paused.playback?.playing).toBe(false);
    expect(reduce(paused, { type: "preview_toggle" }).playback?.playing).toBe(true);
    const ended = reduce(playing, { type: "preview_tick", fraction: 1 });
    expect(reduce(ended, { type: "preview_toggle" }).playback).toMatchObject({ fraction: 0, playing: true });
    expect(reduce(withRoutes, { type: "preview_toggle" })).toBe(withRoutes);
  });

  it("preview_speed takes positive speeds only", () => {
    expect(reduce(playing, { type: "preview_speed", speed: 4 }).playback?.speed).toBe(4);
    expect(reduce(playing, { type: "preview_speed", speed: 0 })).toBe(playing);
    expect(reduce(playing, { type: "preview_speed", speed: -2 })).toBe(playing);
  });

  it("preview_stop ends the preview", () => {
    expect(reduce(playing, { type: "preview_stop" }).playback).toBeUndefined();
    expect(reduce(withRoutes, { type: "preview_stop" })).toBe(withRoutes);
  });

  it("removing the previewed route stops the preview; removing another does not", () => {
    expect(reduce(playing, { type: "route_removed", routeId: "a" }).playback).toBeUndefined();
    expect(reduce(playing, { type: "route_removed", routeId: "b" }).playback?.routeId).toBe("a");
    expect(reduce(playing, { type: "routes_cleared" }).playback).toBeUndefined();
    expect(reduce(playing, { type: "clear_layers" }).playback).toBeUndefined();
  });

  it("a basemap swap stops the preview", () => {
    expect(reduce(playing, { type: "set_basemap", basemap: "satellite" }).playback).toBeUndefined();
    expect(reduce(playing, { type: "set_basemap", basemap: playing.basemap })).toBe(playing);
  });
});
