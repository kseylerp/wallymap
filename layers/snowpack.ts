/**
 * Live snowpack from NRCS SNOTEL stations: snow depth, snow water equivalent (SWE), air temperature, 24-hour
 * new snow, density and a snow-type class, via the AWDB REST API
 * (https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1; OpenAPI at /awdbRestApi/v3/api-docs).
 * Verified against the live API on 2026-10-09/10:
 *   - `stations` has NO bounding-box parameters and no `networkCds`: unknown query parameters are
 *     silently ignored and the call returns every station in every network (4,398 rows, 1.6 MB).
 *     The working filter is `stationTriplets=*:*:SNTL` (wildcards allowed in any part of the
 *     `stationId:stateCode:networkCode` triplet) plus `elements=WTEQ&durations=DAILY&activeOnly=true`,
 *     which returns the ~890 active SNOTEL stations (~390 KB), Alaska included. The bbox is applied here.
 *     Station fields used: stationTriplet, name, elevation (feet), latitude, longitude, dataTimeZone (hours
 *     from UTC of the station's clock: -8 for most of the West, even Montana and Colorado; -9 in Alaska).
 *   - `data?stationTriplets=<comma list>&elements=SNWD,WTEQ,TOBS&duration=HOURLY&beginDate=YYYY-MM-DD HH:mm
 *     &endDate=...&returnFlags=false` returns [{ stationTriplet, data: [{ stationElement: { elementCode,
 *     storedUnitCode }, values: [{ date: "2026-10-09 17:00", value }] }] }]. Dates are station local standard
 *     time; SNWD and WTEQ are inches, TOBS °F. Hourly values arrive within about an hour (at 02:00 UTC the
 *     newest was 17:00 PST, i.e. 01:00 UTC). Hours with no reading are simply missing from `values`.
 *     There is no hourly new-snow element, so new24h is the depth gain over the last 24 hours (never below 0).
 *   - Density = SWE / depth x 1000 kg/m3, only when depth >= 2 in (shallower depths make the ratio noise) and
 *     the result is at most 650 (higher means the depth sensor and the snow pillow disagree). Type classes:
 *     powder < 150, settled 150-300, wet/dense > 300; "no snow" when the depth reads 0.
 * The station list is cached a day under one shared key; each view's data call 15 minutes.
 *
 * Live smoke 2026-10-10 ~02:20 UTC: Tahoe box, 17 stations, 0-1 in (no snow yet; Blue Lakes "no snow", 13.6 °C);
 * Alaska Range box [-146.5,62.8,-145,63.6], 2.3 s: Look Eyrie (5,040 ft) 40 in deep, SWE 9.6 in, density 240
 * kg/m3 "settled", -3.3 °C; Fielding Lake 4 in, SWE 1.3 in, 325 kg/m3 "wet/dense", +1 in in 24 h.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, bboxesDisjoint, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const AWDB = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1";

/** The data call accepts long triplet lists; batches of 100 keep each URL short. */
const BATCH_SIZE = 100;
const HOUR_MS = 3_600_000;
/** Hours of history requested (in UTC, widened for any station clock) so 24-hour change can be computed. */
const WINDOW_BACK_HOURS = 36;
const WINDOW_AHEAD_HOURS = 12;
/** A reading older than this is a station that has stopped reporting; it stays on the map without values. */
const MAX_AGE_HOURS = 48;
const STATIONS_TTL_SECONDS = 86_400;
/** Stations report hourly; 15 minutes keeps the map current. */
const DATA_TTL_SECONDS = 900;
const MIN_DEPTH_FOR_DENSITY_IN = 2;
const MAX_PLAUSIBLE_DENSITY = 650;

const WEST_US: BBox = [-125, 31, -102, 49];
const ALASKA: BBox = [-170, 51, -129, 72];

const StationSchema = z.object({
  stationTriplet: z.string(),
  name: z.string(),
  elevation: z.number().optional(),
  latitude: z.number(),
  longitude: z.number(),
  dataTimeZone: z.number().optional(),
});
export type SnotelStation = z.infer<typeof StationSchema>;

const DataSchema = z.object({
  stationTriplet: z.string(),
  data: z
    .array(
      z.object({
        stationElement: z.object({ elementCode: z.string() }).passthrough().optional(),
        values: z.array(z.object({ date: z.string(), value: z.number().nullable().optional() })).optional(),
      }),
    )
    .optional(),
});
export type SnotelData = z.infer<typeof DataSchema>;

const inputSchema = z.object({});

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** Parses each row on its own so one malformed station does not discard the rest. */
function parseRows<T>(schema: z.ZodType<T>, rows: unknown[]): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function inBbox(s: SnotelStation, [west, south, east, north]: BBox): boolean {
  return s.longitude >= west && s.longitude <= east && s.latitude >= south && s.latitude <= north;
}

