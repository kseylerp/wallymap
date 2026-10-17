/**
 * Giant sequoia groves: the 96 mapped groves of Sierra Nevada giant sequoia (Sequoiadendron giganteum).
 * Service (verified live 2026-10-10, keyless): National Park Service Sequoia & Kings Canyon, SEGI_Groves_2024
 *   https://services1.arcgis.com/fBc8EJBxQRMcHlei/ArcGIS/rest/services/PWR_Sequoia_Groves_2024/FeatureServer/0
 *   polygon layer, 96 features, maxRecordCount 2000, native SR NAD83 (the query asks for WGS84).
 * Fields used: Grove_Name (string), Acres (float), Land_Steward_List (string, who manages the land, e.g. "NPS SEKI",
 *   "USFS SQF GSNM", "Private, DOI BLM"). SEGI_Group and GSNM_Admin_Name are blank for most groves, so they are not used.
 * Sources: the service lists USFS Southwest Region (Information Management Mapping and Remote Sensing Team), Sequoia and Kings
 * Canyon National Parks, BLM, Save the Redwoods League and University of California as its copyright text, states no terms of use,
 * and describes the set as DRAFT groves; the layer repeats that credit and says so.
 * Output properties: name, acres, v (acres), stewards (when recorded), kind ("grove").
 * Smoke through runLayer (2026-10-10): the whole range -121,35.7,-118.3,39.3 returned all 96 groves in 0.8 s (129 KB);
 * Giant Forest box -118.85,36.5,-118.7,36.65 returned 6 groves in 0.3 s (9 KB).
 * Smoke wide (2026-10-14): -122,35,-117,40 (about 245,000 km²) returned all 96 groves of 96 in 1.3 s (126 KB), Mountain Home first.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { bboxesDisjoint } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const SERVICE_URL =
  "https://services1.arcgis.com/fBc8EJBxQRMcHlei/ArcGIS/rest/services/PWR_Sequoia_Groves_2024/FeatureServer/0";

const FIELDS = ["Grove_Name", "Acres", "Land_Steward_List"];

/** Most groves in a wide result, largest first (there are 96, so this only bounds the request). */
const WIDE_LIMIT = 1000;

/** Where the sequoia grows (a little wider than the groves), so a far-away view does not call the service. */
const RANGE: [number, number, number, number] = [-120.7, 35.7, -118.3, 39.3];

/** Boundaries change rarely. */
const TTL_SECONDS = 7 * 86_400;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Converts service rows to polygons with name, acres, v, stewards and kind. */
export function normalizeGroves(fc: FeatureCollection): FeatureCollection {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const properties: Record<string, string | number> = {
      name: str(p.Grove_Name) ?? "Unnamed grove",
      kind: "grove",
    };
    const acres = num(p.Acres);
    if (acres !== undefined) {
      properties.acres = Math.round(acres * 10) / 10;
      properties.v = properties.acres;
    }
    const stewards = str(p.Land_Steward_List);
    if (stewards !== undefined) properties.stewards = stewards;
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

const sequoiaGroves = defineLayer({
  id: "sequoia-groves",
  title: "Giant sequoia groves",
  description:
    "The 96 mapped groves of giant sequoia, the world's largest trees, on the western slope of California's Sierra Nevada, drawn as polygons. Source: a 2024 grove map hosted by Sequoia and Kings Canyon National Parks and compiled from US Forest Service, National Park Service, BLM, Save the Redwoods League and University of California data (the service labels it a draft). " +
    "Each polygon has name (the grove, such as Giant Forest or Mariposa Grove), acres and v (the same acres), stewards (who manages the land: NPS Sequoia and Kings Canyon, a national forest, BLM, state or private) and kind (always grove). " +
    "Use it for 'where are the giant sequoias', 'which sequoia groves are near here', or 'how big is this grove'. Pair it with sequoia-mortality to see how many trees the 2020 and 2021 fires killed. " +
    "Caveats: sequoias grow naturally only in this strip of California, so anywhere else returns nothing; groves range from a few acres to a few thousand. " +
    "Outlines are simplified for display and mark the grove, not each tree. Over 120,000 km² (more than the whole range) it lists them largest first with a total.",
  coverage: { bbox: RANGE },
  place: "Sierra Nevada",
  surface: "land",
  license: "Public data, terms not stated; credit the service's listed sources: USFS Southwest Region (Information Management Mapping and Remote Sensing Team), Sequoia and Kings Canyon National Parks (NPS), BLM, Save the Redwoods League and University of California",
  requiredEnv: [],
  maxAreaKm2: 120_000,
  wide: { orderBy: "acres", limit: WIDE_LIMIT },
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("sequoia-groves"), unit: "acres", fillOpacity: 0.3 },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "Giant sequoia grove boundaries (2024), hosted by Sequoia and Kings Canyon National Parks; compiled from USFS Southwest Region Mapping and Remote Sensing Team, NPS, BLM, Save the Redwoods League and University of California data",
      url: "https://www.nps.gov/seki/learn/nature/giant-sequoias.htm",
      retrieved: new Date().toISOString(),
    };

    if (bboxesDisjoint(ctx.bbox, RANGE)) {
      return {
        kind: "geojson",
        data: EMPTY,
        citation,
        coverageNote: "Giant sequoia groves grow only on the western slope of California's Sierra Nevada",
      };
    }

    // Wide (over 120,000 km²): largest first, capped at the strategy's limit, with a count. Groves are small, so the
    // simplification stays as it is (the whole set is about 130 KB).
    const res = await arcgisQuery(ctx, SERVICE_URL, {
      outFields: FIELDS,
      bbox: ctx.bbox,
      maxAllowableOffset: 0.0005,
      ...(ctx.wide && { orderByFields: "Acres DESC", resultRecordCount: ctx.wideStrategy?.limit ?? WIDE_LIMIT, withCount: true }),
      ttlSeconds: TTL_SECONDS,
      cacheSuffix: "groves",
    });
    if (!res.ok) return { error: res.error, hint: "upstream" };

    return { kind: "geojson", data: normalizeGroves(res.fc), citation, ...(res.total !== undefined && { total: res.total }) };
  },
});

registerLayer(sequoiaGroves);

export default sequoiaGroves;
