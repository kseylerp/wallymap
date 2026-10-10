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
 */
import { z } from "zod";
import type { Feature, Point } from "geojson";
import { bboxAreaKm2, defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const ENDPOINT = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-field-measurements/items";
export const PARAMETER_CODE = "72019";
export const LIMIT = 1_000;
export const DEFAULT_YEARS_BACK = 5;
/** New measurements land daily, but a view's wells change slowly. */
const TTL_SECONDS = 6 * 3600;
const PROPERTIES = "monitoring_location_id,value,time,unit_of_measure,qualifier,observing_procedure,approval_status";

const EMPTY = { type: "FeatureCollection" as const, features: [] as Feature<Point>[] };

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
    "How deep the water table is in wells, from the newest manual measurement at USGS monitoring wells (the data behind USGS Groundwater Watch). " +
    "Each point is one well with v and depthFt (depth to water in feet below the land surface: bigger is deeper, a negative number means the water stands above the ground, as in a flowing artesian well), " +
    "t and date (when it was measured), site and siteNo (the USGS well id), kind ('static' for an undisturbed level, 'other' when the well was pumping or disturbed, 'unspecified' when not recorded) with condition, method, approval (Approved or Provisional) and url to the USGS page. " +
    "Use it for 'how deep is the water table here', 'is the Ogallala aquifer dropping', 'groundwater levels near Kearney', 'where are the deepest wells' or 'depth to water'. " +
    "sinceYear (default: five years back) hides wells whose latest measurement is older; lower it to see long-abandoned wells. " +
    "This is one reading per well, not a trend: it cannot say whether a level is rising or falling, so say so rather than guessing, and compare wells only within one aquifer. Wells measured by hand are visited monthly to yearly, so a value can be months old. " +
    "Wells have no names, only USGS numbers. United States only (state and USGS networks; coverage is thick in the High Plains, California and the Southwest and thin elsewhere). " +
    "At most 1,000 wells are returned, in no particular order, and the result says when that cap is hit. " +
    "Zoom in to a region under 40,000 km² (about a 200 km square) first.",
  coverage: "us",
  license: "Public domain (USGS)",
  requiredEnv: [],
  optionalEnv: ["USGS_API_KEY"],
  maxAreaKm2: 40_000,
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

    const area = bboxAreaKm2(ctx.bbox);
    if (area > groundwater.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${groundwater.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const since = sinceYear(new Date(), input);
    const params = new URLSearchParams({
      parameter_code: PARAMETER_CODE,
      bbox: ctx.bbox.join(","),
      time: `${since}-01-01T00:00:00Z/..`,
      limit: String(LIMIT),
      f: "json",
      properties: PROPERTIES,
    });
    const apiKey = ctx.env.USGS_API_KEY;

    let res: Response;
    try {
      res = await ctx.fetch(`${ENDPOINT}?${params.toString()}`, {
        cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:groundwater:${since}`,
        ttlSeconds: TTL_SECONDS,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        ...(apiKey ? { headers: { "X-Api-Key": apiKey } } : {}),
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
    const notes: string[] = [];
    if (body.features.length >= LIMIT) notes.push(`Showing ${LIMIT} wells, in no particular order; zoom in for the rest`);
    if (features.length === 0) notes.push(`No wells measured since ${since} in this area; set sinceYear lower to include older measurements`);
    else notes.push(`Latest manual measurement per well since ${since}; depth is feet below land surface`);
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(groundwater);

export default groundwater;