type Reading = { time: number; value: number };

/** "2026-10-09 17:00" on a clock `offsetHours` from UTC, as UTC ms. */
function stationTime(date: string, offsetHours: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(date);
  if (!m) return NaN;
  const local = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  return local - offsetHours * HOUR_MS;
}

/** Each element's readings (UTC, ascending), numeric values only. */
function seriesByElement(row: SnotelData | undefined, offsetHours: number): Map<string, Reading[]> {
  const out = new Map<string, Reading[]>();
  for (const block of row?.data ?? []) {
    const code = block.stationElement?.elementCode;
    if (code === undefined) continue;
    const list = out.get(code) ?? [];
    for (const v of block.values ?? []) {
      if (typeof v.value !== "number" || !Number.isFinite(v.value)) continue;
      const time = stationTime(v.date, offsetHours);
      if (Number.isFinite(time)) list.push({ time, value: v.value });
    }
    list.sort((a, b) => a.time - b.time);
    out.set(code, list);
  }
  return out;
}

/** The reading closest to `target` within `toleranceMs`, or undefined. */
function nearest(list: Reading[], target: number, toleranceMs: number): Reading | undefined {
  let best: Reading | undefined;
  for (const r of list) {
    const d = Math.abs(r.time - target);
    if (d <= toleranceMs && (best === undefined || d < Math.abs(best.time - target))) best = r;
  }
  return best;
}

export type SnowType = "no snow" | "powder" | "settled" | "wet/dense";

/** Snow type from density in kg/m3. */
export function snowType(density: number): Exclude<SnowType, "no snow"> {
  if (density < 150) return "powder";
  if (density <= 300) return "settled";
  return "wet/dense";
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Joins stations to their latest hourly readings and keeps those inside `bbox`. v is snow depth (in) at the
 * newest depth reading; swe, density, type, new24h and tempC are added when they can be computed. Stations
 * without a recent depth reading stay on the map with no `v` or `t`.
 */
export function joinSnotel(stations: SnotelStation[], data: SnotelData[], bbox: BBox, now: Date): FeatureCollection {
  const byTriplet = new Map(data.map((row) => [row.stationTriplet, row]));
  const cutoff = now.getTime() - MAX_AGE_HOURS * HOUR_MS;
  const features: Feature<Point>[] = [];
  for (const s of stations) {
    if (!inBbox(s, bbox)) continue;
    const properties: Record<string, string | number> = { name: s.name, stationId: s.stationTriplet };
    if (s.elevation !== undefined) properties.elevationFt = s.elevation;
    const series = seriesByElement(byTriplet.get(s.stationTriplet), s.dataTimeZone ?? -8);
    const depths = (series.get("SNWD") ?? []).filter((r) => r.time >= cutoff);
    const depth = depths[depths.length - 1];
    if (depth !== undefined) {
      properties.t = new Date(depth.time).toISOString();
      properties.v = depth.value;
      const swe = nearest(series.get("WTEQ") ?? [], depth.time, 2 * HOUR_MS);
      if (swe !== undefined) properties.swe = swe.value;
      if (depth.value <= 0) {
        properties.type = "no snow";
      } else if (swe !== undefined && depth.value >= MIN_DEPTH_FOR_DENSITY_IN) {
        const density = Math.round((swe.value / depth.value) * 1000);
        if (density <= MAX_PLAUSIBLE_DENSITY) {
          properties.density = density;
          properties.type = snowType(density);
        }
      }
      const dayAgo = nearest(depths, depth.time - 24 * HOUR_MS, 2 * HOUR_MS);
      if (dayAgo !== undefined) properties.new24h = Math.max(0, depth.value - dayAgo.value);
    }
    const temps = (series.get("TOBS") ?? []).filter((r) => r.time >= cutoff);
    const temp = temps[temps.length - 1];
    if (temp !== undefined) properties.tempC = round1(((temp.value - 32) * 5) / 9);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.longitude, s.latitude] },
      properties,
    });
  }
  return { type: "FeatureCollection", features };
}

type Fetched = { ok: true; rows: unknown[] } | { ok: false; error: string };

