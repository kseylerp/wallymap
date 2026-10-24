import type { Feature, Point, Position } from "geojson";
import type { BBox } from "../types";
import { pointToLineM } from "./payoffs";

/**
 * Water beside a camp (docs/top-10-use-cases.md T04, "a backcountry camp near water"): springs, drinking-water taps,
 * lakes and ponds, streams and rivers mapped in OpenStreetMap within WATER_M of each camp, read with one Overpass call
 * that finds them around the box's camp sites itself (`around`), and joined here: a camp gains `nearWater` (true),
 * `waterM` (metres to the nearest) and `water` (what it is, nearest first). Pure apart from the caller's fetch.
 */

/** Water this close to a camp counts as beside it (a short walk with a bottle). */
export const WATER_M = 200;

type WaterKind = "spring" | "tap" | "lake" | "stream" | "river";
const WORDS: Record<WaterKind, string> = { spring: "spring", tap: "drinking water tap", lake: "lake", stream: "stream", river: "river" };

export type Water = { kind: WaterKind; name?: string; lines: Position[][] };

/** Overpass QL: the box's camp sites, then the water within `withinM` of any of them. */
export function buildWaterNearCampsQuery(bbox: BBox, withinM = WATER_M): string {
  const [west, south, east, north] = bbox;
  const area = `(${south},${west},${north},${east})`;
  const a = `around.c:${withinM}`;
  return (
    `[out:json][timeout:25];(node["tourism"="camp_site"]${area};way["tourism"="camp_site"]${area};)->.c;` +
    `(node(${a})["natural"="spring"];node(${a})["amenity"="drinking_water"];way(${a})["natural"="water"];way(${a})["waterway"~"^(stream|river)$"];);out tags geom;`
  );
}

/** The water features of an Overpass `out tags geom` body. */
export function parseWater(json: unknown): Water[] {
  const elements = typeof json === "object" && json !== null ? (json as { elements?: unknown }).elements : undefined;
  if (!Array.isArray(elements)) return [];
  const out: Water[] = [];
  for (const el of elements) {
    if (typeof el !== "object" || el === null) continue;
    const e = el as { type?: string; lat?: number; lon?: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] };
    const t = e.tags ?? {};
    const kind: WaterKind | undefined =
      t.natural === "spring"
        ? "spring"
        : t.amenity === "drinking_water"
          ? "tap"
          : t.natural === "water"
            ? "lake"
            : t.waterway === "river"
              ? "river"
              : t.waterway === "stream"
                ? "stream"
                : undefined;
    if (!kind) continue;
    let lines: Position[][] = [];
    if (e.type === "node" && typeof e.lat === "number" && typeof e.lon === "number") lines = [[[e.lon, e.lat]]];
    else if (e.type === "way" && Array.isArray(e.geometry) && e.geometry.length > 0) lines = [e.geometry.map((p) => [p.lon, p.lat])];
    if (lines.length === 0) continue;
    out.push({ kind, ...(t.name && { name: t.name }), lines });
  }
  return out;
}

/** Puts the water within `withinM` of each camp or RV site on it (mutates); returns how many have some. */
export function attachWater(camps: Feature<Point>[], water: Water[], withinM = WATER_M): number {
  if (water.length === 0) return 0;
  let n = 0;
  for (const camp of camps) {
    const props = camp.properties;
    if (!props || props.kind === "parking") continue;
    const at = camp.geometry.coordinates;
    const near: { w: Water; m: number }[] = [];
    for (const w of water) {
      const m = Math.min(...w.lines.map((l) => pointToLineM(at, l)));
      if (m <= withinM) near.push({ w, m });
    }
    if (near.length === 0) continue;
    near.sort((a, b) => a.m - b.m);
    const listed: string[] = [];
    for (const { w } of near) {
      const text = w.name ? `${w.name} (${WORDS[w.kind]})` : `a ${WORDS[w.kind]}`;
      if (!listed.includes(text) && listed.length < 3) listed.push(text);
    }
    props.nearWater = true;
    props.waterM = Math.round(near[0].m);
    props.water = listed.join(" · ");
    n += 1;
  }
  return n;
}
