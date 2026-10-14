import { describe, expect, it } from "vitest";
import { isRouteProperties, LINE_CLASSES, lineClassFor, PINK, PURPLE, WHITE } from "@/lib/render/palette";

describe("lineClassFor: named routes take the Wally gradient, plain segments keep their class", () => {
  it("makes a feature with kind route a route, on any layer", () => {
    for (const layerId of ["mtb-trails", "paddling", "osm-trails", "ski-routes", "some-future-layer"]) {
      expect(lineClassFor(layerId, { kind: "route", name: "Loop" })).toBe("route");
    }
  });

  it("makes a feature with a route property a route (ski piste and route relations, wide-scale hiking routes)", () => {
    expect(lineClassFor("ski-routes", { kind: "nordic", route: true })).toBe("route");
    expect(lineClassFor("ski-routes", { kind: "skitour", route: true })).toBe("route");
    expect(lineClassFor("ski-routes", { kind: "downhill", route: true })).toBe("route");
    expect(lineClassFor("ski-routes", { kind: "sled", route: true })).toBe("route");
    expect(lineClassFor("mtb-trails", { kind: "route", route: "mtb" })).toBe("route");
    expect(lineClassFor("osm-trails", { kind: "route", route: "hiking" })).toBe("route");
    expect(lineClassFor("osm-trails", { route: "foot" })).toBe("route");
  });

  it("keeps ordinary paths and piste ways in their own class", () => {
    expect(lineClassFor("osm-trails", { kind: "path" })).toBe("trail");
    expect(lineClassFor("osm-trails", { informal: true })).toBe("useTrail");
    expect(lineClassFor("osm-trails")).toBe("trail");
    expect(lineClassFor("forest-roads", { kind: "road" })).toBe("road");
    expect(lineClassFor("ski-routes", { kind: "nordic" })).toBe("solid");
    expect(lineClassFor("ski-routes", { kind: "downhill", route: false })).toBe("solid");
    expect(lineClassFor("mtb-trails", { kind: "mtb" })).toBe("solid");
    expect(lineClassFor("paddling", { kind: "section" })).toBe("solid");
    expect(lineClassFor("paddling", null)).toBe("solid");
  });

  it("does not count an empty, no or false route property", () => {
    for (const route of ["", "no", "false", false, undefined, null, 0]) expect(isRouteProperties({ route })).toBe(false);
  });

  it("draws the route class 3px, solid, purple to pink, on a casing wider than the core", () => {
    expect(LINE_CLASSES.route).toMatchObject({ gradient: [PURPLE, PINK], width: 3, dash: [0, 0] });
    expect(LINE_CLASSES.route.casing).toBeGreaterThan(LINE_CLASSES.route.width);
    expect(WHITE).toBe("#FFFFFF");
  });
});
