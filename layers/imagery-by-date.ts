/**
 * True-colour satellite images for a chosen day from NASA's Harmonized Landsat and Sentinel-2 (HLS) via GIBS, with a
 * search for the nearest day that actually has a pass over the view.
 *
 * Verified live 2026-10-10 against https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml:
 *   HLS_L30_Nadir_BRDF_Adjusted_Reflectance (Landsat 8 and 9, 30 m, from 2013-03-22) and
 *   HLS_S30_Nadir_BRDF_Adjusted_Reflectance (Sentinel-2, 30 m, from 2015-11-28), both daily (with gaps),
 *   GoogleMapsCompatible_Level12, image/png, default (newest) day 2026-10-08, so the newest day is 2 days back.
 *   CORS: access-control-allow-origin *. Tiles exist from zoom 5 (z 5 to 10 all 200 over Yosemite on 2026-09-28).
 * Each day only has the swaths imaged that day, so most days are blank at a given place. GIBS's DescribeDomains answers
 * for the whole globe, not a bbox, so "is there a pass here" is found by fetching one zoom 9 tile at the view's centre:
 * a blank tile is a tiny transparent PNG (155 to 1,189 bytes), a tile with imagery is 50 to 190 KB. Over Yosemite
 * (z9 x85 y197) from 2026-09-24 to 2026-10-08, L30 had imagery on 09-28, 09-29, 10-06, 10-07 and S30 on 09-25, 09-27,
 * 09-30, 10-02, 10-05, 10-07: a pass every one to three days with both sensors.
 * The probe searches outward from the asked day (d, d-1, d+1, d-2, ...), up to 10 days, two days at a time. A blank
 * answer and a hit are both cached (a day for recent days, which may still fill in, 30 days for older ones). A probe
 * that fails (error, timeout) is not a blank: the search goes on, and the result says when a day could not be checked.
 * Live smoke 2026-10-10 through runLayer, Yosemite [-119.7,37.7,-119.5,37.8]: asked 2026-10-01 (no pass), answered
 * 2026-09-30 Sentinel-2 in 0.5 s; default date (2026-10-08) answered 2026-10-07 Landsat (both passed; Landsat's tile was
 * fuller). Lahaina [-156.75,20.8,-156.6,20.95] asked 2023-08-12, answered 2023-08-13 Sentinel-2 in 3.4 s.
 */
import { z } from "zod";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { DAY_MS, dateInput, isoDay, resolveTileDate } from "./_shared/dated-tiles";
import { gibsTileUrl } from "./_shared/gibs";
import { layerColor } from "@/lib/render/palette";

const LEVEL = 12;
const DAYS_BACK = 2;
export const PROBE_ZOOM = 9;
/** Days tried around the asked day, the asked day included. */
export const MAX_PROBE_DAYS = 10;
const DAYS_PER_WAVE = 2;
/** A tile body at least this long holds imagery; blank tiles are under 1,200 bytes. */
export const HIT_CHARS = 8_000;
const RECENT_PROBE_TTL = 86_400;
const OLD_PROBE_TTL = 30 * 86_400;

export const SENSORS = {
  landsat: { id: "HLS_L30_Nadir_BRDF_Adjusted_Reflectance", from: "2013-03-22", label: "Landsat 8/9 (HLS L30)" },
  sentinel: { id: "HLS_S30_Nadir_BRDF_Adjusted_Reflectance", from: "2015-11-28", label: "Sentinel-2 (HLS S30)" },
} as const;
type Sensor = keyof typeof SENSORS;

const inputSchema = z.object({
  date: dateInput,
  sensor: z.enum(["auto", "landsat", "sentinel"]).default("auto"),
});

/** Web Mercator tile holding a point. */
export function tileFor(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const rad = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  const x = Math.min(n - 1, Math.floor(((lng + 180) / 360) * n));
  const y = Math.min(n - 1, Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n));
  return { x, y };
}

/** Days to try, nearest first (earlier before later on a tie), inside [from, newest]. */
export function probeDays(day: string, from: string, newest: string, max = MAX_PROBE_DAYS): string[] {
  const base = Date.parse(`${day}T00:00:00Z`);
  const out: string[] = [];
  for (let k = 0; out.length < max && k <= max * 2; k++) {
    for (const sign of k === 0 ? [0] : [-1, 1]) {
      const d = isoDay(base + sign * k * DAY_MS);
      if (d >= from && d <= newest && out.length < max) out.push(d);
    }
  }
  return out;
}

function probeUrl(sensor: Sensor, day: string, tile: { x: number; y: number }): string {
  return gibsTileUrl(SENSORS[sensor].id, day, LEVEL).replace("{z}", String(PROBE_ZOOM)).replace("{y}", String(tile.y)).replace("{x}", String(tile.x));
}

