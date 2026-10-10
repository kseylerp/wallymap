/**
 * Snow water equivalent and snow depth from NRCS SNOTEL stations, via the AWDB REST API
 * (https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1; OpenAPI at /awdbRestApi/v3/api-docs).
 * Verified against the live API on 2026-10-09:
 *   - `stations` has NO bounding-box parameters and no `networkCds`: unknown query parameters are
 *     silently ignored and the call returns every station in every network (4,398 rows, 1.6 MB).
 *     The working filter is `stationTriplets=*:*:SNTL` (wildcards allowed in any part of the
 *     `stationId:stateCode:networkCode` triplet) plus `elements=<WTEQ|SNWD>&durations=DAILY&activeOnly=true`,
 *     which returns the ~890 active SNOTEL stations (~390 KB). The bbox is applied here, client side.
 *     Station fields used: stationTriplet, name, elevation (feet), latitude, longitude.
 *   - `data?stationTriplets=<comma list>&elements=<code>&duration=DAILY&beginDate=&endDate=&returnFlags=false`
 *     returns [{ stationTriplet, data: [{ stationElement, values: [{ date: "YYYY-MM-DD", value: number }] }] }].
 *     Today's value is usually not in yet, so the window starts 3 days back and the newest value wins.
 *     Units are inches for both WTEQ and SNWD. A station with no reading in the window has an empty or
 *     missing `values` array (or is missing from the response).
 * The brief's per-bbox station query could not be used, so the full station list is cached under one
 * shared key per element (it does not depend on the bbox) and each request's data call is cached per bbox.
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
/** Days of history requested so a station that is a day or two behind still shows its latest reading. */
const WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;
const STATIONS_TTL_SECONDS = 86_400;
/** SNOTEL reports once a day; an hour keeps the map current without hammering the API. */
const DATA_TTL_SECONDS = 3_600;

const WEST_US: BBox = [-125, 31, -102, 49];

const StationSchema = z.object({
  stationTriplet: z.string(),
  name: z.string(),
  elevation: z.number().optional(),
  latitude: z.number(),
  longitude: z.number(),
});
export type SnotelStation = z.infer<typeof StationSchema>;

const DataSchema = z.object({
  stationTriplet: z.string(),
  data: z
    .array(
      z.object({
        stationElement: z.record(z.string(), z.unknown()).optional(),
        values: z.array(z.object({ date: z.string(), value: z.number().nullable().optional() })).optional(),
      }),
    )
    .optional(),
});
export type SnotelData = z.infer<typeof DataSchema>;

const inputSchema = z.object({
  element: z.enum(["WTEQ", "SNWD"]).default("WTEQ"),
});

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

/** The newest dated, numeric reading across a station's data blocks. */
function latestReading(row: SnotelData | undefined): { date: string; value: number } | undefined {
  let best: { date: string; value: number } | undefined;
  for (const block of row?.data ?? []) {
    for (const v of block.values ?? []) {
      if (typeof v.value !== "number" || !Number.isFinite(v.value)) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) continue;
      if (best === undefined || v.date > best.date) best = { date: v.date, value: v.value };
    }
  }
  return best;
}

/**
 * Joins stations to their latest reading by triplet and keeps those inside `bbox`. Stations without a
 * reading stay on the map with `v` (and `t`) left out.
 */
