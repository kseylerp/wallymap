/**
 * Gray wolf pack ranges in Washington state, one polygon per pack per year.
 * Service (verified live 2026-10-10, keyless): Washington Department of Fish and Wildlife
 *   https://geodataservices.wdfw.wa.gov/arcgis/rest/services/WP_Statewide/Wolf_PackPolygons/MapServer/1
 *   "Wolf_PackPolygons_AllYears": 377 polygons, years 2014 to 2025 (layer 0 is the current year only), maxRecordCount 2000.
 *   (The plan listed `ApplicationServices/Wolf_PackPolygons`; that path 404s, the service lives under WP_Statewide.)
 * Fields used: Pack (name), Year (integer), PackStatus ("Breeding Pairs" | "Nonbreeding Pack" | "Single Wolf Territory";
 * null for 2014 to 2021, when the status was not published in this layer).
 * WDFW draws a pack as a polygon when it had several wolf locations that year (the estimated pack range) and as a
 * circle around the one location when it had only one; both arrive as polygons here.
 * Output properties: pack, year, status, kind (status, or "Not recorded" before 2022), t (January 1 of the year).
 * Smoke through runLayer (2026-10-10): Washington -124.9,45.5,-116.9,49.1 all years returned 377 pack-years in 0.4 s
 * (125 KB), with year 2023 only 45 (16 KB); northeast corner -118.5,48.4,-117,49 returned 144 (62 KB).
 * Smoke wide (2026-10-14): Pacific Northwest -125,44,-114,50 (about 590,000 km²) returned all 377 pack-years in 1.1 s (122 KB),
 * newest first; no total, because the server's count undercounts a bbox (282).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { bboxesDisjoint } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const SERVICE_URL = "https://geodataservices.wdfw.wa.gov/arcgis/rest/services/WP_Statewide/Wolf_PackPolygons/MapServer/1";

const FIELDS = ["Pack", "Year", "PackStatus"];

/** Washington state with margin. */
const WASHINGTON: BBox = [-124.9, 45.5, -116.9, 49.1];

/** Counted once a year. */
const TTL_SECONDS = 86_400;
const MAX_RECORDS = 2000;

const FIRST_YEAR = 2014;

const NOT_RECORDED = "Not recorded";

/** Most pack-years in a wide result, newest first (there are under 400 in all, so this only bounds the request). */
const WIDE_LIMIT = 1000;

const TRUNCATED_NOTE = "Showing the first 2,000 pack-years in view; pick a year for the rest";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const inputSchema = z.object({
  year: z.number().int().min(2000).max(2100).optional(),
});

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Where clause for the optional year; Year is an integer so the number is safe to inline. */
export function yearWhere(year: number | undefined): string | undefined {
  return year === undefined ? undefined : `Year=${Math.trunc(year)}`;
}

/** Converts service rows to polygons with pack, year, status, kind and `t` (January 1 of the year). */
export function normalizePacks(fc: FeatureCollection): FeatureCollection {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const year = typeof p.Year === "number" && Number.isInteger(p.Year) ? p.Year : undefined;
    const status = str(p.PackStatus);
    const properties: Record<string, string | number> = {
      pack: str(p.Pack) ?? "Unnamed pack",
      kind: status ?? NOT_RECORDED,
    };
    if (status !== undefined) properties.status = status;
    if (year !== undefined) {
      properties.year = year;
      properties.t = new Date(Date.UTC(year, 0, 1)).toISOString();
    }
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

/** Display simplification in degrees. */
export function simplifyOffset(bbox: BBox): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.min(0.02, Math.max(0.001, span / 300));
}

const wolfPacks = defineLayer({
  id: "wolf-packs",
  title: "Wolf packs (Washington)",
  description:
    "Where gray wolf packs lived in Washington state each year from 2014 to 2025, from the Washington Department of Fish and Wildlife. Each polygon is one pack in one year: the estimated pack range when the pack had several wolf locations that year, or a small circle around the single location when it had one. " +
    "Properties: pack (the pack's name), year, t (January 1 of that year, so the time scrubber steps through the years), status and kind (Breeding Pairs, Nonbreeding Pack or Single Wolf Territory; Not recorded for 2014 to 2021, when the status was not published in this layer). " +
    "Set year (for example 2023) to show only that year; leave it out for every year, which suits the time scrubber and shows how packs spread from the northeast corner into the Cascades. " +
    "Use it for 'where are the wolves in Washington', 'how many wolf packs are there' or 'have wolves reached the Cascades'. " +
    "Caveats: Washington only, because it is the one western state that publishes pack outlines as map data (California publishes reports as PDFs only, and Oregon, Idaho and Montana are not in this layer). " +
    "Ranges are the agency's estimates from collar and survey locations, drawn to be general, and they are counts of known packs, not all wolves. " +
    "Do not use them to find individual animals. Over 300,000 km² (more than the whole state) it keeps the 1,000 newest pack-years.",
  coverage: { bbox: WASHINGTON },
  license: "Public data, terms not stated (Washington Department of Fish and Wildlife, 2019 service)",
  requiredEnv: [],
  maxAreaKm2: 300_000,
  wide: { orderBy: "year", limit: WIDE_LIMIT, rank: "newest" },
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("wolf-packs"), fillOpacity: 0.3 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "Washington Department of Fish and Wildlife, Wolf pack polygons, all years",
      url: "https://wdfw.wa.gov/species-habitats/species/canis-lupus",
      retrieved: new Date().toISOString(),
    };

    if (bboxesDisjoint(ctx.bbox, WASHINGTON)) {
      return {
        kind: "geojson",
        data: EMPTY,
        citation,
        coverageNote: "Wolf pack outlines are published as map data only for Washington state",
      };
    }

    if (input.year !== undefined && input.year < FIRST_YEAR) {
      return {
        kind: "geojson",
        data: EMPTY,
        citation,
        coverageNote: `Wolf pack outlines start in ${FIRST_YEAR}, so there is no data for ${input.year}; try a year from ${FIRST_YEAR} on`,
      };
    }

    // Wide (over 300,000 km²): newest first, capped at the strategy's limit. No count: this server's returnCountOnly
    // undercounts a bbox (282 for a box whose query returns all 377 rows, 2026-10-14), and the whole layer fits the limit anyway.
    const res = await arcgisQuery(ctx, SERVICE_URL, {
      where: yearWhere(input.year),
      outFields: FIELDS,
      bbox: ctx.bbox,
      maxRecords: MAX_RECORDS,
      maxAllowableOffset: simplifyOffset(ctx.bbox),
      ...(ctx.wide && { orderByFields: "Year DESC", resultRecordCount: ctx.wideStrategy?.limit ?? WIDE_LIMIT }),
      ttlSeconds: TTL_SECONDS,
      cacheSuffix: "wolves",
    });
    if (!res.ok) return { error: res.error, hint: "upstream" };

    return {
      kind: "geojson",
      data: normalizePacks(res.fc),
      citation,
      ...(res.truncated && !ctx.wide ? { coverageNote: TRUNCATED_NOTE } : {}),
    };
  },
});

registerLayer(wolfPacks);

export default wolfPacks;
