import type { Feature, LineString, MultiLineString, Point, Position } from "geojson";
import type { ExpressionSpecification, LineLayerSpecification } from "mapbox-gl";
import { haversineKm } from "@/layers/_shared/geo";
import { ROUTE } from "@/lib/render/palette";

/**
 * Wally route lines (docs/superpowers/specs/2026-10-09-wallymap-m3-design.md §3): a 7px white casing under a 4.5px
 * line colored by position from purple to coral, white direction darts, and mile markers. Pure helpers only; the
 * Mapbox sync lives in components/routeLayers.ts.
 */

export const ROUTE_START_COLOR = ROUTE.start;
export const ROUTE_END_COLOR = ROUTE.end;
export const GRADIENT_STOPS = 24;
export const CASING_WIDTH = 7;
export const LINE_WIDTH = 4.5;

/** Darts: one every ~500 m, at most 12, none on a route shorter than 400 m. */
export const DART_SPACING_M = 500;
export const MAX_DARTS = 12;
export const MIN_DART_ROUTE_M = 400;
/** A dart points along the line between 40 m behind it and 40 m ahead of it. */
export const DART_BEARING_WINDOW_M = 40;
/** A dart this close to an earlier stretch of the line running the other way is the return leg of an out-and-back. */
const OPPOSING_NEAR_M = 30;
/** How far back along the line a stretch must be before it counts as "earlier" (skips the dart's own stretch). */
const OPPOSING_MIN_GAP_M = 2 * DART_BEARING_WINDOW_M;
/** Two bearings at least this far apart run opposite ways. */
const OPPOSING_MIN_ANGLE = 120;

export const METERS_PER_MILE = 1609.344;

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Cumulative distance in meters at each vertex of `coords` (first is 0). */
export function cumulativeMeters(coords: Position[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + haversineKm(coords[i - 1], coords[i]) * 1000);
  return out;
}

/** Total length of a line in meters. */
export function lineLengthMeters(line: LineString): number {
  const cum = cumulativeMeters(line.coordinates);
  return cum[cum.length - 1] ?? 0;
}

/** The point `meters` along the line (clamped to its ends), interpolated linearly within a segment. */
function pointAt(coords: Position[], cum: number[], meters: number): Position {
  const total = cum[cum.length - 1];
  const d = Math.min(total, Math.max(0, meters));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const span = cum[i] - cum[i - 1];
  const t = span > 0 ? (d - cum[i - 1]) / span : 0;
  const [x0, y0] = coords[i - 1];
  const [x1, y1] = coords[i];
  return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
}

/** Initial great-circle bearing from `a` to `b`, degrees clockwise from north in [0, 360). */
export function bearingDeg(a: Position, b: Position): number {
  const φ1 = rad(a[1]);
  const φ2 = rad(b[1]);
  const Δλ = rad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest angle between two bearings, 0 to 180. */
function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Distance in meters from `p` to segment `a`–`b`, on a local flat projection around `p`. */
function pointSegmentMeters(p: Position, a: Position, b: Position): number {
  const kx = 111_320 * Math.cos(rad(p[1]));
  const ky = 110_574;
  const ax = (a[0] - p[0]) * kx;
  const ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx;
  const by = (b[1] - p[1]) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t);
}

/**
 * True when an earlier stretch of the line (ending at least `OPPOSING_MIN_GAP_M` before `along`) passes within
 * `OPPOSING_NEAR_M` of `p` heading the other way: `p` is on the return leg of an out-and-back.
 */
function retracesEarlierLeg(coords: Position[], cum: number[], p: Position, bearing: number, along: number): boolean {
  for (let i = 1; i < coords.length && cum[i] <= along - OPPOSING_MIN_GAP_M; i++) {
    if (pointSegmentMeters(p, coords[i - 1], coords[i]) > OPPOSING_NEAR_M) continue;
    if (angleBetween(bearingDeg(coords[i - 1], coords[i]), bearing) >= OPPOSING_MIN_ANGLE) return true;
  }
  return false;
}

/**
 * Direction darts along a route: about every 500 m (at most 12, spread evenly when the route is longer than
 * 6 km), none on a route under 400 m. Each dart sits mid-slot and points along the line measured over ±40 m.
 * A dart on the return leg of an out-and-back (an earlier stretch runs beside it the other way) is dropped, so
 * the two legs do not show arrows pointing at each other.
 */
export function directionDarts(line: LineString): Feature<Point, { bearing: number }>[] {
  const coords = line.coordinates;
  if (coords.length < 2) return [];
  const cum = cumulativeMeters(coords);
  const total = cum[cum.length - 1];
  if (total < MIN_DART_ROUTE_M) return [];
  const count = Math.min(MAX_DARTS, Math.max(1, Math.round(total / DART_SPACING_M)));
  const slot = total / count;
  const darts: Feature<Point, { bearing: number }>[] = [];
  for (let i = 0; i < count; i++) {
    const along = (i + 0.5) * slot;
    const p = pointAt(coords, cum, along);
    const behind = pointAt(coords, cum, along - DART_BEARING_WINDOW_M);
    const ahead = pointAt(coords, cum, along + DART_BEARING_WINDOW_M);
    const bearing = Math.round(bearingDeg(behind, ahead) * 10) / 10;
    if (retracesEarlierLeg(coords, cum, p, bearing, along)) continue;
    darts.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { bearing } });
  }
  return darts;
}

