import type { BBox } from "@/layers/types";

/**
 * Speeds in the units a US reader uses (audit R12, 2026-10-23): Joshua Tree's wind came back as "14 m/s" and Tomales
 * Bay's "ideal window" as 7 to 8 m/s, which a US kayaker cannot weigh. For a place in the US, every "N m/s" the model
 * reads (summaries, captions, the encoding sentence) also says mph for wind and knots for water, US units first; the
 * note quotes them as written.
 */

/** The lower 48, Alaska and Hawaii, as boxes. */
const US_BOXES: BBox[] = [
  [-125, 24.4, -66.9, 49.4],
  [-170, 51, -129.9, 71.5],
  [-160.6, 18.8, -154.7, 22.4],
];

export function inUS(bbox: BBox | null | undefined): boolean {
  if (!bbox) return false;
  const [x, y] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  return US_BOXES.some(([w, s, e, n]) => x >= w && x <= e && y >= s && y <= n);
}

/** Layers whose speeds are water (knots) rather than air (mph). */
const WATER = new Set(["ocean-currents"]);

const round = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);

/** "10.7 m/s" as "24 mph (10.7 m/s)" (or knots for water); text with no m/s, or already converted, is unchanged. */
export function usSpeeds(text: string, layerId: string): string {
  const water = WATER.has(layerId);
  return text.replace(/(?<![(\d.])(\d+(?:\.\d+)?)\s*m\/s\b(?!\s*\()/g, (whole, n: string) => {
    const v = Number(n);
    const us = water ? `${round(v * 1.943844)} knots` : `${round(v * 2.236936)} mph`;
    return `${us} (${whole})`;
  });
}

/** Every string inside a JSON value with its speeds in US units first. */
export function usSpeedsDeep<T>(value: T, layerId: string): T {
  if (typeof value === "string") return usSpeeds(value, layerId) as T;
  if (Array.isArray(value)) return value.map((v) => usSpeedsDeep(v, layerId)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, usSpeedsDeep(v, layerId)])) as T;
  return value;
}
