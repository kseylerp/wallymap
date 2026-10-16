/**
 * Groundwater levels in wells: the newest manual (field) measurement of depth to water at USGS monitoring wells.
 * Service (USGS Water Data API, OGC API - Features; verified live 2026-10-10, keyless, an optional USGS_API_KEY raises the limits):
 *   GET https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-field-measurements/items
 *     ?parameter_code=72019&bbox=W,S,E,N&time=YYYY-01-01T00:00:00Z/..&limit=N&f=json&properties=...
 *   72019 is "Depth to water level, feet below land surface". One feature per well and parameter, the newest measurement.
 *   Properties used: monitoring_location_id ("USGS-410517100144901"), value (a STRING such as "91.17"; negative means the water
 *   stands above the land surface, as in a flowing artesian well), unit_of_measure ("ft"), time (ISO 8601 with offset),
 *   qualifier (list: "Static" for an undisturbed level, "ForeignSubstance", "Pumping", ...), observing_procedure, approval_status.
 *   Geometry is the well point. There is no well name in this collection (names are in `monitoring-locations`; not fetched here).
 *   A 1 x 2 degree box over central Nebraska with the 2015+ filter returned 970 wells in 8.6 s (466 KB with `properties`), which is why
 *   the area limit is modest. The same data are what the USGS Groundwater Watch pages show.
 * Output: v = depth to water in feet below land surface, t = measurement time, plus site (the USGS id), siteNo, depthFt, date,
 *   kind ("static" for an undisturbed level, "other" for pumping or other conditions, "unspecified" when none is given), method, approval, url.
 * Smoke check 2026-10-10 (live, through runLayer): box -100.5,40.5,-99.5,41.5 (central Nebraska) returned 327 wells measured since 2021 in 0.7 s
 *   (first: well 410517100144901, 91.17 ft, 2021-04-26, Static, steel tape); the Kearney box -100.2,40.6,-99.8,40.9 with sinceYear 2024 returned 92 wells.
 * Wide (over 40,000 km², up to 160,000): one page of 2,000 in the API's own order (sortby=-value sorts the text values, nulls
 *   first, so it cannot rank by depth; hence rank "first" and no orderBy), shown deepest first, plus `resulttype=hits` for the
 *   total (numberMatched). Smoke 2026-10-14, box -102,39,-98,43 (central Nebraska, 150,000 km²): 1,999 wells of 2,492 in 1.6 s.
 */
import { z } from "zod";
import type { Feature, Point } from "geojson";
import { defineLayer, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const ENDPOINT = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-field-measurements/items";
export const PARAMETER_CODE = "72019";
export const LIMIT = 1_000;
/** Wells in a wide view: one unordered page (the API sorts `value` as text, so it cannot rank by depth); 2,000 took 3.3 s. */
export const WIDE_LIMIT = 2_000;
export const DEFAULT_YEARS_BACK = 5;
/** New measurements land daily, but a view's wells change slowly. */
const TTL_SECONDS = 6 * 3600;
const PROPERTIES = "monitoring_location_id,value,time,unit_of_measure,qualifier,observing_procedure,approval_status";

const EMPTY = { type: "FeatureCollection" as const, features: [] as Feature<Point>[] };

/**
 * How many wells match (`resulttype=hits` answers `numberMatched` without features), or undefined on any failure; a wide
 * result's total.
 */
async function countWells(ctx: QueryContext, params: URLSearchParams, cacheKey: string | undefined, headers?: Record<string, string>): Promise<number | undefined> {
  const search = new URLSearchParams(params);
  search.set("resulttype", "hits");
  search.set("limit", "1");
  search.set("skipGeometry", "true");
  search.delete("properties");
  try {
    const res = await ctx.fetch(`${ENDPOINT}?${search.toString()}`, { cacheKey, ttlSeconds: TTL_SECONDS, timeoutMs: UPSTREAM_TIMEOUT_MS, ...(headers ? { headers } : {}) });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    const n = typeof body === "object" && body !== null && "numberMatched" in body ? body.numberMatched : undefined;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** First measurement year to include: the current year minus `yearsBack`, or the caller's `sinceYear`. */
export function sinceYear(now: Date, input: { sinceYear?: number }): number {
  return input.sinceYear ?? now.getUTCFullYear() - DEFAULT_YEARS_BACK;
}

/** Wells as points: v is depth to water in feet, t the measurement time; unusable rows (no point, no number, wrong unit) are dropped. */
export function normalizeWells(body: unknown): Feature<Point>[] {
  if (typeof body !== "object" || body === null || !("features" in body) || !Array.isArray(body.features)) return [];
  const seen = new Set<string>();
  const out: Feature<Point>[] = [];
  for (const raw of body.features as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const f = raw as { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> };
    const p = f.properties ?? {};
    const coords = f.geometry?.type === "Point" ? f.geometry.coordinates : undefined;
    if (!Array.isArray(coords) || typeof coords[0] !== "number" || typeof coords[1] !== "number") continue;
    const depth = Number(p.value);
    const unit = str(p.unit_of_measure);
    if (!Number.isFinite(depth) || str(p.value) === undefined || (unit !== undefined && unit !== "ft")) continue;
    const site = str(p.monitoring_location_id);
    if (site !== undefined) {
      if (seen.has(site)) continue;
      seen.add(site);
    }
    const time = str(p.time);
    const ms = time === undefined ? NaN : Date.parse(time);
    const qualifiers = Array.isArray(p.qualifier) ? p.qualifier.filter((q): q is string => typeof q === "string") : [];

    const rounded = Math.round(depth * 100) / 100;
    const properties: Record<string, string | number> = {
      name: site === undefined ? "Well" : `Well ${site.replace(/^USGS-/, "")}`,
      v: rounded,
      depthFt: rounded,
      kind: qualifiers.length === 0 ? "unspecified" : qualifiers.includes("Static") ? "static" : "other",
    };
    if (site !== undefined) {
      properties.site = site;
      properties.siteNo = site.replace(/^USGS-/, "");
      properties.url = `https://waterdata.usgs.gov/monitoring-location/${site}/`;
    }
    if (Number.isFinite(ms)) {
      properties.t = new Date(ms).toISOString();
      properties.date = new Date(ms).toISOString().slice(0, 10);
    }
    if (qualifiers.length > 0) properties.condition = qualifiers.join(", ");
    const method = str(p.observing_procedure);
    if (method !== undefined) properties.method = method;
    const approval = str(p.approval_status);
    if (approval !== undefined) properties.approval = approval;
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: [coords[0], coords[1]] }, properties });
  }
  return out;
}

