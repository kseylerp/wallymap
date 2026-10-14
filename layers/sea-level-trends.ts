/**
 * Long-term relative sea level trends at tide gauges, from NOAA CO-OPS (Tides and Currents), US and worldwide.
 *
 * Verified live 2026-10-10 ~10:15 UTC:
 *   https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/sealvltrends.json?units=metric
 *     -> { count: 509, SeaLvlTrends: [{ stationId, stationName, affil: "US" | "Global", annotation, trendUnits: "mm/yr",
 *        latitude, longitude, trend, trendError, startDate: "MM/DD/YYYY", endDate, seasonalCycleMonth, events, ... }] }
 *     (1.1 MB). `affil=US` returns the 144 US stations and `affil=Global` the 365 others; with no `affil` both come in
 *     one call, which is what this layer asks for. No bbox filter, so the list is cached for a week under one shared key
 *     (trends are recomputed once a year) and filtered here. Without `units=metric` the trend is in inches per decade.
 *   - trendError is NOAA's 95% confidence interval (plus or minus, mm/yr).
 *   - Station pages: sltrends_station.shtml?id=9414290 (US), sltrends_global_station.shtml?stnid=010-001 (global).
 *
 * Live smoke 2026-10-10, San Francisco Bay box [-123,37,-122,38.5]: 6 stations; San Francisco (9414290) 1.99 ±0.09 mm/yr
 * 1897-2025 (annotation "Possible datum shift"), Richmond 3.35 ±0.72, Alameda 0.94 ±0.18. The Battery (NY) is 2.94 mm/yr.
 * Through runLayer: SF Bay 6 stations in 2.1 s cold; Gulf Coast [-95,28,-88,31] 11 stations, fastest Eagle Point TX 12.19 mm/yr
 * (4 ft per century), Grand Isle LA 9.13, Galveston Pier 21 6.63.
 * Wide (over 30,000,000 km², up to 120,000,000): the same list, up to 1,000 (more than all 509), total = stations in the box.
 * Smoke 2026-10-14, box -170,0,-50,70 (North America and the North Pacific): all 188 of 188 in 2.7 s, Eagle Point TX 12.19 mm/yr first.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { jsonObjectBody } from "@/lib/fetch/validate";
import { layerColor } from "@/lib/render/palette";

export const TRENDS_URL = "https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/sealvltrends.json?units=metric";
const TTL_SECONDS = 7 * 86_400;
export const MAX_STATIONS = 300;
/** Most stations in a wide view: more than the whole list (509 on 2026-10-10), so a wide view shows every gauge in it. */
const WIDE_LIMIT = 1_000;
const MM_PER_FOOT = 304.8;

const inputSchema = z.object({});

