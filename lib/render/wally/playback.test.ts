import type { LineString } from "geojson";
import { describe, expect, it } from "vitest";
import {
  aheadMeters,
  aheadTargetMeters,
  bearingAt,
  bearingLookAheadM,
  cameraDistanceMeters,
  CHASE_POINT_AT,
  chasePadding,
  chasePitch,
  chaseZoom,
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
  MAX_TURN_DEG_PER_S,
  metersPerPixel,
  smoothBearing,
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
    expect(followPadding(base, canvas, [panel])).toEqual({ padding: { ...base, left: 460 }, fits: true });
  });

  it("keeps a phone's clear band entirely above the dock, shrinking the header inset first", () => {
    const canvas = { width: 390, height: 844 };
    const dockTop = 137;
    const dock = { left: 12, top: dockTop, right: 378, bottom: 445 };
    const sheet = { left: 0, top: 456, right: 390, bottom: 844 };
    const { padding, fits } = followPadding({ top: 104, right: 40, bottom: 428, left: 40 }, canvas, [dock, sheet]);
    const bandTop = padding.top;
    const bandBottom = canvas.height - padding.bottom;
    expect(bandBottom).toBeLessThanOrEqual(dockTop);
    expect(bandBottom - bandTop).toBeGreaterThanOrEqual(80);
    expect(fits).toBe(true);
  });

  it("reports no fit when less than 80px is left above the dock", () => {
    const canvas = { width: 390, height: 667 };
    const dockTop = 60;
    const dock = { left: 12, top: dockTop, right: 378, bottom: 350 };
    const sheet = { left: 0, top: 360, right: 390, bottom: 667 };
    const { padding, fits } = followPadding({ top: 104, right: 40, bottom: 340, left: 40 }, canvas, [sheet, dock]);
    expect(fits).toBe(false);
    expect(canvas.height - padding.bottom).toBeLessThanOrEqual(dockTop);
    expect(canvas.height - padding.top - padding.bottom).toBeGreaterThanOrEqual(1);
  });

  it("fits again once the dock collapses to a 56px strip", () => {
    const canvas = { width: 390, height: 667 };
    const strip = { left: 12, top: 294, right: 378, bottom: 350 };
    const sheet = { left: 0, top: 360, right: 390, bottom: 667 };
    const { padding, fits } = followPadding({ top: 104, right: 40, bottom: 340, left: 40 }, canvas, [sheet, strip]);
    expect(fits).toBe(true);
    expect(canvas.height - padding.bottom).toBeLessThanOrEqual(strip.top);
  });

  it("ignores obstacles outside the canvas", () => {
    const canvas = { width: 800, height: 600 };
    expect(followPadding(base, canvas, [{ left: 900, top: 0, right: 1000, bottom: 100 }])).toEqual({ padding: base, fits: true });
  });
});

describe("chase camera heading", () => {
  it("never turns faster than the max rate, and turns the short way", () => {
    const next = smoothBearing(0, 170, 16);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThanOrEqual((MAX_TURN_DEG_PER_S * 16) / 1000 + 1e-9);
    const across = smoothBearing(170, -170, 100);
    expect(turnBetween(170, across)).toBeGreaterThan(0); // through 180, not back through 0
    expect(turnBetween(170, across)).toBeLessThanOrEqual(MAX_TURN_DEG_PER_S * 0.1 + 1e-9);
  });

  it("eases small turns exponentially, settles without overshoot and stays in (-180, 180]", () => {
    expect(smoothBearing(0, 2, 900)).toBeCloseTo(2 * (1 - Math.exp(-1)), 6);
    let b = -120;
    let worst = 0;
    for (let t = 0; t < 10_000; t += 16) {
      b = smoothBearing(b, 150, 16);
      // The turn from -120 to 150 is -90° (the short way, through 180): a positive turn left would be past it.
      worst = Math.max(worst, turnBetween(b, 150));
      expect(b).toBeGreaterThan(-180);
      expect(b).toBeLessThanOrEqual(180);
    }
    expect(worst).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(turnBetween(b, 150))).toBeLessThan(0.5);
    expect(smoothBearing(40, 40, 16)).toBe(40);
  });

  it("looks about 3 s ahead, 250 m to 1.2 km", () => {
    expect(bearingLookAheadM(10)).toBeCloseTo(500, 6);
    expect(bearingLookAheadM(2)).toBe(250);
    expect(bearingLookAheadM(40)).toBe(1200);
    expect(bearingLookAheadM(Number.NaN)).toBe(250);
  });

  it("holds the overall heading through switchbacks the old short look-ahead whipped across", () => {
    // Legs of ~100 m alternating 60° either side of north.
    const coords: [number, number][] = [[-120, 39]];
    for (let i = 0; i < 40; i++) {
      const [x, y] = coords[coords.length - 1];
      const side = i % 2 === 0 ? 1 : -1;
      coords.push([x + (side * 100 * Math.sin(Math.PI / 3)) / (111_320 * Math.cos((39 * Math.PI) / 180)), y + (100 * Math.cos(Math.PI / 3)) / 110_574]);
    }
    const zig: LineString = { type: "LineString", coordinates: coords };
    let longSwing = 0;
    let shortSwing = 0;
    for (let f = 0; f <= 0.8; f += 0.01) {
      longSwing = Math.max(longSwing, Math.abs(turnBetween(0, bearingAt(zig, f, bearingLookAheadM(10)))));
      shortSwing = Math.max(shortSwing, Math.abs(turnBetween(0, bearingAt(zig, f, 40))));
    }
    expect(shortSwing).toBeGreaterThan(50);
    expect(longSwing).toBeLessThan(25);
  });
});

