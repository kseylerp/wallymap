import type { ResolvedDisplay } from "@/layers/contract";
import { formatValue } from "@/lib/format";
import { windowLabel } from "@/lib/time";

/**
 * Units and clocks for people (docs/layer-contract.md `display`): US units first with metric second for US-centred
 * data ("5,280 ft (1,609 m)"), metric first with US second elsewhere, and times in the feature's local time with its
 * zone ("Oct 16, 2026, 2:15 PM PDT"). The card reads every number and time through these.
 */

type Conversion = { to: string; factor?: number; convert?: (v: number) => number };

/** Metric → US. */
const TO_US: Record<string, Conversion> = {
  m: { to: "ft", factor: 3.28084 },
  km: { to: "mi", factor: 0.621371 },
  "km²": { to: "mi²", factor: 0.386102 },
  km2: { to: "mi²", factor: 0.386102 },
  ha: { to: "acres", factor: 2.47105 },
  "m³/s": { to: "cfs", factor: 35.3147 },
  "°C": { to: "°F", convert: (c) => (c * 9) / 5 + 32 },
  "m/s": { to: "mph", factor: 2.23694 },
  "km/h": { to: "mph", factor: 0.621371 },
  mm: { to: "in", factor: 0.0393701 },
  cm: { to: "in", factor: 0.393701 },
  "m³": { to: "acre-ft", factor: 0.000810714 },
};

/** US → metric. */
const TO_METRIC: Record<string, Conversion> = {
  ft: { to: "m", factor: 0.3048 },
  mi: { to: "km", factor: 1.609344 },
  "mi²": { to: "km²", factor: 2.589988 },
  acres: { to: "ha", factor: 0.404686 },
  cfs: { to: "m³/s", factor: 0.0283168 },
  "°F": { to: "°C", convert: (f) => ((f - 32) * 5) / 9 },
  mph: { to: "km/h", factor: 1.609344 },
  in: { to: "cm", factor: 2.54 },
  "acre-ft": { to: "m³", factor: 1233.48 },
  knots: { to: "km/h", factor: 1.852 },
};

const US_UNITS = new Set(Object.keys(TO_METRIC));
const METRIC_UNITS = new Set(Object.keys(TO_US));

function apply(value: number, c: Conversion): number {
  return c.convert ? c.convert(value) : value * (c.factor ?? 1);
}

/** A number in a unit, rounded to what a reader needs: whole above 100, one decimal above 10, else two. */
function text(value: number, unit: string, key = "v"): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const n = formatValue(key, value, unit, digits);
  return unit.startsWith("°") ? `${n}${unit}` : `${n} ${unit}`;
}

/**
 * A quantity in the layer's display units, the other system second: "5,280 ft (1,609 m)" for US-centred data held in
 * metres, "1,609 m (5,280 ft)" elsewhere. A unit with no counterpart (MW, %, a count) prints as itself.
 */
export function quantity(value: number, unit: string | undefined, display: Pick<ResolvedDisplay, "units">, key = "v"): string {
  if (!unit || unit === "score") return formatValue(key, value, unit);
  const u = unit === "km2" ? "km²" : unit;
  const wantUs = display.units === "us";
  if (wantUs && METRIC_UNITS.has(u)) {
    const c = TO_US[u];
    return `${text(apply(value, c), c.to, key)} (${text(value, u, key)})`;
  }
  if (!wantUs && US_UNITS.has(u)) {
    const c = TO_METRIC[u];
    return `${text(apply(value, c), c.to, key)} (${text(value, u, key)})`;
  }
  const c = wantUs ? TO_METRIC[u] : TO_US[u];
  return c ? `${text(value, u, key)} (${text(apply(value, c), c.to, key)})` : text(value, u, key);
}

/** IANA zones for the US and Canada by rough box, west to east; a point outside them is read in UTC. */
const ZONES: { zone: string; box: [number, number, number, number] }[] = [
  { zone: "Pacific/Honolulu", box: [-161, 18, -154, 23] },
  { zone: "America/Anchorage", box: [-170, 51, -130, 72] },
  { zone: "America/Phoenix", box: [-114.8, 31.3, -109.05, 37] },
  { zone: "America/Los_Angeles", box: [-125, 32, -114.6, 49.5] },
  { zone: "America/Denver", box: [-114.6, 31, -102, 49.5] },
  { zone: "America/Chicago", box: [-102, 25, -87.5, 49.5] },
  { zone: "America/New_York", box: [-87.5, 24, -66, 48] },
  { zone: "America/Vancouver", box: [-139, 48.3, -120, 60] },
  { zone: "America/Edmonton", box: [-120, 49, -110, 60] },
  { zone: "America/Winnipeg", box: [-102, 49, -89, 60] },
  { zone: "America/Toronto", box: [-89, 41.6, -74, 57] },
  { zone: "America/Halifax", box: [-67, 43, -59, 48] },
];

/** The time zone at a point: a US or Canadian zone by box, else the zone of its longitude's hour ("Etc/GMT-1"). */
export function zoneAt(lngLat: [number, number] | null | undefined): string {
  if (!lngLat) return "UTC";
  const [lng, lat] = lngLat;
  const hit = ZONES.find(({ box: [w, s, e, n] }) => lng >= w && lng <= e && lat >= s && lat <= n);
  if (hit) return hit.zone;
  const hours = Math.round(lng / 15);
  if (hours === 0) return "UTC";
  // Etc zones are sign-inverted: Etc/GMT-1 is UTC+1.
  return `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
}

/** True for an ISO string that carries a time of day other than a bare midnight UTC date. */
export function hasTimeOfDay(iso: string): boolean {
  const m = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso.trim());
  if (!m) return false;
  if (m[1] !== "00" || m[2] !== "00") return true;
  // Midnight UTC is how sources write a bare date; midnight at another offset is a real time.
  return m[3] !== undefined && m[3] !== "Z" && !/^[+-]00:?00$/.test(m[3]);
}

/**
 * An instant as people read it at the feature: "Oct 16, 2026, 2:15 PM PDT" in the place's zone (UTC for a layer that
 * says its day is a UTC day, or outside the zones known). A date without a time of day reads as the calendar date.
 */
export function localTime(iso: string, lngLat: [number, number] | null | undefined, display: Pick<ResolvedDisplay, "timeZone">): string | null {
  if (!hasTimeOfDay(iso)) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const timeZone = display.timeZone === "utc" ? "UTC" : zoneAt(lngLat);
  try {
    return new Date(ms).toLocaleString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  } catch {
    return new Date(ms).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  }
}

/** A window as people read it: an hourly frame in the place's local time ("Oct 17, 2026, 11:00 PM AKDT"). */
export function windowText(window: [string, string], bucket: "hour" | "day" | "month" | "year", at?: [number, number]): string {
  if (bucket === "hour" && at) {
    const a = localTime(window[0], at, { timeZone: "local" });
    if (a && windowLabel(window, bucket) === windowLabel([window[0], window[0]], bucket)) return a;
  }
  return windowLabel(window, bucket);
}
