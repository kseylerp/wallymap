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
 * Queries an ArcGIS FeatureServer/MapServer layer for features intersecting a bbox,
 * returning GeoJSON in WGS84. `serviceUrl` is the layer URL without `/query`.
 */
export async function arcgisQuery(
  ctx: QueryContext,
  serviceUrl: string,
  params: ArcgisParams,
): Promise<ArcgisResult> {
  const search = new URLSearchParams({
    where: params.where ?? "1=1",
    outFields: params.outFields.join(","),
    geometry: params.bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    f: "geojson",
    resultRecordCount: String(params.maxRecords ?? DEFAULT_MAX_RECORDS),
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
    const truncated =
      typeof json === "object" &&
      json !== null &&
      "exceededTransferLimit" in json &&
      json.exceededTransferLimit === true;
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
