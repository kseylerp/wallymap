import type { LineString, Position } from "geojson";

/**
 * A small GPX reader for routes people attach: every track segment (`trk/trkseg/trkpt`) and every route
 * (`rte/rtept`) becomes one LineString in file order, keeping elevation (`ele`) when present. String scanning
 * rather than DOMParser, so it runs the same in the browser, the server and tests. Never throws.
 */
export type ParsedGpx = { name?: string; lines: LineString[] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
      return ENTITIES[lower] ?? match;
    })
    .trim();
}

/** Elements named `tag` (with or without a namespace prefix), as their inner text. */
function elements(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi");
  return Array.from(xml.matchAll(re), (m) => m[1]);
}

function attribute(attrs: string, name: string): number {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs);
  return match ? Number(match[1]) : Number.NaN;
}

/** The points named `tag` (trkpt or rtept) in `xml`, skipping any without a valid lat and lon. */
function points(xml: string, tag: string): Position[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>)`, "gi");
  const out: Position[] = [];
  for (const m of xml.matchAll(re)) {
    const lat = attribute(m[1], "lat");
    const lon = attribute(m[1], "lon");
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const ele = m[2] ? Number(elements(m[2], "ele")[0]?.trim()) : Number.NaN;
    out.push(Number.isFinite(ele) ? [lon, lat, ele] : [lon, lat]);
  }
  return out;
}

/** The first `<name>` directly inside `xml`, ignoring names nested in points. */
function ownName(xml: string): string | undefined {
  const withoutPoints = xml.replace(/<(?:[\w-]+:)?(trkpt|rtept|wpt)\b[\s\S]*?(?:\/>|<\/(?:[\w-]+:)?\1>)/gi, "");
  const name = elements(withoutPoints, "name")[0];
  return name === undefined ? undefined : decode(name) || undefined;
}

export function parseGpx(xml: string): ParsedGpx {
  if (typeof xml !== "string" || xml.length === 0) return { lines: [] };
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  const lines: LineString[] = [];
  const tracks = elements(body, "trk");
  for (const track of tracks) {
    const segments = elements(track, "trkseg");
    for (const segment of segments) {
      const coords = points(segment, "trkpt");
      if (coords.length >= 2) lines.push({ type: "LineString", coordinates: coords });
    }
  }
  const routes = elements(body, "rte");
  for (const route of routes) {
    const coords = points(route, "rtept");
    if (coords.length >= 2) lines.push({ type: "LineString", coordinates: coords });
  }
  const metadata = elements(body, "metadata")[0];
  const name = (metadata && ownName(metadata)) ?? (tracks[0] && ownName(tracks[0])) ?? (routes[0] && ownName(routes[0]));
  return name ? { name, lines } : { lines };
}