const TrendSchema = z.object({
  stationId: z.string(),
  stationName: z.string(),
  affil: z.string().nullish(),
  annotation: z.string().nullish(),
  latitude: z.coerce.number(),
  longitude: z.coerce.number(),
  trend: z.number(),
  trendError: z.number().nullish(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
});
type Trend = z.infer<typeof TrendSchema>;

/** Rows from the trends body that parse; anything malformed is skipped. */
export function parseTrends(body: unknown): Trend[] {
  if (typeof body !== "object" || body === null || !("SeaLvlTrends" in body) || !Array.isArray(body.SeaLvlTrends)) return [];
  const out: Trend[] = [];
  for (const raw of body.SeaLvlTrends) {
    const parsed = TrendSchema.safeParse(raw);
    if (parsed.success && Number.isFinite(parsed.data.latitude) && Number.isFinite(parsed.data.longitude)) out.push(parsed.data);
  }
  return out;
}

/** "12/15/2025" -> 2025. */
function year(date: string | null | undefined): number | undefined {
  const m = date?.match(/(\d{4})\s*$/);
  return m ? Number(m[1]) : undefined;
}

function stationUrl(t: Trend): string {
  return t.affil === "US"
    ? `https://tidesandcurrents.noaa.gov/sltrends/sltrends_station.shtml?id=${t.stationId}`
    : `https://tidesandcurrents.noaa.gov/sltrends/sltrends_global_station.shtml?stnid=${t.stationId}`;
}

/** Points in the bbox, fastest rise first: `v` mm/yr, trendError, startYear/endYear, ftPerCentury. */
export function trendFeatures(trends: Trend[], [w, s, e, n]: BBox): Feature<Point>[] {
  return trends
    .filter((t) => t.longitude >= w && t.longitude <= e && t.latitude >= s && t.latitude <= n)
    .sort((a, b) => b.trend - a.trend)
    .map((t) => {
      const p: Record<string, string | number> = {
        name: t.stationName,
        stationId: t.stationId,
        v: t.trend,
        kind: t.trend < 0 ? "falling" : "rising",
        ftPerCentury: Math.round((t.trend * 100 * 100) / MM_PER_FOOT) / 100,
        network: t.affil === "US" ? "US" : "global",
        url: stationUrl(t),
      };
      if (typeof t.trendError === "number") p.trendError = t.trendError;
      const start = year(t.startDate);
      const end = year(t.endDate);
      if (start !== undefined) p.startYear = start;
      if (end !== undefined) p.endYear = end;
      if (t.annotation) p.annotation = t.annotation;
      return { type: "Feature", geometry: { type: "Point", coordinates: [t.longitude, t.latitude] }, properties: p };
    });
}

const seaLevelTrends = defineLayer({
  id: "sea-level-trends",
  title: "Sea level trends (NOAA tide gauges)",
  description:
    "The measured long-term rate of sea level change at about 500 NOAA tide gauges on US coasts and worldwide: v in millimetres per year (mm/yr, negative where it falls), a straight-line fit to the past record (relative to the land, so sinking land adds to it), not a forecast. " +
    "Each point is a station with name, v (the trend, mm/yr), trendError (plus or minus, the 95% confidence range), " +
    "startYear and endYear (the record the trend is fitted to), ftPerCentury (the same rate as feet per 100 years), kind ('rising' or 'falling'), network ('US' or 'global'), annotation (NOAA's warning, e.g. a datum shift) and url (the station's trend page). " +
    "The rate is relative sea level: ocean rise plus the land sinking or rising under the gauge, which is what matters at that shore. " +
    "So it differs a lot between places: about 3 mm/yr is typical, 5 to 10 where the land sinks (Louisiana, Chesapeake Bay, Texas), and negative where land rebounds after the ice age (Alaska, Scandinavia). " +
    "1 mm/yr is about 4 inches per century. Example questions: 'How fast is the sea rising in San Francisco?', 'Where is sea level rising fastest on the Gulf Coast?', 'Is sea level falling anywhere?'. " +
    "User words: sea level, sea level trend, rising seas. " +
    "Caveats: it is a straight-line fit to the past, not a forecast, and it does not show the recent speed-up; a short record (under 30 years) or a wide trendError is uncertain. " +
    "For a map of what a given rise would flood, use sea-level-rise. Shows up to 300 stations, fastest rise first (1,000 over 30,000,000 km²).",
  coverage: "global",
  license: "Public domain (NOAA CO-OPS)",
  requiredEnv: [],
  maxAreaKm2: 30_000_000,
  wide: { orderBy: "trend in mm/yr", rank: "fastest-rising", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("sea-level-trends"), unit: "mm/yr" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "NOAA CO-OPS (Tides and Currents) relative sea level trends (public domain)",
      url: "https://tidesandcurrents.noaa.gov/sltrends/",
      retrieved: new Date().toISOString(),
    };
    let body: unknown;
    try {
      const res = await ctx.fetch(TRENDS_URL, {
        // Not bbox-specific: every view shares one copy.
        cacheKey: "sea-level-trends:all",
        ttlSeconds: TTL_SECONDS,
        validate: jsonObjectBody({ listKey: "SeaLvlTrends" }),
        timeoutMs: UPSTREAM_TIMEOUT_MS,
      });
      if (!res.ok) return { error: `NOAA sea level trends returned ${res.status}`, hint: "upstream" };
      body = await res.json();
    } catch (err) {
      const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
      return {
        error: timedOut ? `NOAA sea level trends timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : "NOAA sea level trends returned no usable response",
        hint: "upstream",
      };
    }
    const all = trendFeatures(parseTrends(body), ctx.bbox);
    // Wide (over 30,000,000 km², up to 120,000,000): the same list, fastest rise first, up to the strategy's limit; run.ts writes the note.
    const wideLimit = ctx.wide ? ctx.wideStrategy?.limit : undefined;
    const features = all.slice(0, wideLimit ?? MAX_STATIONS);
    const notes: string[] = ["Measured long-term sea level rates at tide gauges, mm/yr relative to the land; past trends, not a forecast"];
    if (wideLimit === undefined && all.length > features.length) {
      notes.push(`Showing the ${MAX_STATIONS} fastest-rising of ${all.length} stations; zoom in for the rest`);
    }
    if (features.length === 0) notes.push("No NOAA sea level trend stations in this view; they sit on coasts");
    const data: FeatureCollection = { type: "FeatureCollection", features };
    return { kind: "geojson", data, citation, ...(wideLimit !== undefined && { total: all.length }), coverageNote: notes.join("; ") };
  },
});

registerLayer(seaLevelTrends);

export default seaLevelTrends;
