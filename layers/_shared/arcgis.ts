import type { FeatureCollection } from "geojson";
import type { BBox, QueryContext } from "../types";
import { bodyHash } from "@/lib/fetch/cache";
import { UPSTREAM_TIMEOUT_MS } from "./constants";

export type ArcgisParams = {
  where?: string;
  outFields: string[];
  bbox: BBox;
  maxRecords?: number;
  maxAllowableOffset?: number;
  /** ArcGIS `orderByFields`, e.g. "GIS_ACRES DESC"; matters when the result may be capped. */
  orderByFields?: string;
  /** ArcGIS `resultRecordCount`; an alias of maxRecords that wins when both are set (wide fetches pass the strategy's limit). */
  resultRecordCount?: number;
  /**
   * Also ask the service how many features match (`returnCountOnly`, in parallel), so a capped result can say "the 2,000
   * largest of 4,512". The count is `total` on the result; a failed count leaves it out rather than failing the query.
   */
  withCount?: boolean;
  cacheSuffix?: string;
  /** Cache lifetime for this request; omit for the fetch wrapper's default. */
  ttlSeconds?: number;
};

export type ArcgisResult =
  | {
      ok: true;
      fc: FeatureCollection;
      /** True when the service capped the result (`exceededTransferLimit`), so features were left out. */
      truncated: boolean;
      /** With `withCount`: how many features match the where clause in the bbox. */
      total?: number;
    }
  | { ok: false; error: string; status?: number };

const DEFAULT_MAX_RECORDS = 2000;

function isFeatureCollection(value: unknown): value is FeatureCollection {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "FeatureCollection" &&
    "features" in value &&
    Array.isArray(value.features)
  );
}

/** ArcGIS reports many failures as a 200 with `{ error: { code, message } }`. */
function arcgisErrorMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("error" in value)) return null;
  const err = value.error;
  if (typeof err === "object" && err !== null && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return "unknown error";
}

/**
 * True when the service capped the result. FeatureServers put `exceededTransferLimit` at the top of the GeoJSON; some
 * (USGS energy.usgs.gov, the Esri Living Atlas copies) only put it under `properties`, and others in both places.
 */
function exceededTransferLimit(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false;
  if ("exceededTransferLimit" in json && json.exceededTransferLimit === true) return true;
  const nested = "properties" in json ? json.properties : null;
  return typeof nested === "object" && nested !== null && "exceededTransferLimit" in nested && nested.exceededTransferLimit === true;
}

/** The search parameters every query of a bbox shares: the where clause and the envelope in WGS84. */
function bboxSearch(where: string | undefined, bbox: BBox): URLSearchParams {
  return new URLSearchParams({
    where: where ?? "1=1",
    geometry: bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  });
}

export type ArcgisCountParams = Pick<ArcgisParams, "where" | "bbox" | "cacheSuffix" | "ttlSeconds">;

/**
 * How many features of an ArcGIS layer match `where` inside `bbox` (`returnCountOnly=true`), or null when the service
 * fails, times out or answers without a count. Cheap on every FeatureServer and MapServer; used so a wide result can
 * state the total it ranked from.
 */
export async function arcgisCount(ctx: QueryContext, serviceUrl: string, params: ArcgisCountParams): Promise<number | null> {
  const search = bboxSearch(params.where, params.bbox);
  search.set("returnCountOnly", "true");
  search.set("f", "json");
  const url = `${serviceUrl}/query?${search.toString()}`;
  const cacheKey =
    ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:${params.cacheSuffix ?? `arcgis:${bodyHash(url)}`}:count`;
  try {
    const res = await ctx.fetch(url, {
      cacheKey,
      ttlSeconds: params.ttlSeconds,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const count = typeof json === "object" && json !== null && "count" in json ? json.count : undefined;
    return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

/**
 * Queries an ArcGIS FeatureServer/MapServer layer for features intersecting a bbox,
 * returning GeoJSON in WGS84. `serviceUrl` is the layer URL without `/query`.
 * With `withCount`, the matching count is fetched alongside and returned as `total`.
 */
export async function arcgisQuery(
  ctx: QueryContext,
  serviceUrl: string,
  params: ArcgisParams,
): Promise<ArcgisResult> {
  if (params.withCount) {
    const [result, total] = await Promise.all([
      arcgisQuery(ctx, serviceUrl, { ...params, withCount: false }),
      arcgisCount(ctx, serviceUrl, params),
    ]);
    return result.ok && total !== null ? { ...result, total } : result;
  }
  const search = new URLSearchParams({
    where: params.where ?? "1=1",
    outFields: params.outFields.join(","),
    geometry: params.bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    f: "geojson",
    resultRecordCount: String(params.resultRecordCount ?? params.maxRecords ?? DEFAULT_MAX_RECORDS),
  });
  if (params.maxAllowableOffset !== undefined) {
    search.set("maxAllowableOffset", String(params.maxAllowableOffset));
  }

  if (params.orderByFields !== undefined) {
    search.set("orderByFields", params.orderByFields);
  }

  const url = `${serviceUrl}/query?${search.toString()}`;
  // Without ctx.cacheKey the fetch wrapper builds its own URL-based key.
  // Without a suffix, hash the full URL so two queries from one ctx never share a key.
  const cacheKey =
    ctx.cacheKey === undefined
      ? undefined
      : `${ctx.cacheKey}:${params.cacheSuffix ?? `arcgis:${bodyHash(url)}`}`;

  try {
    const res = await ctx.fetch(url, {
      cacheKey,
      ttlSeconds: params.ttlSeconds,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: `ArcGIS service returned ${res.status}`, status: res.status };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: "ArcGIS service returned a response that is not JSON" };
    }
    const message = arcgisErrorMessage(json);
    if (message !== null) return { ok: false, error: `ArcGIS service error: ${message}` };
    if (!isFeatureCollection(json)) {
      return { ok: false, error: "ArcGIS service did not return a FeatureCollection" };
    }
    const truncated = exceededTransferLimit(json);
    return { ok: true, fc: json, truncated };
  } catch (err) {
    const timedOut =
      typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut
        ? `ArcGIS service timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
        : "ArcGIS service returned no response",
    };
  }
}
