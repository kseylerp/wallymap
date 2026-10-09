import type { LineString } from "geojson";
import { describe, expect, it } from "vitest";
import {
  bearingAt,
  cameraDistanceMeters,
  clearPitch,
  dispatchPreview,
  followZoom,
  fractionStep,
  followPadding,
  gradientColorAt,
  lengthMeters,
  offsetPoint,
  onPreviewDispatch,
  playbackFrames,
  positionAt,
  previewFeature,
  progressGradient,
  routeFromFeature,
  turnBetween,
} from "@/lib/render/wally/playback";
import type { MapAction } from "@/lib/render/state";

// Due north along a meridian: 0.01° of latitude is about 1.11 km, so the line is about 2.22 km.
const north: LineString = { type: "LineString", coordinates: [[-120, 39], [-120, 39.01], [-120, 39.02]] };
// East then north: an L.
const ell: LineString = { type: "LineString", coordinates: [[-120, 39], [-119.99, 39], [-119.99, 39.01]] };

describe("positionAt", () => {
  it("returns the endpoints at 0 and 1, clamping beyond", () => {
    expect(positionAt(north, 0)).toEqual([-120, 39]);
    expect(positionAt(north, 1)).toEqual([-120, 39.02]);
    expect(positionAt(north, -1)).toEqual([-120, 39]);
    expect(positionAt(north, 2)).toEqual([-120, 39.02]);
  });

  it("returns the midpoint by distance", () => {
    const [lng, lat] = positionAt(north, 0.5);
    expect(lng).toBeCloseTo(-120, 9);
    expect(lat).toBeCloseTo(39.01, 6);
    const [x, y] = positionAt(north, 0.25);
    expect(x).toBeCloseTo(-120, 9);
    expect(y).toBeCloseTo(39.005, 6);
  });

  it("handles a one-point line", () => {
    expect(positionAt({ type: "LineString", coordinates: [[1, 2]] }, 0.5)).toEqual([1, 2]);
  });
});

describe("bearingAt", () => {
  it("points along the line", () => {
    expect(bearingAt(north, 0.3)).toBeCloseTo(0, 3);
    expect(bearingAt(ell, 0.1)).toBeCloseTo(90, 0);
    expect(bearingAt(ell, 0.9)).toBeCloseTo(0, 0);
  });

  it("uses the stretch before the end in the last look-ahead", () => {
    expect(bearingAt(north, 1)).toBeCloseTo(0, 3);
    expect(bearingAt(ell, 1, 40)).toBeCloseTo(0, 0);
  });

  it("turns the short way", () => {
    expect(turnBetween(350, 10)).toBe(20);
    expect(turnBetween(10, 350)).toBe(-20);
    expect(turnBetween(0, 180)).toBe(180);
  });
});

describe("playbackFrames", () => {
  it("spaces frames by speed at 60 fps and ends on the last point", () => {
    const total = lengthMeters(north);
    const frames = [...playbackFrames(north, 10)];
    // 10 km/min is 166.7 m/s, so 2.78 m per frame.
    const perFrame = (10_000 / 60) / 60;
    expect(frames.length).toBe(Math.ceil(total / perFrame) + 1);
    expect(frames[1].fraction * total).toBeCloseTo(perFrame, 6);
    expect(frames.at(-1)).toMatchObject({ fraction: 1, lngLat: [-120, 39.02] });
    expect(frames.every((f) => Math.abs(f.bearing) < 1e-3)).toBe(true);
  });

  it("takes half as many frames at twice the speed", () => {
    const slow = [...playbackFrames(north, 5)].length;
    const fast = [...playbackFrames(north, 10)].length;
    expect(Math.abs(slow - 1 - 2 * (fast - 1))).toBeLessThanOrEqual(2);
  });

  it("steps by distance over time", () => {
    // One minute at 1 km/min covers 1 km of a ~2.22 km line.
    expect(fractionStep(north, 1, 60_000)).toBeCloseTo(1000 / lengthMeters(north), 9);
  });

  it("zooms 16 at 1x, closer when slower, within 15–17", () => {
    expect(followZoom(10)).toBe(16);
    expect(followZoom(5)).toBe(17);
    expect(followZoom(2.5)).toBe(17);
    expect(followZoom(20)).toBe(15);
    expect(followZoom(40)).toBe(15);
  });
});

describe("progressGradient", () => {
  const stops = (f: number) => (progressGradient(f) as unknown[]).slice(3);

  it("is all transparent at 0 and the full gradient at 1", () => {
    expect(stops(0)).toEqual([0, "rgba(0, 0, 0, 0)", 1, "rgba(0, 0, 0, 0)"]);
    const full = stops(1);
    expect(full[0]).toBe(0);
    expect(full[1]).toBe("#6E5BFF");
    expect(full.at(-2)).toBe(1);
    expect(full.at(-1)).toBe("#F57272");
    expect(full).not.toContain("rgba(0, 0, 0, 0)");
  });

  it("has a hard stop at the fraction with ascending stops", () => {
    const s = stops(0.5);
    const at = s.indexOf(0.5);
    expect(at).toBeGreaterThan(0);
    expect(s[at + 1]).toBe(gradientColorAt(0.5));
    expect(s[at + 3]).toBe("rgba(0, 0, 0, 0)");
    expect(s.at(-2)).toBe(1);
    const positions = s.filter((_, i) => i % 2 === 0) as number[];
    positions.slice(1).forEach((p, i) => expect(p).toBeGreaterThan(positions[i]));
  });
});