describe("chase camera framing", () => {
  it("puts the followed point 70% of the way down the clear band, leaving the bottom edge alone", () => {
    const padding = { top: 104, right: 96, bottom: 40, left: 476 };
    const height = 900;
    const next = chasePadding(padding, height);
    const centerY = (next.top + height - next.bottom) / 2;
    expect(centerY).toBeCloseTo(104 + CHASE_POINT_AT * (900 - 104 - 40), 6);
    expect(next).toMatchObject({ right: 96, bottom: 40, left: 476 });
  });

  it("keeps the point inside a phone's 80px band, clear of the dock below it", () => {
    const height = 844;
    const padding = { top: 57, right: 40, bottom: 707, left: 40 }; // an 80px band ending at the dock's edge
    const next = chasePadding(padding, height);
    const centerY = (next.top + height - next.bottom) / 2;
    expect(centerY).toBeGreaterThan(padding.top + 80 * (2 / 3) - 1e-9); // the lower third
    expect(centerY).toBeLessThanOrEqual(height - padding.bottom - 20); // never on or under the dock
    expect(next.top + next.bottom).toBeLessThan(height);
  });

  it("leaves a degenerate band alone", () => {
    const padding = { top: 500, right: 0, bottom: 500, left: 0 };
    expect(chasePadding(padding, 900)).toBe(padding);
  });

  it("measures the trail ahead: a fifth of the canvas on a flat camera, more when tilted", () => {
    expect(aheadMeters(16, 0, 39, 900)).toBeCloseTo(0.2 * 900 * metersPerPixel(16, 39), 6);
    expect(aheadMeters(16, 65, 39, 900)).toBeGreaterThan(aheadMeters(16, 45, 39, 900));
    expect(aheadMeters(17, 65, 39, 900)).toBeCloseTo(aheadMeters(16, 65, 39, 900) / 2, 6);
    expect(aheadMeters(16, 85, 39, 900)).toBe(Infinity);
  });

  it("zooms so 300–600 m of trail is ahead, closer when slower and lower when flattened", () => {
    expect(aheadTargetMeters(10)).toBe(450);
    expect(aheadTargetMeters(5)).toBe(318.1980515339464);
    expect(aheadTargetMeters(40)).toBe(600);
    for (const kmPerMin of [5, 10, 20, 40]) {
      const zoom = chaseZoom(kmPerMin, chasePitch(false), 39.15, 900);
      expect(aheadMeters(zoom, chasePitch(false), 39.15, 900)).toBeCloseTo(aheadTargetMeters(kmPerMin), 3);
    }
    expect(chaseZoom(5, 65, 39.15, 900)).toBeGreaterThan(chaseZoom(10, 65, 39.15, 900));
    expect(chaseZoom(10, chasePitch(true), 39.15, 900)).toBeLessThan(chaseZoom(10, chasePitch(false), 39.15, 900));
    expect(chasePitch(true)).toBe(45);
    expect(chaseZoom(10, 65, 39.15, 0)).toBe(16); // no canvas yet: the old follow zoom
  });
});
