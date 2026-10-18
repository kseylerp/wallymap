/**
 * What a raster tile layer shows at one point (Layer.identify), asked of the source's own endpoint: an ArcGIS MapServer
 * `identify`, an ArcGIS ImageServer `identify` (the pixel value), or a WMS `GetFeatureInfo` (GeoServer's JSON). Each
 * returns null when the source has nothing there and throws nothing: a failed answer is `{ error }`.
 */
import type { Feature } from "geojson";
import type { LayerError, QueryContext } from "../types";
import { UPSTREAM_TIMEOUT_MS } from "./constants";

export type Point = { lon: number; lat: number };

/** The agent name identify requests send (hazards.fema.gov refuses "node"). */
export const IDENTIFY_AGENT = "Mozilla/5.0 (compatible; WallyMap/1.0; +https://wallymap.vercel.app)";
export type { IdentifyPoint } from "../types";

/** A card feature at the tapped point. */
export function pointFeature(at: Point, properties: Record<string, unknown>): Feature {
  return { type: "Feature", geometry: { type: "Point", coordinates: [at.lon, at.lat] }, properties };
}

async function getJson(ctx: QueryContext, url: string): Promise<unknown | LayerError> {
  try {
    const res = await ctx.fetch(url, {
      cacheKey: ctx.cacheKey ? `${ctx.cacheKey}:${url.length}` : undefined,
      ttlSeconds: 3600,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      // FEMA's firewall resets connections from Node's default agent name ("node"); a browser-style name passes.
      headers: { "user-agent": IDENTIFY_AGENT },
    });
    if (!res.ok) return { error: `The source answered ${res.status}`, hint: "upstream" };
    const json: unknown = await res.json();
    if (json && typeof json === "object" && "error" in json) return { error: "The source could not identify that point", hint: "upstream" };
    return json;
  } catch (err) {
    return { error: String(err), hint: "upstream" };
  }
}

export const isLayerError = (v: unknown): v is LayerError => typeof v === "object" && v !== null && "error" in v && "hint" in v;

/** ArcGIS MapServer identify: the attributes of the top feature of `layers` ("all:28") at the point, or null. */
export async function mapServerIdentify(ctx: QueryContext, service: string, at: Point, layers: string): Promise<Record<string, unknown> | null | LayerError> {
  const [w, s, e, n] = ctx.bbox;
  const q = new URLSearchParams({
    geometry: `${at.lon},${at.lat}`,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    layers,
    tolerance: "1",
    mapExtent: `${w},${s},${e},${n}`,
    imageDisplay: "3,3,96",
    returnGeometry: "false",
    f: "json",
  });
  const json = await getJson(ctx, `${service}/identify?${q}`);
  if (isLayerError(json)) return json;
  const results = (json as { results?: { attributes?: Record<string, unknown> }[] }).results ?? [];
  return results[0]?.attributes ?? null;
}

/**
 * ArcGIS ImageServer identify: the pixel value at the point (a class number as a string), or null for NoData. Extra
 * parameters (mosaicRule, renderingRule) pick the year or product, as the tiles do.
 */
export async function imageServerIdentify(ctx: QueryContext, service: string, at: Point, extra: Record<string, string> = {}): Promise<string | null | LayerError> {
  const q = new URLSearchParams({
    geometry: JSON.stringify({ x: at.lon, y: at.lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    returnGeometry: "false",
    returnCatalogItems: "false",
    f: "json",
    ...extra,
  });
  const json = await getJson(ctx, `${service}/identify?${q}`);
  if (isLayerError(json)) return json;
  const value = (json as { value?: unknown }).value;
  return typeof value === "string" && value !== "NoData" && value !== "" ? value : typeof value === "number" ? String(value) : null;
}

/** WMS 1.1.1 GetFeatureInfo as GeoServer JSON: the first feature's properties at the point, or null. */
export async function wmsFeatureInfo(ctx: QueryContext, endpoint: string, layers: string, at: Point): Promise<Record<string, unknown> | null | LayerError> {
  // A 3x3 pixel image centred on the point (pixel 1,1), as wide as the context's box.
  const hw = Math.max(1e-5, (ctx.bbox[2] - ctx.bbox[0]) / 2);
  const hh = Math.max(1e-5, (ctx.bbox[3] - ctx.bbox[1]) / 2);
  const [w, s, e, n] = [at.lon - hw, at.lat - hh, at.lon + hw, at.lat + hh];
  const q = new URLSearchParams({
    service: "WMS",
    version: "1.1.1",
    request: "GetFeatureInfo",
    layers,
    query_layers: layers,
    srs: "EPSG:4326",
    bbox: `${w},${s},${e},${n}`,
    width: "3",
    height: "3",
    x: "1",
    y: "1",
    info_format: "application/json",
  });
  const json = await getJson(ctx, `${endpoint}${endpoint.includes("?") ? "&" : "?"}${q}`);
  if (isLayerError(json)) return json;
  const features = (json as { features?: { properties?: Record<string, unknown> }[] }).features ?? [];
  return features[0]?.properties ?? null;
}
