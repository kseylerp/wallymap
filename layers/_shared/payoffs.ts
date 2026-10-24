import type { Feature, Position } from "geojson";
import type { BBox } from "../types";

/**
 * What a hike leads to (docs/top-10-use-cases.md T01, "a payoff: waterfall, viewpoint, summit"): the waterfalls,
 * viewpoints, named summits and hot springs OpenStreetMap maps within PAYOFF_M of a whole hike's line, read from one
 * Overpass call over the same box (nodes only, a few hundred at most) and joined here. A hike gains `payoff` (the kinds,
 * a list) and `passes` (their names in words, nearest first), so "loops with a waterfall" is a chip and the card and the
 * note can name the falls. Pure apart from the caller's fetch.
 */

/** A payoff counts when the trail passes this close to it (a waterfall beside the path, a viewpoint at its end). */
export const PAYOFF_M = 250;

export const PAYOFF_KINDS = ["waterfall", "viewpoint", "summit", "hot_spring"] as const;
export type PayoffKind = (typeof PAYOFF_KINDS)[number];

export const PAYOFF_LABELS: Record<PayoffKind, string> = { waterfall: "Waterfall", viewpoint: "Viewpoint", summit: "Summit", hot_spring: "Hot spring" };

export type Payoff = { kind: PayoffKind; name?: string; at: Position };

/** Overpass QL for the payoff points in a box (south, west, north, east order); summits only when named. */
export function buildPayoffQuery(bbox: BBox): string {
  const [west, south, east, north] = bbox;
  const area = `(${south},${west},${north},${east})`;
  return `[out:json][timeout:25];(node["waterway"="waterfall"]${area};node["tourism"="viewpoint"]${area};node["natural"="peak"]["name"]${area};node["natural"="hot_spring"]${area};);out;`;
}

/** The payoff points of an Overpass body; anything else is skipped. */
export function parsePayoffs(json: unknown): Payoff[] {
  const elements = typeof json === "object" && json !== null ? (json as { elements?: unknown }).elements : undefined;
  if (!Array.isArray(elements)) return [];
  const out: Payoff[] = [];
  for (const el of elements) {
    if (typeof el !== "object" || el === null) continue;
    const { type, lat, lon, tags } = el as { type?: unknown; lat?: unknown; lon?: unknown; tags?: Record<string, string> };
    if (type !== "node" || typeof lat !== "number" || typeof lon !== "number") continue;
    const t = tags ?? {};
    const kind: PayoffKind | undefined =
      t.waterway === "waterfall" ? "waterfall" : t.tourism === "viewpoint" ? "viewpoint" : t.natural === "peak" ? "summit" : t.natural === "hot_spring" ? "hot_spring" : undefined;
    if (!kind) continue;
    out.push({ kind, ...(t.name && { name: t.name }), at: [lon, lat] });
  }
  return out;
}

function linesOf(f: Feature): Position[][] {
  const g = f.geometry;
  if (g?.type === "LineString") return [g.coordinates];
  if (g?.type === "MultiLineString") return g.coordinates;
  return [];
}

/** Metres from a point to a line, on a local flat projection (fine at a few hundred metres). */
export function pointToLineM(p: Position, line: Position[]): number {
  const kx = 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 110_570;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1][0] - p[0]) * kx;
    const ay = (line[i - 1][1] - p[1]) * ky;
    const bx = (line[i][0] - p[0]) * kx;
    const by = (line[i][1] - p[1]) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  if (line.length === 1) best = Math.hypot((line[0][0] - p[0]) * kx, (line[0][1] - p[1]) * ky);
  return best;
}

/** "Catawba Falls (waterfall)", or "a waterfall" when it has no name. */
function words(p: Payoff): string {
  const label = PAYOFF_LABELS[p.kind].toLowerCase();
  return p.name ? `${p.name} (${label})` : `a ${label}`;
}

/**
 * Puts the payoffs within PAYOFF_M of each named hike on it (mutates): `payoff`, the kinds in PAYOFF_KINDS order, and
 * `passes`, up to four of them in words, nearest first. Returns how many hikes got one.
 */
export function attachPayoffs(hikes: Feature[], payoffs: Payoff[], withinM = PAYOFF_M): number {
  if (payoffs.length === 0) return 0;
  const padLat = withinM / 110_570;
  let n = 0;
  for (const hike of hikes) {
    const props = hike.properties;
    if (!props || typeof props.name !== "string") continue;
    const lines = linesOf(hike);
    if (lines.length === 0) continue;
    let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity;
    for (const l of lines) for (const [x, y] of l) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); nn = Math.max(nn, y); }
    const padLon = padLat / Math.max(0.1, Math.cos((((s + nn) / 2) * Math.PI) / 180));
    const near: { p: Payoff; m: number }[] = [];
    for (const p of payoffs) {
      const [x, y] = p.at;
      if (x < w - padLon || x > e + padLon || y < s - padLat || y > nn + padLat) continue;
      const m = Math.min(...lines.map((l) => pointToLineM(p.at, l)));
      if (m <= withinM) near.push({ p, m });
    }
    if (near.length === 0) continue;
    near.sort((a, b) => a.m - b.m);
    const kinds = PAYOFF_KINDS.filter((k) => near.some((x) => x.p.kind === k));
    // A named payoff reads before an unnamed one of the same kind; the same name is listed once.
    const listed: string[] = [];
    for (const x of [...near.filter((x) => x.p.name), ...near.filter((x) => !x.p.name)]) {
      const text = words(x.p);
      if (!listed.includes(text) && listed.length < 4) listed.push(text);
    }
    props.payoff = kinds;
    props.passes = listed.join(" · ");
    n += 1;
  }
  return n;
}