/** Marker interval in display units: every 1 under 15, every 2 under 50, every 5 under 100, then every 10. */
export function markerInterval(totalUnits: number): number {
  if (totalUnits < 15) return 1;
  if (totalUnits < 50) return 2;
  if (totalUnits < 100) return 5;
  return 10;
}

/** Mile (or kilometer) markers at each whole interval along the line, labeled like "3 mi"; none at the very end. */
export function mileMarkers(line: LineString, units: "mi" | "km" = "mi"): Feature<Point, { label: string }>[] {
  const coords = line.coordinates;
  if (coords.length < 2) return [];
  const cum = cumulativeMeters(coords);
  const unitM = units === "mi" ? METERS_PER_MILE : 1000;
  const totalUnits = cum[cum.length - 1] / unitM;
  const step = markerInterval(totalUnits);
  const markers: Feature<Point, { label: string }>[] = [];
  for (let k = step; k < totalUnits - 1e-9; k += step) {
    markers.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: pointAt(coords, cum, k * unitM) },
      properties: { label: `${k} ${units}` },
    });
  }
  return markers;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** The 24 gradient colors, purple at the start to coral at the end. */
export function gradientColors(): string[] {
  const a = hexToRgb(ROUTE_START_COLOR);
  const b = hexToRgb(ROUTE_END_COLOR);
  return Array.from({ length: GRADIENT_STOPS }, (_, i) => {
    const t = i / (GRADIENT_STOPS - 1);
    return rgbToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  });
}

/** Two positions this close (degrees) are the same vertex: where one way of a route relation ends, the next begins. */
const JOIN_EPSILON = 1e-9;

function samePosition(a: Position, b: Position): boolean {
  return Math.abs(a[0] - b[0]) <= JOIN_EPSILON && Math.abs(a[1] - b[1]) <= JOIN_EPSILON;
}

/**
 * A route made of many ways (an OSM route relation) as few continuous lines as its ways allow: parts that meet end to
 * end are chained in order, reversing a way that runs the other way. Mapbox's `line-progress` runs 0 to 1 along each
 * line of a feature on its own, so a route left as a hundred short ways would repeat the purple → pink gradient on
 * every way; chained, the gradient runs the length of each continuous stretch. Parts with fewer than two finite
 * positions are dropped; one chain comes back as a LineString.
 */
export function chainParts(geometry: LineString | MultiLineString): LineString | MultiLineString {
  if (geometry.type === "LineString") return geometry;
  const rest = geometry.coordinates
    .map((part) => part.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])))
    .filter((part) => part.length >= 2);
  const chains: Position[][] = [];
  while (rest.length > 0) {
    let chain = rest.shift()!;
    for (let joined = true; joined; ) {
      joined = false;
      for (let i = 0; i < rest.length; i++) {
        const part = rest[i];
        const head = chain[0];
        const tail = chain[chain.length - 1];
        if (samePosition(tail, part[0])) chain = [...chain, ...part.slice(1)];
        else if (samePosition(tail, part[part.length - 1])) chain = [...chain, ...[...part].reverse().slice(1)];
        else if (samePosition(head, part[part.length - 1])) chain = [...part.slice(0, -1), ...chain];
        else if (samePosition(head, part[0])) chain = [...[...part].reverse().slice(0, -1), ...chain];
        else continue;
        rest.splice(i, 1);
        joined = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains.length === 1 ? { type: "LineString", coordinates: chains[0] } : { type: "MultiLineString", coordinates: chains };
}

/** `line-gradient` over `line-progress` with 24 evenly spaced stops (needs a source with `lineMetrics: true`). */
export function gradientExpression(): ExpressionSpecification {
  const stops = gradientColors().flatMap((color, i) => [i / (GRADIENT_STOPS - 1), color]);
  return ["interpolate", ["linear"], ["line-progress"], ...stops] as ExpressionSpecification;
}

export const routeSourceId = (id: string) => `route-${id}`;

/** The casing and gradient line layers for route `id`, bottom first. */
export function routeLayerSpecs(id: string): [LineLayerSpecification, LineLayerSpecification] {
  const source = routeSourceId(id);
  const layout = { "line-cap": "round", "line-join": "round" } as const;
  const lineOnly: ExpressionSpecification = ["==", ["geometry-type"], "LineString"];
  return [
    {
      id: `${source}-casing`,
      type: "line",
      source,
      filter: lineOnly,
      layout,
      paint: { "line-color": ROUTE.casing, "line-width": CASING_WIDTH },
    },
    {
      id: `${source}-line`,
      type: "line",
      source,
      filter: lineOnly,
      layout,
      paint: { "line-width": LINE_WIDTH, "line-gradient": gradientExpression() },
    },
  ];
}

/** Dart icon size in CSS pixels; the SVG is drawn at 2x for sharpness (`pixelRatio: 2`). */
export const DART_ICON_PX = 16;
export const DART_ICON_ID = "route-dart";

/**
 * The 16px white dart (pointing north, so `icon-rotate` is the bearing) as an SVG data URL drawn at 2x. It fills
 * its box so the wings reach past the 7px white casing, and a dark edge outlines it on the casing and on snow.
 */
export function dartIconSpec(): { id: string; url: string; width: number; height: number; pixelRatio: number } {
  const size = DART_ICON_PX * 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16">` +
    `<path d="M8 1.2 L14.8 14.6 L8 11.2 L1.2 14.6 Z" fill="${ROUTE.dart}" stroke="rgba(0,0,0,0.45)" stroke-width="0.9" stroke-linejoin="round"/>` +
    `</svg>`;
  return { id: DART_ICON_ID, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width: size, height: size, pixelRatio: 2 };
}
