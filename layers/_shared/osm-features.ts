/**
 * Small helpers shared by the OpenStreetMap activity layers (mtb-trails, ski-routes, climbing, paddling,
 * outdoor-features): the Overpass bbox clause, the `out count` total, tag parsing (dates, numbers, elevations,
 * grades) and turning ways, relations and area elements into GeoJSON geometry.
 */
import { z } from "zod";
import type { LineString, MultiLineString, Position } from "geojson";
import type { BBox, Citation } from "../types";
import { lineMidpoint } from "./geo";

export const tagsSchema = z.record(z.string(), z.string());

const latLon = z.object({ lat: z.number(), lon: z.number() });

export const nodeElementSchema = z.object({
  type: z.literal("node"),
  id: z.number(),
  lat: z.number(),
  lon: z.number(),
  tags: tagsSchema.optional(),
});

export const wayElementSchema = z.object({
  type: z.literal("way"),
  id: z.number(),
  geometry: z.array(latLon).optional(),
  center: latLon.optional(),
  tags: tagsSchema.optional(),
});

export const relationElementSchema = z.object({
  type: z.literal("relation"),
  id: z.number(),
  center: latLon.optional(),
  members: z
    .array(z.object({ type: z.string(), ref: z.number().optional(), geometry: z.array(latLon).optional() }))
    .optional(),
  tags: tagsSchema.optional(),
});

export const overpassBodySchema = z.object({ elements: z.array(z.unknown()) });

/** Overpass bbox clause; Overpass wants (south,west,north,east). */
export function bboxClause(bbox: BBox): string {
  const [west, south, east, north] = bbox;
  return `(${south},${west},${north},${east})`;
}

/**
 * The number of elements the query matched, from the `out count` elements in the body (each reports a
 * `total`), or null when the body has none.
 */
export function countedTotal(json: unknown): number | null {
  const elements = typeof json === "object" && json !== null ? (json as { elements?: unknown }).elements : undefined;
  if (!Array.isArray(elements)) return null;
  let total: number | null = null;
  for (const el of elements) {
    if (typeof el !== "object" || el === null || (el as { type?: unknown }).type !== "count") continue;
    const n = Number((el as { tags?: { total?: unknown } }).tags?.total);
    if (Number.isFinite(n)) total = (total ?? 0) + n;
  }
  return total;
}

export function osmCitation(): Citation {
  return {
    source: "OpenStreetMap contributors (ODbL)",
    url: "https://www.openstreetmap.org/copyright",
    retrieved: new Date().toISOString(),
  };
}

/** `Showing 2,000 of 3,400 ways ...` for a capped result. */
export function cappedNote(shown: number, total: number, noun: string, order: string): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return `Showing ${fmt(shown)} of ${fmt(total)} ${noun} in this box (${order}); zoom in for the rest`;
}

/**
 * The coverage note for a line or point layer: the count returned, and whether the box held more than Overpass sent.
 * `shown` is what the user gets (after any filter), `fetched` what Overpass sent before the filter, `total` what the
 * box matched; `filter` names the input that hid the difference.
 */
export function returnedNote(
  shown: number,
  total: number,
  noun: string,
  order: string,
  opts: { fetched?: number; filter?: string } = {},
): string {
  const fetched = opts.fetched ?? shown;
  const fmt = (n: number) => n.toLocaleString("en-US");
  const hidden = fetched - shown;
  const filtered = opts.filter && hidden > 0 ? ` after ${opts.filter} hid ${fmt(hidden)}` : "";
  if (total > fetched) {
    return `Showing ${fmt(shown)} of ${fmt(total)} ${noun} in this box (${order}${filtered}); zoom in for the rest`;
  }
  return `Returned ${fmt(shown)} ${noun}${filtered}; the box was not truncated`;
}

