import type { Feature, Polygon, Position } from "geojson";
import { createLayerFetch, type CachedFetch } from "@/lib/fetch";

/**
 * The area reachable by car from a point within N minutes, for combine's drive_time. Asked of the FOSSGIS Valhalla
 * public instance (valhalla1.openstreetmap.de, OpenStreetMap roads; free under its fair-use policy: at most one request
 * a second, a descriptive User-Agent, results cached for a week here). When it does not answer, a straight-line circle
 * stands in at 1 km per minute (60 km/h), and `caveat` says so: mountain roads are slower, so the circle overstates
 * the reach there.
 */

export const VALHALLA_URL = "https://valhalla1.openstreetmap.de/isochrone";
const USER_AGENT = "WallyMap/0.1 (https://wallymap.vercel.app)";
/** Valhalla's public instance caps isochrones at 120 minutes. */
export const MAX_DRIVE_MINUTES = 120;
/** The straight-line stand-in's speed: 1 km per minute. */
export const FALLBACK_KM_PER_MIN = 1;

export type Reach = {
  area: Feature<Polygon>;
  /** "valhalla" when the road network answered; "straight-line" for the circle. */
  method: "valhalla" | "straight-line";
  caveat?: string;
  citation: { source: string; url: string; retrieved: string };
};

let shared: CachedFetch | undefined;

/** A circle of `radiusKm` around a point, as a 64-sided polygon. */
export function circle(center: Position, radiusKm: number, sides = 64): Polygon {
  const [lon, lat] = center;
  const ring: Position[] = [];
  for (let i = 0; i <= sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    const dLat = (radiusKm / 110.574) * Math.sin(a);
    const dLon = (radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a);
    ring.push([lon + dLon, lat + dLat]);
  }
  ring[sides] = ring[0];
  return { type: "Polygon", coordinates: [ring] };
}

/** The Valhalla request for one contour, as its GET URL (cacheable by URL). */
export function isochroneUrl(center: Position, minutes: number): string {
  const json = {
    locations: [{ lat: Math.round(center[1] * 1e5) / 1e5, lon: Math.round(center[0] * 1e5) / 1e5 }],
    costing: "auto",
    contours: [{ time: minutes }],
    polygons: true,
    denoise: 0.5,
    generalize: 150,
  };
  return `${VALHALLA_URL}?json=${encodeURIComponent(JSON.stringify(json))}`;
}

/** The first polygon of a Valhalla isochrone answer, or null. MultiPolygons keep their largest part. */
export function parseIsochrone(body: unknown): Polygon | null {
  const features = (body as { features?: { geometry?: { type?: string; coordinates?: unknown } }[] })?.features;
  if (!Array.isArray(features)) return null;
  for (const f of features) {
    const g = f.geometry;
    if (g?.type === "Polygon" && Array.isArray(g.coordinates) && g.coordinates.length > 0) return { type: "Polygon", coordinates: g.coordinates as Position[][] };
    if (g?.type === "MultiPolygon" && Array.isArray(g.coordinates) && g.coordinates.length > 0) {
      const parts = g.coordinates as Position[][][];
      const largest = parts.reduce((best, p) => (p[0].length > best[0].length ? p : best));
      return { type: "Polygon", coordinates: largest };
    }
  }
  return null;
}

/** The drive-time area around `center`; never throws (falls back to the circle with a caveat). */
export async function driveReach(center: Position, minutes: number, fetchImpl?: CachedFetch, now = new Date()): Promise<Reach> {
  const mins = Math.max(1, Math.min(MAX_DRIVE_MINUTES, Math.round(minutes)));
  const retrieved = now.toISOString().slice(0, 10);
  const fetch = fetchImpl ?? (shared ??= createLayerFetch("drive-time", { capacity: 1, refillPerSecond: 1, ttlSeconds: 7 * 86_400 }));
  try {
    const res = await fetch(isochroneUrl(center, mins), { headers: { "user-agent": USER_AGENT, accept: "application/json" }, timeoutMs: 12_000 });
    if (res.ok) {
      const polygon = parseIsochrone(await res.json());
      if (polygon) {
        return {
          area: { type: "Feature", geometry: polygon, properties: { name: `${mins}-minute drive`, minutes: mins } },
          method: "valhalla",
          citation: { source: "Valhalla routing on OpenStreetMap roads (FOSSGIS public instance)", url: "https://valhalla1.openstreetmap.de", retrieved },
        };
      }
    }
  } catch {
    // Fall through to the straight-line circle.
  }
  const km = mins * FALLBACK_KM_PER_MIN;
  return {
    area: { type: "Feature", geometry: circle(center, km), properties: { name: `${km} km straight line`, minutes: mins } },
    method: "straight-line",
    caveat: `The road router did not answer, so this is a straight-line ${km} km circle (1 km per minute); winding or mountain roads take longer.`,
    citation: { source: "Straight-line distance (no road router answered)", url: "https://valhalla1.openstreetmap.de", retrieved },
  };
}