export function joinSnotel(stations: SnotelStation[], data: SnotelData[], bbox: BBox): FeatureCollection {
  const byTriplet = new Map(data.map((row) => [row.stationTriplet, row]));
  const features: Feature<Point>[] = [];
  for (const s of stations) {
    if (!inBbox(s, bbox)) continue;
    const properties: Record<string, string | number> = { name: s.name };
    if (s.elevation !== undefined) properties.elevationFt = s.elevation;
    const reading = latestReading(byTriplet.get(s.stationTriplet));
    if (reading !== undefined) {
      properties.t = new Date(`${reading.date}T00:00:00Z`).toISOString();
      properties.v = reading.value;
    }
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

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const snowpack = defineLayer({
  id: "snowpack",
  title: "Snowpack (SNOTEL)",
  description:
    "Current snowpack at NRCS SNOTEL automated mountain weather stations in the western United States. " +
    "Each point is a station with name, elevationFt (station elevation in feet), t (date of the reading) and v (the reading in inches). " +
    "element WTEQ (default) is snow water equivalent: the depth of water, in inches, you would get if the snow above the sensor melted, which is the standard measure of how much water the snowpack holds. " +
    "element SNWD is snow depth in inches, the height of the snow on the ground, which is deeper than the water equivalent because snow is mostly air. " +
    "It is daily data: the value is the station's latest daily reading (usually yesterday's) and is refreshed once a day. " +
    "Use it for how much snow is on the ground in the mountains right now. " +
    "Caveats: a station is one spot, not the whole slope, so nearby terrain can hold much more or less snow; in summer and early fall most stations read 0, which is real (no snow), not missing; " +
    "stations with no recent reading are still shown, without v; it is not a forecast and shows no history or season-to-date comparison. " +
    "Western United States only (roughly California to Colorado and Montana to Arizona); elsewhere it returns nothing. " +
    "Needs a region under 400,000 km² (about the size of California).",
  coverage: { bbox: WEST_US },
  license: "Public domain (USDA NRCS)",
  requiredEnv: [],
  maxAreaKm2: 400_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("snowpack"), unit: "in" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    const citation = {
      source: "USDA NRCS SNOTEL via the Air and Water Database (AWDB) REST API (public domain)",
      url: "https://www.nrcs.usda.gov/wps/portal/wcc/home/",
      retrieved: now.toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }
    if (bboxesDisjoint(ctx.bbox, WEST_US)) {
      return {
        kind: "geojson",
        data: EMPTY,
        citation,
        coverageNote: "SNOTEL stations are only in the western United States",
      };
    }

    const stationsUrl =
      `${AWDB}/stations?stationTriplets=*:*:SNTL&elements=${input.element}&durations=DAILY&activeOnly=true`;
    // The full active-station list is the same for every bbox, so share one cache entry per element.
    const stationsResult = await fetchRows(
      ctx,
      stationsUrl,
      "station search",
      `snowpack:stations:${input.element}`,
      STATIONS_TTL_SECONDS,
    );
    if (!stationsResult.ok) return { error: stationsResult.error, hint: "upstream" };

    const inside = parseRows(StationSchema, stationsResult.rows).filter((s) => inBbox(s, ctx.bbox));
    if (inside.length === 0) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: "No SNOTEL stations in this area" };
    }

    const begin = isoDate(new Date(now.getTime() - WINDOW_DAYS * DAY_MS));
    const end = isoDate(now);
    const batches: SnotelStation[][] = [];
    for (let i = 0; i < inside.length; i += BATCH_SIZE) batches.push(inside.slice(i, i + BATCH_SIZE));

    const results = await Promise.all(
      batches.map((batch, i) =>
        fetchRows(
          ctx,
          `${AWDB}/data?stationTriplets=${batch.map((s) => s.stationTriplet).join(",")}` +
            `&elements=${input.element}&duration=DAILY&beginDate=${begin}&endDate=${end}&returnFlags=false`,
          "data call",
          ctx.cacheKey === undefined
            ? undefined
            : `${ctx.cacheKey}:snotel-data${batches.length > 1 ? `:${i}` : ""}`,
          DATA_TTL_SECONDS,
        ),
      ),
    );

    const rows: SnotelData[] = [];
    for (const result of results) {
      if (!result.ok) return { error: result.error, hint: "upstream" };
      rows.push(...parseRows(DataSchema, result.rows));
    }

    return { kind: "geojson", data: joinSnotel(inside, rows, ctx.bbox), citation };
  },
});

registerLayer(snowpack);

export default snowpack;
