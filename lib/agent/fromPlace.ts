import type { Feature } from "geojson";
import { haversineM, inArea, verticesOf } from "@/lib/spatial/geo";

/**
 * How far each threat on the map lies from the place asked about (top-10 T06, 2026-10-24: Chaco Canyon's answer counted
 * 40 oil and gas leases and never said how close the nearest comes). Mines, claims, leases, pipelines and methane plumes
 * found for a named place carry `distanceToPlaceKm`, the distance from the place's centre (0 when an area covers it), and the
 * layer's coverage note says which is closest, so the note can quote a distance a result holds.
 */

/** Layers whose features are threats to the place a question names. */
export const THREAT_LAYERS: ReadonlySet<string> = new Set(["mineral-leases", "mining-claims", "mines", "uranium", "pipelines-lines", "methane-plumes"]);

/** The property each threat carries: km from the place's centre. */
export const FROM_PLACE_KEY = "distanceToPlaceKm";

/** km from `center` to the nearest vertex of a feature, 0 when its area covers the centre; null without coordinates. */
export function kmFrom(center: [number, number], f: Feature): number | null {
  if (inArea(center, f.geometry)) return 0;
  let best = Infinity;
  for (const v of verticesOf(f.geometry)) best = Math.min(best, haversineM(center, v));
  return Number.isFinite(best) ? best / 1000 : null;
}

const round = (km: number) => (km < 10 ? Math.round(km * 10) / 10 : Math.round(km));

/** The place's short name, as said: "Chaco Canyon" of "Chaco Canyon (valley in San Juan County, New Mexico, United States)". */
export function shortPlace(name: string): string {
  return name.replace(/\s*\([^)]*\)/g, "").split(",")[0].trim();
}

/**
 * The features with their distance from the place's centre, and a clause naming the closest ("closest to the centre of
 * Chaco Canyon: Oil and gas lease NMNM105451109, 6.1 km"); the same features and no clause when none has coordinates.
 */
export function withPlaceDistances(features: Feature[], place: { center: [number, number]; name: string }): { features: Feature[]; clause: string | null } {
  let closest: { f: Feature; km: number } | null = null;
  const out = features.map((f) => {
    const km = kmFrom(place.center, f);
    if (km === null) return f;
    const at = round(km);
    if (closest === null || km < closest.km) closest = { f, km };
    return { ...f, properties: { ...f.properties, [FROM_PLACE_KEY]: at } };
  });
  const near = closest as { f: Feature; km: number } | null;
  if (!near) return { features: out, clause: null };
  const name = typeof near.f.properties?.name === "string" && near.f.properties.name.trim() ? near.f.properties.name.trim() : "one";
  const where = shortPlace(place.name);
  const clause = near.km === 0 ? `${name} covers the centre of ${where}` : `closest to the centre of ${where}: ${name}, ${round(near.km)} km`;
  return { features: out, clause };
}
