/**
 * Designated US wilderness areas (National Wilderness Preservation System).
 * Service (verified 2026-10-09, `?f=json` returns fields, a Tahoe-bbox query returns Desolation Wilderness):
 *   https://services1.arcgis.com/ERdCHt0sNM6dENSD/arcgis/rest/services/Wilderness_Areas_in_the_United_States/FeatureServer/0
 *   polygon layer, maxRecordCount 2000. The brief's USFS EDW fallback was not needed.
 * Fields used (as the service spells them):
 *   NAME (string), Agency (string: "FS" | "BLM" | "NPS" | "FWS"), Acreage (integer),
 *   Designated (smallint, the year Congress designated it), STATE (string, two-letter code).
 * Output properties: name, agency, acres, designated, state, t (January 1 of the designation year), v (acres).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { bboxAreaKm2, defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";

const SERVICE_URL =
  "https://services1.arcgis.com/ERdCHt0sNM6dENSD/arcgis/rest/services/Wilderness_Areas_in_the_United_States/FeatureServer/0";

const FIELDS = ["NAME", "Agency", "Acreage", "Designated", "STATE"];

/** Boundaries change rarely, so a day is a safe cache lifetime. */
const TTL_SECONDS = 86_400;

/** Spelled-out agency names; the service only holds short codes. */
const AGENCIES: Record<string, string> = {
  FS: "USFS",
  BLM: "BLM",
  NPS: "NPS",
  FWS: "FWS",
};

const TRUNCATED_NOTE = "Showing the 2,000 largest wilderness areas; zoom in for all";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Converts service rows to polygons with readable property names plus `t` and `v`. */
export function normalizeWilderness(fc: FeatureCollection): FeatureCollection {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const acres = num(p.Acreage);
    const designated = num(p.Designated);
    const agency = str(p.Agency);
    const state = str(p.STATE);

    const properties: Record<string, string | number> = {
      name: str(p.NAME) ?? "Unnamed wilderness",
    };
    if (agency !== undefined) properties.agency = AGENCIES[agency] ?? agency;
    if (acres !== undefined) {
      properties.acres = acres;
      properties.v = acres;
    }
    if (designated !== undefined) {
      properties.designated = designated;
      properties.t = new Date(Date.UTC(designated, 0, 1)).toISOString();
    }
    if (state !== undefined) properties.state = state;
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

const wilderness = defineLayer({
  id: "wilderness",
  title: "Wilderness areas",
  description:
    "Boundaries of US federally designated wilderness areas, the strictest level of public land protection, from the National Wilderness Preservation System. " +
    "Each polygon has name, agency (the managing agency: USFS Forest Service, BLM, NPS National Park Service or FWS Fish and Wildlife Service), acres, designated (the year Congress protected it), state, " +
    "t (January 1 of the designation year) and v (acres). " +
    "Use it to show where roadless, motor-free land is, for example when planning backpacking or checking where mountain bikes and vehicles are not allowed. " +
    "United States only; elsewhere it returns nothing. Boundaries are simplified for display, so edges are not survey-grade and should not be used for legal or permit decisions. " +
    "Acres is the figure the service records, which can differ slightly from the area of the drawn shape. " +
    "At most 2,000 areas are returned, largest first, and the result says when that cap is hit. " +
    "Zoom in to a region under 400,000 km² (about a 630 km square) first.",
  coverage: "us",
  license: "Public domain (Wilderness.net / USGS)",
  requiredEnv: [],
  maxAreaKm2: 400_000,
  input: z.object({}),
  style: { geometry: "polygon", color: "#5E7D5A" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "National Wilderness Preservation System boundaries (Wilderness.net / USGS; public domain)",
      url: "https://wilderness.net/",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > wilderness.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${wilderness.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const res = await arcgisQuery(ctx, SERVICE_URL, {
      outFields: FIELDS,
      bbox: ctx.bbox,
      maxAllowableOffset: 0.002,
      orderByFields: "Acreage DESC",
      ttlSeconds: TTL_SECONDS,
      cacheSuffix: "wilderness",
    });
    if (!res.ok) return { error: res.error, hint: "upstream" };

    return {
      kind: "geojson",
      data: normalizeWilderness(res.fc),
      citation,
      ...(res.truncated ? { coverageNote: TRUNCATED_NOTE } : {}),
    };
  },
});

registerLayer(wilderness);

export default wilderness;
