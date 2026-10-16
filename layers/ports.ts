/**
 * Principal US ports and how much cargo they handle, from the Bureau of Transportation Statistics (US Army Corps of
 * Engineers Waterborne Commerce data, calendar year 2023).
 * Service (verified live 2026-10-10, keyless): BTS National Transportation Atlas Database, Principal Ports
 *   https://services7.arcgis.com/n1YM8pTrFmm7L4hs/ArcGIS/rest/services/Principal_Ports/FeatureServer/0
 *   150 port-area polygons (not points), maxRecordCount 2000, WGS84 available through outSR.
 * Fields used: PORTNAME ("Houston Port Authority, TX"), PORT (USACE port code), TYPE ("Coastal" 86, "Internal" 42,
 * "Great Lakes" 22), RANK (1 = most tons), TOTAL / DOMESTIC / FOREIGN_ / IMPORTS / EXPORTS (short tons, 2023).
 * Points: the layer is polygons, so the query adds returnCentroid=true with returnGeometry=false (f=json) and each port
 * is drawn at its polygon centroid. That is the middle of the port area, which for a port spread along a river or ship
 * channel (Houston, South Louisiana) is not a dock. The bbox still selects by the polygon, so a port whose centroid is
 * outside the view can be returned and is then outside the view too.
 * Output properties: name, portCode, rank, tons and v (total short tons), domesticTons, foreignTons, importTons,
 * exportTons, kind (Coastal | Internal | Great Lakes). No `t`: the figures are for calendar 2023.
 * Smoke through runLayer (2026-10-10): Gulf coast -97,27,-88,31 returned 24 ports (Houston first at 309.5 million tons) in 0.4 s;
 * the whole country -170,18,-65,72 returned 149 of the 150 (one lies outside the US extent) in 0.3 s (42 KB);
 * San Francisco Bay -123,37,-122,38.3 returned 4 (Richmond leads with 25.8 million tons).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const SERVICE_URL = "https://services7.arcgis.com/n1YM8pTrFmm7L4hs/ArcGIS/rest/services/Principal_Ports/FeatureServer/0";

const FIELDS = ["RANK", "PORT", "TYPE", "PORTNAME", "TOTAL", "DOMESTIC", "FOREIGN_", "IMPORTS", "EXPORTS"];

/** The tonnage is an annual figure, published once a year. */
const TTL_SECONDS = 7 * 86_400;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Request URL for the ports whose area meets a bbox, with each port's centroid and no polygon. */
export function portsUrl(bbox: BBox): string {
  const search = new URLSearchParams({
    where: "1=1",
    outFields: FIELDS.join(","),
    geometry: bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "false",
    returnCentroid: "true",
    orderByFields: "TOTAL DESC",
    resultRecordCount: "2000",
    f: "json",
  });
  return `${SERVICE_URL}/query?${search.toString()}`;
}

type Row = { attributes?: Record<string, unknown>; centroid?: { x?: unknown; y?: unknown } };

/** Converts the service's JSON rows to points at the port centroid with tonnage as `v`. */
export function normalizePorts(json: unknown): FeatureCollection {
  const features: Feature<Point>[] = [];
  const rows = typeof json === "object" && json !== null && "features" in json && Array.isArray(json.features) ? (json.features as Row[]) : [];
  for (const row of rows) {
    const p = row.attributes ?? {};
    const x = num(row.centroid?.x);
    const y = num(row.centroid?.y);
    if (x === undefined || y === undefined) continue;

    const properties: Record<string, string | number> = { name: str(p.PORTNAME) ?? "Unnamed port" };
    const type = str(p.TYPE);
    if (type !== undefined) properties.kind = type;
    const code = num(p.PORT);
    if (code !== undefined) properties.portCode = code;
    const rank = num(p.RANK);
    if (rank !== undefined) properties.rank = rank;
    const total = num(p.TOTAL);
    if (total !== undefined) {
      properties.tons = total;
      properties.v = total;
    }
    const domestic = num(p.DOMESTIC);
    if (domestic !== undefined) properties.domesticTons = domestic;
    const foreign = num(p.FOREIGN_);
    if (foreign !== undefined) properties.foreignTons = foreign;
    const imports = num(p.IMPORTS);
    if (imports !== undefined) properties.importTons = imports;
    const exports = num(p.EXPORTS);
    if (exports !== undefined) properties.exportTons = exports;

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5] },
      properties,
    });
  }
  return { type: "FeatureCollection", features };
}

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

const ports = defineLayer({
  id: "ports",
  title: "Principal US ports",
  description:
    "The 150 principal ports of the United States and how much cargo each handled in calendar year 2023, from the US Army Corps of Engineers and the Bureau of Transportation Statistics. " +
    "Each point has name (such as Houston Port Authority, TX), kind (Coastal, Internal for river and inland ports, or Great Lakes), rank (1 = the most cargo), v and tons (total short tons moved, domestic plus foreign), domesticTons, foreignTons, importTons and exportTons (all short tons). " +
    "With 3D on, each port rises as a column with its tonnage. " +
    "Use it for 'which are the busiest ports', 'where does the cargo go in and out', 'how big is the Port of Los Angeles' or 'inland river ports on the Mississippi'. " +
    "Caveats: tonnage is weight, not value or containers, so bulk ports (oil, coal, grain) outrank container ports. A point is the middle of the port's area, not a dock, so for a port spread along a river or ship channel it can sit away from the terminals. " +
    "The year is 2023; there is no history in this layer, and ports below the principal-port cutoff are absent. " +
    "United States only; elsewhere it returns nothing. Works at any size of region, up to the whole country.",
  coverage: "us",
  surface: "land",
  license: "Public domain (US Army Corps of Engineers, BTS)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "point", color: layerColor("ports"), unit: "short tons", extrude: "v" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "US Army Corps of Engineers, Waterborne Commerce Statistics, via the BTS National Transportation Atlas Database: Principal Ports, CY 2023 (public domain)",
      url: "https://geodata.bts.gov/datasets/usdot::principal-ports/about",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    let body: unknown;
    try {
      const res = await ctx.fetch(portsUrl(ctx.bbox), {
        cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:ports`,
        ttlSeconds: TTL_SECONDS,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) return { error: `BTS ports service returned ${res.status}`, hint: "upstream" };
      body = await res.json();
    } catch (err) {
      return {
        error: isTimeout(err)
          ? `BTS ports service timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
          : "BTS ports service returned no response",
        hint: "upstream",
      };
    }

    if (typeof body === "object" && body !== null && "error" in body) {
      const message = (body as { error?: { message?: unknown } }).error?.message;
      return { error: `BTS ports service error: ${typeof message === "string" ? message : "unknown error"}`, hint: "upstream" };
    }
    if (typeof body !== "object" || body === null || !("features" in body) || !Array.isArray(body.features)) {
      return { error: "BTS ports service did not return the expected list of ports", hint: "upstream" };
    }

    return { kind: "geojson", data: normalizePorts(body), citation };
  },
});

registerLayer(ports);

export default ports;