const groundwater = defineLayer({
  id: "groundwater",
  title: "Groundwater levels",
  description:
    "How deep the water table is, from the newest manual measurement at each USGS monitoring well. Each point has v and depthFt (feet below land surface; negative means water above ground, as in a flowing well), t and date, site and siteNo (the USGS well id), kind ('static' undisturbed, 'other' pumped or disturbed), approval and url. sinceYear (default five years back) hides older wells. One reading per well, so it cannot show a trend: never say a level is rising or falling. Values can be months old; wells have numbers, not names. At most 1,000 wells in no order (2,000 over 40,000 km², with the total).",
  coverage: "us",
  surface: "land",
  license: "Public domain (USGS)",
  requiredEnv: [],
  optionalEnv: ["USGS_API_KEY"],
  maxAreaKm2: 40_000,
  wide: { limit: WIDE_LIMIT, rank: "first" },
  input: z.object({
    sinceYear: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .optional()
      .describe("Only wells measured in this year or later (default: five years back)."),
  }),
  style: { geometry: "point", color: layerColor("groundwater"), unit: "ft", extrude: "v", heat: true },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "USGS Water Data API, latest field measurements of depth to water (parameter 72019)",
      url: "https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-field-measurements",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const since = sinceYear(new Date(), input);
    // Wide (over 40,000 km², up to 160,000): one bigger page, which the API returns in no useful order, plus a count of
    // every well in the box. run.ts writes the note ("the 2,000 first of N").
    const wideLimit = ctx.wide ? ctx.wideStrategy?.limit : undefined;
    const limit = wideLimit ?? LIMIT;
    const params = new URLSearchParams({
      parameter_code: PARAMETER_CODE,
      bbox: ctx.bbox.join(","),
      time: `${since}-01-01T00:00:00Z/..`,
      limit: String(limit),
      f: "json",
      properties: PROPERTIES,
    });
    const apiKey = ctx.env.USGS_API_KEY;
    const headers = apiKey ? { "X-Api-Key": apiKey } : undefined;
    const counting =
      wideLimit === undefined
        ? Promise.resolve(undefined)
        : countWells(ctx, params, ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:groundwater:${since}:count`, headers);

    let res: Response;
    try {
      res = await ctx.fetch(`${ENDPOINT}?${params.toString()}`, {
        cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:groundwater:${since}`,
        ttlSeconds: TTL_SECONDS,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        ...(headers ? { headers } : {}),
      });
    } catch (err) {
      const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
      return {
        error: timedOut
          ? `USGS Water Data API timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds; zoom in and try again`
          : "USGS Water Data API returned no response",
        hint: "upstream",
      };
    }
    if (res.status === 429) {
      return { error: "USGS Water Data API is rate-limiting requests; try again in a minute", hint: "upstream" };
    }
    if (!res.ok) return { error: `USGS Water Data API returned ${res.status}`, hint: "upstream" };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { error: "USGS Water Data API returned a response that is not JSON", hint: "upstream" };
    }
    if (typeof body !== "object" || body === null || !("features" in body) || !Array.isArray(body.features)) {
      return { error: "USGS Water Data API did not return a FeatureCollection", hint: "upstream" };
    }

    const features = normalizeWells(body);
    // A wide page is unordered, so show its deepest wells first.
    if (wideLimit !== undefined) features.sort((a, b) => Number(b.properties?.v) - Number(a.properties?.v));
    const total = await counting;
    const notes: string[] = [];
    if (wideLimit === undefined && body.features.length >= LIMIT) notes.push(`Showing ${LIMIT} wells, in no particular order; zoom in for the rest`);
    if (features.length === 0) notes.push(`No wells measured since ${since} in this area; set sinceYear lower to include older measurements`);
    else notes.push(`Latest manual measurement per well since ${since}; depth is feet below land surface`);
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(total !== undefined && { total }),
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(groundwater);

export default groundwater;