async function fetchRows(
  ctx: QueryContext,
  url: string,
  label: string,
  cacheKey: string | undefined,
  ttlSeconds: number,
): Promise<Fetched> {
  try {
    const res = await ctx.fetch(url, { cacheKey, ttlSeconds, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `SNOTEL ${label} returned ${res.status}` };
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return { ok: false, error: `SNOTEL ${label} did not return a list` };
    return { ok: true, rows: body };
  } catch (err) {
    const timedOut =
      typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut
        ? `SNOTEL ${label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
        : `SNOTEL ${label} returned no usable response`,
    };
  }
}

/** "YYYY-MM-DD HH:mm" in UTC. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

const snowpack = defineLayer({
  id: "snowpack",
  title: "Snowpack (SNOTEL, live)",
  description:
    "Live snowpack at NRCS SNOTEL automated mountain stations in the western United States and Alaska, updated hourly. User words: snowpack, snow depth, how much snow, powder, fresh snow, new snow, SWE, snow water equivalent, is it wet or dry snow. " +
    "Each point is a station with name, stationId, elevationFt (feet), t (UTC time of the latest hourly reading, usually under 2 hours old) and v (snow depth in inches). " +
    "swe is snow water equivalent in inches (the water you would get by melting the snow, the standard measure of how much water the snowpack holds). " +
    "density is SWE / depth in kg/m³ and type classes it: 'powder' (under 150, light dry snow), 'settled' (150 to 300), 'wet/dense' (over 300, spring or rain-soaked snow), or 'no snow' when the depth is 0. " +
    "new24h is how many inches the depth rose over the last 24 hours (0 when it settled or melted); tempC is air temperature in °C. " +
    "Example questions: 'How much snow is on the ground at Mount Rose?', 'Did it snow overnight in the Wasatch?', 'Is the snow powder or wet right now?'. " +
    "Caveats: a station is one flat, sheltered clearing, so ridges and wind-loaded slopes can hold much more or less; hourly depth jitters by an inch or two, so a 1 to 2 inch new24h may be noise; " +
    "density is a whole-column average, so fresh powder on top of old snow still reads 'settled'; it is left out under 2 inches of depth or when the sensors disagree; " +
    "in summer and early fall most stations read 0, which is real (no snow). This is not an avalanche forecast. " +
    "Western United States (roughly California to Colorado and Montana to Arizona) and Alaska only; elsewhere it returns nothing. " +
    "Needs a region under 400,000 km² (about the size of California).",
  coverage: "us",
  license: "Public domain (USDA NRCS)",
  requiredEnv: [],
  maxAreaKm2: 400_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("snowpack"), unit: "in", timeField: "t" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const now = new Date();
    const citation = {
      source: "USDA NRCS SNOTEL hourly data via the Air and Water Database (AWDB) REST API (public domain; provisional)",
      url: "https://www.nrcs.usda.gov/wps/portal/wcc/home/",
      retrieved: now.toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }
    if (bboxesDisjoint(ctx.bbox, WEST_US) && bboxesDisjoint(ctx.bbox, ALASKA)) {
      return {
        kind: "geojson",
        data: EMPTY,
        citation,
        coverageNote: "SNOTEL stations are only in the western United States and Alaska",
      };
    }

    const stationsUrl = `${AWDB}/stations?stationTriplets=*:*:SNTL&elements=WTEQ&durations=DAILY&activeOnly=true`;
    // The full active-station list is the same for every bbox, so share one cache entry.
    const stationsResult = await fetchRows(ctx, stationsUrl, "station search", "snowpack:stations:WTEQ", STATIONS_TTL_SECONDS);
    if (!stationsResult.ok) return { error: stationsResult.error, hint: "upstream" };

    const inside = parseRows(StationSchema, stationsResult.rows).filter((s) => inBbox(s, ctx.bbox));
    if (inside.length === 0) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: "No SNOTEL stations in this area" };
    }

    const begin = encodeURIComponent(stamp(now.getTime() - WINDOW_BACK_HOURS * HOUR_MS));
    const end = encodeURIComponent(stamp(now.getTime() + WINDOW_AHEAD_HOURS * HOUR_MS));
    const batches: SnotelStation[][] = [];
    for (let i = 0; i < inside.length; i += BATCH_SIZE) batches.push(inside.slice(i, i + BATCH_SIZE));

    const results = await Promise.all(
      batches.map((batch, i) =>
        fetchRows(
          ctx,
          `${AWDB}/data?stationTriplets=${batch.map((s) => s.stationTriplet).join(",")}` +
            `&elements=SNWD,WTEQ,TOBS&duration=HOURLY&beginDate=${begin}&endDate=${end}&returnFlags=false`,
          "data call",
          ctx.cacheKey === undefined
            ? undefined
            : `${ctx.cacheKey}:snotel-hourly${batches.length > 1 ? `:${i}` : ""}`,
          DATA_TTL_SECONDS,
        ),
      ),
    );

    const rows: SnotelData[] = [];
    for (const result of results) {
      if (!result.ok) return { error: result.error, hint: "upstream" };
      rows.push(...parseRows(DataSchema, result.rows));
    }

    return { kind: "geojson", data: joinSnotel(inside, rows, ctx.bbox, now), citation };
  },
});

registerLayer(snowpack);

export default snowpack;
