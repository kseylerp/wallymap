import type { Map as MapboxMap } from "mapbox-gl";
import { describe, expect, it } from "vitest";
import { routeLineLayerId, setRouteProgress } from "@/components/routeLayers";
import { gradientExpression } from "@/lib/render/wally/routeLine";
import { progressGradient } from "@/lib/render/wally/playback";

function fakeMap(layers: string[]) {
  const paints: [string, string, unknown][] = [];
  const map = {
    getLayer: (id: string) => (layers.includes(id) ? { id } : undefined),
    setPaintProperty: (id: string, name: string, value: unknown) => paints.push([id, name, value]),
  } as unknown as MapboxMap;
  return { map, paints };
}

describe("setRouteProgress", () => {
  it("draws the traversed part on the route's line layer and restores the full gradient", () => {
    const { map, paints } = fakeMap([routeLineLayerId("r")]);
    setRouteProgress(map, "r", 0.25);
    setRouteProgress(map, "r", null);
    expect(paints).toEqual([
      ["route-r-line", "line-gradient", progressGradient(0.25)],
      ["route-r-line", "line-gradient", gradientExpression()],
    ]);
  });

  it("does nothing while the layer is missing", () => {
    const { map, paints } = fakeMap([]);
    setRouteProgress(map, "r", 0.5);
    expect(paints).toEqual([]);
  });
});