describe("routeFromFeature and the preview bus", () => {
  it("builds a feature route with start and end pins", () => {
    const route = routeFromFeature({ type: "Feature", id: 7, geometry: ell, properties: {} }, "osm-trails", "Rubicon");
    expect(route).toMatchObject({ id: "feature-osm-trails-7", name: "Rubicon", source: "feature" });
    expect(route?.distanceKm).toBeCloseTo(lengthMeters(ell) / 1000, 9);
    expect(route?.waypoints.map((w) => w.type)).toEqual(["start", "end"]);
  });

  it("uses the longest part of a MultiLineString and rejects points", () => {
    const multi = routeFromFeature(
      { type: "Feature", geometry: { type: "MultiLineString", coordinates: [[[0, 0], [0, 0.001]], north.coordinates] }, properties: {} },
      "t",
    );
    expect(multi?.line.coordinates).toEqual(north.coordinates);
    expect(routeFromFeature({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} }, "t")).toBeNull();
  });

  it("starts a preview through the registered dispatcher", () => {
    const feature = { type: "Feature" as const, id: 1, geometry: north, properties: {} };
    expect(previewFeature(feature, "trails")).toBe(false);
    const seen: MapAction[] = [];
    const off = onPreviewDispatch((a) => seen.push(a));
    expect(previewFeature(feature, "trails")).toBe(true);
    expect(seen.map((a) => a.type)).toEqual(["route_loaded", "preview_start"]);
    expect(dispatchPreview({ type: "preview_stop" })).toBe(true);
    off();
    expect(dispatchPreview({ type: "preview_stop" })).toBe(false);
  });
});

describe("clearPitch", () => {
  const distance = 1000; // camera 1 km from the target
  it("keeps Follow pitch over flat or falling ground", () => {
    expect(clearPitch(distance, [{ behindM: 300, rise: 0 }, { behindM: 600, rise: -50 }])).toBe(65);
    expect(clearPitch(distance, [{ behindM: 300, rise: null }])).toBe(65);
  });

  it("tilts up just enough to see over a ridge behind the target", () => {
    // At 65° the camera sits ~906 m back and ~423 m up; the sight line is ~140 m up at 300 m back.
    const ridge = [{ behindM: 300, rise: 160 }];
    const pitch = clearPitch(distance, ridge);
    expect(pitch).toBeLessThan(65);
    expect(pitch).toBeGreaterThanOrEqual(35);
    expect(clearPitch(distance, [{ behindM: 300, rise: 5000 }])).toBe(35);
  });

  it("measures the camera distance and offsets points", () => {
    expect(cameraDistanceMeters(16, 0, 900)).toBeCloseTo(1.5 * 900 * (40_075_016.686 / (512 * 2 ** 16)), 6);
    const [lng, lat] = offsetPoint([-120, 39], 180, 1105.74);
    expect(lng).toBeCloseTo(-120, 9);
    expect(lat).toBeCloseTo(38.99, 6);
  });
});

describe("followPadding", () => {
  const base = { top: 104, right: 96, bottom: 112, left: 40 };

  it("pads the left past a desktop chat panel", () => {
    const canvas = { width: 1400, height: 900 };
    const panel = { left: 16, top: 236, right: 436, bottom: 884 };
    expect(followPadding(base, canvas, [panel])).toEqual({ ...base, left: 460 });
  });

  it("pads the bottom past a phone dock floating above the sheet", () => {
    const canvas = { width: 390, height: 844 };
    const dock = { left: 12, top: 137, right: 378, bottom: 445 };
    const sheet = { left: 0, top: 456, right: 390, bottom: 844 };
    const pad = followPadding({ top: 104, right: 40, bottom: 428, left: 40 }, canvas, [dock, sheet]);
    // The visible band is above the dock; the header padding shrinks so 120px stay clear.
    expect(844 - pad.top - pad.bottom).toBeGreaterThanOrEqual(120);
    expect(844 - pad.top - pad.bottom).toBeLessThan(123);
    expect(pad.bottom).toBeGreaterThanOrEqual(Math.floor((844 - 137 + 24) * 0.8));
    expect(pad.left + pad.right).toBe(80);
  });

  it("ignores obstacles outside the canvas", () => {
    const canvas = { width: 800, height: 600 };
    expect(followPadding(base, canvas, [{ left: 900, top: 0, right: 1000, bottom: 100 }])).toEqual(base);
  });
});