/** A calendar date `YYYY-MM-DD` that really exists, else undefined. */
export function isoDate(value: string | undefined): string | undefined {
  const m = value === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const d = new Date(`${m[0]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[0] ? undefined : m[0];
}

/** When a feature was last checked on the ground, from `check_date` or `survey:date`; the layers' `t`. */
export function checkedOn(tags: Record<string, string>): string | undefined {
  return isoDate(tags.check_date) ?? isoDate(tags["survey:date"]) ?? isoDate(tags["check_date:mtb"]);
}

/** A plain whole number ("62"); not a range or free text. */
export function wholeNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*\d{1,7}\s*$/.test(value)) return undefined;
  return Number(value);
}

/** A length in metres from "1234", "1,234", "1234.5", "1234 m", "5280 ft", "5280 feet" or "5280'"; undefined for anything else. */
export function metres(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^\s*(-?(?:\d{1,3}(?:,\d{3})+|\d{1,5})(?:\.\d+)?)\s*(m|ft|feet|foot|'|′|’)?\s*$/i.exec(value);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  const unit = m[2]?.toLowerCase();
  return unit === undefined || unit === "m" ? n : Math.round(n * 0.3048 * 10) / 10;
}

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };

/**
 * A whitewater class from an OSM grade tag as a number on 0 to 6: "3" is 3, "3+" is 3.5, "3-" is 2.5, a
 * range ("2-3", "II-III") is its hardest end, "III" is 3. Undefined for anything else ("portage", "unknown").
 */
export function gradeNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parts = value.toLowerCase().replace(/^class\s*/, "").split(/\s*(?:-|–|to|;|\/)\s*(?=[0-9ivx])/).filter(Boolean);
  let best: number | undefined;
  for (const raw of parts) {
    const m = /^([0-6]|vi|iv|v|iii|ii|i)\s*([+-])?$/.exec(raw.trim());
    if (!m) continue;
    const base = /^\d$/.test(m[1]) ? Number(m[1]) : ROMAN[m[1]];
    const n = base + (m[2] === "+" ? 0.5 : m[2] === "-" ? -0.5 : 0);
    if (best === undefined || n > best) best = n;
  }
  return best;
}

/** Centre of an element as [lon, lat]: a node's position, otherwise the `center` Overpass added. */
export function elementCenter(el: { lat?: number; lon?: number; center?: { lat: number; lon: number } }): Position | null {
  if (el.lat !== undefined && el.lon !== undefined) return [el.lon, el.lat];
  if (el.center) return [el.center.lon, el.center.lat];
  return null;
}

/** A way's geometry as a LineString, or null when it has fewer than two points. */
export function wayLine(geometry: { lat: number; lon: number }[] | undefined): LineString | null {
  if (!geometry || geometry.length < 2) return null;
  return { type: "LineString", coordinates: geometry.map((p) => [p.lon, p.lat]) };
}

/** Geometry of every way in an Overpass `out geom` body, by way id (used to draw route relations from clipped member ways). */
export function wayGeometryById(elements: unknown[]): Map<number, { lat: number; lon: number }[]> {
  const out = new Map<number, { lat: number; lon: number }[]>();
  for (const raw of elements) {
    const way = wayElementSchema.safeParse(raw);
    if (way.success && way.data.geometry && way.data.geometry.length >= 2) out.set(way.data.id, way.data.geometry);
  }
  return out;
}

/**
 * A relation's way members as one line (a LineString for a single member, else a MultiLineString); null when none.
 * Member geometry comes from the member itself (`out geom` on the relation) or, for a relation fetched with `out body`
 * so that only the ways inside the box are downloaded, from `ways` by member ref.
 */
export function relationLine(
  members: { type: string; ref?: number; geometry?: { lat: number; lon: number }[] }[] | undefined,
  ways?: Map<number, { lat: number; lon: number }[]>,
): LineString | MultiLineString | null {
  const lines: Position[][] = [];
  for (const m of members ?? []) {
    if (m.type !== "way") continue;
    const line = wayLine(m.geometry ?? (m.ref === undefined ? undefined : ways?.get(m.ref)));
    if (line) lines.push(line.coordinates);
  }
  if (lines.length === 0) return null;
  return lines.length === 1
    ? { type: "LineString", coordinates: lines[0] }
    : { type: "MultiLineString", coordinates: lines };
}

/**
 * Overpass QL for route relations without downloading their whole length: `.<set> out body` lists the members, and
 * only the member ways inside the bbox are fetched with geometry (`way(r.<set>)(bbox)`), so a 300 km trail costs
 * what its part in the box costs. `out count` first reports how many relations matched.
 */
export function clippedRelationQuery(set: string, selectors: string[], bbox: BBox, limits: { routes: number; ways: number }): string {
  const area = bboxClause(bbox);
  return (
    `(${selectors.map((sel) => `${sel}${area};`).join("")})->.${set};way(r.${set})${area}->.${set}w;` +
    `.${set} out count;.${set} out body ${limits.routes};.${set}w out tags geom ${limits.ways};`
  );
}

/**
 * A representative point for a small way: the vertex average of a closed ring (a pier or pond outline), the halfway
 * point along an open line. Null for an empty way.
 */
export function wayCenter(geometry: { lat: number; lon: number }[] | undefined): Position | null {
  if (!geometry || geometry.length === 0) return null;
  const first = geometry[0];
  const last = geometry[geometry.length - 1];
  if (geometry.length >= 4 && first.lat === last.lat && first.lon === last.lon) {
    const ring = geometry.slice(0, -1);
    return [ring.reduce((s, p) => s + p.lon, 0) / ring.length, ring.reduce((s, p) => s + p.lat, 0) / ring.length];
  }
  return lineMidpoint(geometry.map((p) => [p.lon, p.lat]));
}