/** Length of the probe tile's body, or null when the call failed (unknown, not blank). */
async function probe(ctx: QueryContext, sensor: Sensor, day: string, tile: { x: number; y: number }, now: number): Promise<number | null> {
  const recent = Date.parse(`${day}T00:00:00Z`) > now - 7 * DAY_MS;
  try {
    const res = await ctx.fetch(probeUrl(sensor, day, tile), {
      cacheKey: `imagery-by-date:probe:${sensor}:${PROBE_ZOOM}/${tile.x}/${tile.y}:${day}`,
      ttlSeconds: recent ? RECENT_PROBE_TTL : OLD_PROBE_TTL,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    return (await res.text()).length;
  } catch {
    return null;
  }
}

/** `unchecked`: days nearer the asked day than the answer (or all days, when none had a pass) whose probes all failed. */
export type Pick = { day: string; sensor: Sensor; probes: number; unchecked: string[] } | { day: null; probes: number; unchecked: string[] };

/** The nearest day with imagery over the bbox centre, and the sensor whose tile there is fuller. */
export async function nearestPass(ctx: QueryContext, bbox: BBox, days: string[], sensors: Sensor[], now: number): Promise<Pick> {
  const tile = tileFor((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, PROBE_ZOOM);
  let probes = 0;
  const unchecked: string[] = [];
  for (let i = 0; i < days.length; i += DAYS_PER_WAVE) {
    const wave = days.slice(i, i + DAYS_PER_WAVE);
    const sizes = await Promise.all(
      wave.flatMap((day) => sensors.filter((s) => day >= SENSORS[s].from).map(async (sensor) => ({ day, sensor, size: await probe(ctx, sensor, day, tile, now) }))),
    );
    probes += sizes.length;
    for (const day of wave) {
      const ofDay = sizes.filter((s) => s.day === day);
      const hits = ofDay.filter((s) => s.size !== null && s.size >= HIT_CHARS).sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
      if (hits.length > 0) return { day, sensor: hits[0].sensor, probes, unchecked };
      if (ofDay.length > 0 && ofDay.every((s) => s.size === null)) unchecked.push(day);
    }
  }
  return { day: null, probes, unchecked };
}

const imageryByDate = defineLayer({
  id: "imagery-by-date",
  title: "Satellite image by date (Landsat and Sentinel-2)",
  description:
    "A true-colour satellite picture of the ground on a chosen day, at 30 m (fields, burn scars, floods, snow, new roads and clearings show; houses and cars do not), from NASA's Harmonized Landsat and Sentinel-2 (HLS), worldwide over land. " +
    "date (YYYY-MM-DD; default the newest, about 2 days ago) is the day wanted; satellites pass a place only every few days, so the layer shows the nearest day with a pass over the view's centre (up to 5 days before or 4 after), and its coverage note names that day: tell the user. " +
    "sensor is 'auto' (default, either satellite), 'landsat' (Landsat 8/9, from 2013) or 'sentinel' (Sentinel-2, from late 2015). " +
    "For before and after (a fire, a flood, a shrinking lake), set sensor to 'landsat' or 'sentinel' (the same for both) and query once per date to learn the days with a pass, then use the compare tool with a and b set to those two days. " +
    "Example questions: 'Show me a satellite image of Lahaina before and after the 2023 fire', 'What did Lake Mead look like on 2022-07-15?', 'Satellite photo of this area last week'. User words: satellite image on a date, before and after, satellite photo. " +
    "Caveats: clouds are not removed, so a cloudy day looks white; edges of a satellite's strip can cut through the view, leaving part of it blank; the search only checks the centre of the view. " +
    "Returns map tiles, not features you can count or list; describe what you see in general terms. Zoom in to under 1,000,000 km² first.",
  coverage: "global",
  license: "Public domain (NASA HLS via GIBS; contains modified Copernicus Sentinel data)",
  requiredEnv: [],
  maxAreaKm2: 1_000_000,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("imagery-by-date") },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = Date.now();
    const sensors: Sensor[] = input.sensor === "auto" ? ["landsat", "sentinel"] : [input.sensor];
    const from = sensors.map((s) => SENSORS[s].from).sort()[0];
    const choice = resolveTileDate(input.date, { from, latestOffsetDays: -DAYS_BACK, label: "HLS images" }, now);
    if (!choice.ok) return { error: choice.error };
    const newest = isoDay(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - DAYS_BACK * DAY_MS);

    const pick = await nearestPass(ctx, ctx.bbox, probeDays(choice.date, from, newest), sensors, now);
    const asked = input.date ?? choice.date;
    let day: string;
    let sensor: Sensor;
    let note: string;
    if (pick.day === null) {
      day = choice.date;
      sensor = sensors.includes("sentinel") && day >= SENSORS.sentinel.from ? "sentinel" : sensors[0];
      note =
        pick.unchecked.length > 0
          ? `${SENSORS[sensor].label} for ${day}, not verified: the satellite check failed for ${pick.unchecked.join(", ")} and found no pass on the other days, so the map may be blank`
          : `${SENSORS[sensor].label} for ${day}: no satellite pass found over the centre of the view from 5 days before to 4 after ${asked}, so the map may be blank; try another date`;
    } else {
      day = pick.day;
      sensor = pick.sensor;
      note =
        day === asked
          ? `${SENSORS[sensor].label} true colour for ${day}`
          : `${SENSORS[sensor].label} true colour for ${day}, the nearest day with a pass over the view to ${asked}`;
      if (pick.unchecked.length > 0) note += `; nearer days could not be checked (${pick.unchecked.join(", ")})`;
    }
    if (choice.note !== undefined) note += ` (${choice.note})`;

    return {
      kind: "tiles",
      data: {
        url: gibsTileUrl(SENSORS[sensor].id, day, LEVEL),
        minzoom: 5,
        maxzoom: LEVEL,
        format: "raster",
        time: {
          template: gibsTileUrl(SENSORS[sensor].id, "{date}", LEVEL),
          cadence: "daily",
          from: SENSORS[sensor].from,
          daysBack: DAYS_BACK,
        },
      },
      citation: {
        source: `NASA Harmonized Landsat and Sentinel-2 (HLS) ${sensor === "landsat" ? "L30" : "S30"} surface reflectance, via NASA GIBS`,
        url: "https://www.earthdata.nasa.gov/data/projects/hls",
        retrieved: new Date(now).toISOString(),
      },
      coverageNote: note,
    };
  },
});

registerLayer(imageryByDate);

export default imageryByDate;
