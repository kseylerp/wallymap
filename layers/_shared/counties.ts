/**
 * US county outlines for layers that join county statistics (NOAA temperature anomalies, FEMA declarations) by FIPS.
 * Source: Esri Living Atlas "USA Counties - Generalized" (Esri, US Census Bureau), keyless:
 *   https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Counties_Generalized_Boundaries/FeatureServer/0
 *   fields NAME, STATE_ABBR, STATE_FIPS, COUNTY_FIPS, FIPS (5 digits). maxRecordCount 2000; the contiguous US box has 3,109
 *   counties, so up to three pages are read (resultOffset, ordered by FIPS). With f=geojson the "more rows" flag is in
 *   `properties.exceededTransferLimit`, not at the top level.
 *   Connecticut is drawn as its 9 planning regions (FIPS 09110 to 09190, Census 2022), not the 8 old counties.
 * Verified 2026-10-10: the SF Bay box [-122.7,37.2,-121.7,38.2] returned 10 counties (14 KB) in 0.2 s; page 2 of the
 * contiguous US (offset 2000, maxAllowableOffset 0.02) returned 1,109 counties, 408 KB, in 0.6 s.
 * Outlines change rarely, so each page is cached for a week under a key that depends only on the bbox, shared by every
 * layer and input.
 */
import type { Feature, Geometry } from "geojson";
import type { BBox, QueryContext } from "../types";
import { UPSTREAM_TIMEOUT_MS } from "./constants";
import { jsonObjectBody } from "@/lib/fetch/validate";

export const COUNTIES_SERVICE =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Counties_Generalized_Boundaries/FeatureServer/0";
const PAGE_SIZE = 2000;
const MAX_PAGES = 3;
const TTL_SECONDS = 7 * 86_400;

export type County = {
  /** Five-digit state + county FIPS, e.g. "06075". */
  fips: string;
  stateAbbr: string;
  /** Three-digit county FIPS within the state. */
  countyFips: string;
  name: string;
  geometry: Geometry;
};

export type CountiesResult = { ok: true; counties: County[]; truncated: boolean } | { ok: false; error: string };

/** Display simplification in degrees: about 1/400 of the view, between ~100 m and ~2 km. */
export function countyOffset(bbox: BBox): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.min(0.02, Math.max(0.001, Math.round((span / 400) * 1000) / 1000));
}

export function countiesUrl(bbox: BBox, page: number): string {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "NAME,STATE_ABBR,COUNTY_FIPS,FIPS",
    geometry: bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    maxAllowableOffset: String(countyOffset(bbox)),
    geometryPrecision: "3",
    orderByFields: "FIPS",
    resultOffset: String(page * PAGE_SIZE),
    resultRecordCount: String(PAGE_SIZE),
    f: "geojson",
  });
  return `${COUNTIES_SERVICE}/query?${params.toString()}`;
}

/** Counties from one page of the service's GeoJSON; rows without a FIPS or geometry are skipped. */
export function parseCounties(body: unknown): { counties: County[]; more: boolean } {
  if (typeof body !== "object" || body === null || !("features" in body) || !Array.isArray(body.features)) {
    return { counties: [], more: false };
  }
  const record = body as { features: Feature[]; exceededTransferLimit?: unknown; properties?: { exceededTransferLimit?: unknown } };
  const counties: County[] = [];
  for (const f of record.features) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    if (f.geometry === null || typeof p.FIPS !== "string" || typeof p.STATE_ABBR !== "string") continue;
    counties.push({
      fips: p.FIPS,
      stateAbbr: p.STATE_ABBR,
      countyFips: typeof p.COUNTY_FIPS === "string" ? p.COUNTY_FIPS : p.FIPS.slice(2),
      name: typeof p.NAME === "string" ? p.NAME : p.FIPS,
      geometry: f.geometry,
    });
  }
  const more = record.exceededTransferLimit === true || record.properties?.exceededTransferLimit === true;
  return { counties, more };
}

/** The bbox grown outward to 0.01°, so nearby views share one cache entry and the query matches its key exactly. */
export function roundedBbox([w, s, e, n]: BBox): BBox {
  const down = (v: number) => Math.floor(Math.round(v * 1e6) / 1e4) / 100;
  const up = (v: number) => Math.ceil(Math.round(v * 1e6) / 1e4) / 100;
  return [Math.max(-180, down(w)), Math.max(-90, down(s)), Math.min(180, up(e)), Math.min(90, up(n))];
}

/** Every county touching the bbox (up to 6,000), read page by page and cached a week. */
export async function countiesInBbox(ctx: QueryContext, bbox: BBox): Promise<CountiesResult> {
  const rounded = roundedBbox(bbox);
  const key = rounded.map((n) => n.toFixed(2)).join(",");
  const counties: County[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let body: unknown;
    try {
      const res = await ctx.fetch(countiesUrl(rounded, page), {
        cacheKey: `counties:v1:${key}:${page}`,
        ttlSeconds: TTL_SECONDS,
        validate: jsonObjectBody({ listKey: "features", minLength: 0 }),
        timeoutMs: UPSTREAM_TIMEOUT_MS,
      });
      if (!res.ok) return { ok: false, error: `County outlines (Esri) returned ${res.status}` };
      body = await res.json();
    } catch (err) {
      const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
      return { ok: false, error: timedOut ? `County outlines timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : "County outlines returned no usable response" };
    }
    const { counties: rows, more } = parseCounties(body);
    counties.push(...rows);
    if (!more) return { ok: true, counties, truncated: false };
  }
  return { ok: true, counties, truncated: true };
}
