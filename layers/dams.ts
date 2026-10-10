/**
 * US dams from the National Inventory of Dams (US Army Corps of Engineers).
 * Service (verified live 2026-10-10; `?f=json` lists the fields, a Glen Canyon box returns Glen Canyon Dam):
 *   https://geospatial.sec.usace.army.mil/dls/rest/services/NID/National_Inventory_of_Dams_Public_Service/FeatureServer/0
 *   point layer, maxRecordCount 2000, about 92,000 dams, f=geojson works.
 * Fields used (as the service spells them):
 *   NAME, NIDID, YEAR_COMPLETED (integer, 0 or null when unknown), NID_STORAGE (acre-feet, the capacity NID uses),
 *   NID_HEIGHT (feet), PRIMARY_PURPOSE (spelled out, e.g. "Hydroelectric"), HAZARD_POTENTIAL ("High" | "Significant" | "Low" |
 *   "Undetermined"), RIVER_OR_STREAM, STATE, PRIMARY_OWNER_TYPE, PRIMARY_DAM_TYPE, CONDITION_ASSESSMENT.
 * Output: v = NID_STORAGE (acre-feet), t = January 1 of the year completed (so the scrubber plays dams by decade),
 * kind = primary purpose, plus name, nidId, heightFt, yearCompleted, purpose, hazard, river, state, owner, damType, condition.
 * Results are ordered by storage so the 2,000-dam cap keeps the biggest. Dams with no storage figure (about 3% of 92,627) are
 * filtered out with `NID_STORAGE > 0`, because a descending sort puts the null ones first and they would fill the cap.
 * Smoke check 2026-10-10 (live, through runLayer): the Glen Canyon box (-111.55,36.9,-111.4,37) returned Glen Canyon Dam (completed 1963,
 *   710 ft, 29,875,000 acre-feet, High hazard) in 0.5 s; an Arizona-Utah box (-114,34,-110,38) returned 216 dams in 0.4 s; the Bay Area
 *   (-122.5,37.2,-121.5,38) returned 96 dams in 4 s, Los Vaqueros (160,000 acre-feet) first. One call timed out at 25 s once, so the
 *   upstream is occasionally slow.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { bboxAreaKm2, defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const SERVICE_URL =
  "https://geospatial.sec.usace.army.mil/dls/rest/services/NID/National_Inventory_of_Dams_Public_Service/FeatureServer/0";

const FIELDS = [
  "NAME",
  "NIDID",
  "YEAR_COMPLETED",
  "NID_STORAGE",
  "NID_HEIGHT",
  "PRIMARY_PURPOSE",
  "HAZARD_POTENTIAL",
  "RIVER_OR_STREAM",
  "STATE",
  "PRIMARY_OWNER_TYPE",
  "PRIMARY_DAM_TYPE",
  "CONDITION_ASSESSMENT",
];

/** The inventory is updated a few times a year. */
const TTL_SECONDS = 86_400;

const TRUNCATED_NOTE = "Showing the 2,000 dams with the most storage; zoom in for the rest";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.trim() !== "N/A" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** "1966-01-01T00:00:00.000Z" for a plausible completion year; Date.UTC would turn years 0 to 99 into 1900s, so build the string. */
function yearToIso(year: number): string | undefined {
  if (!Number.isInteger(year) || year < 1000 || year > 2100) return undefined;
  return `${year}-01-01T00:00:00.000Z`;
}

/** Service rows to dam points with readable names plus `t` (year completed) and `v` (storage in acre-feet). */
export function normalizeDams(fc: FeatureCollection): FeatureCollection {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const storage = num(p.NID_STORAGE);
    const height = num(p.NID_HEIGHT);
    const year = num(p.YEAR_COMPLETED);
    const purpose = str(p.PRIMARY_PURPOSE);

    const properties: Record<string, string | number> = { name: str(p.NAME) ?? "Unnamed dam" };
    const nidId = str(p.NIDID);
    if (nidId !== undefined) properties.nidId = nidId;
    if (storage !== undefined) {
      properties.storageAf = storage;
      properties.v = storage;
    }
    if (height !== undefined && height > 0) properties.heightFt = height;
    const iso = year === undefined ? undefined : yearToIso(year);
    if (year !== undefined && iso !== undefined) {
      properties.yearCompleted = year;
      properties.t = iso;
    }
    if (purpose !== undefined) {
      properties.purpose = purpose;
      properties.kind = purpose;
    }
    const hazard = str(p.HAZARD_POTENTIAL);
    if (hazard !== undefined) properties.hazard = hazard;
    const river = str(p.RIVER_OR_STREAM);
    if (river !== undefined) properties.river = river;
    const state = str(p.STATE);
    if (state !== undefined) properties.state = state;
    const owner = str(p.PRIMARY_OWNER_TYPE);
    if (owner !== undefined) properties.owner = owner;
    const damType = str(p.PRIMARY_DAM_TYPE);
    if (damType !== undefined) properties.damType = damType;
    const condition = str(p.CONDITION_ASSESSMENT);
    if (condition !== undefined) properties.condition = condition;
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

const dams = defineLayer({
  id: "dams",
  title: "Dams",
  description:
    "US dams from the National Inventory of Dams (US Army Corps of Engineers): every high- and significant-hazard dam plus the larger low-hazard ones. " +
    "Each point has name, v and storageAf (how much water it can hold, in acre-feet; 1 acre-foot is about 325,000 gallons), heightFt (dam height), yearCompleted and t (January 1 of that year, so the time scrubber plays dams by decade), " +
    "purpose and kind (the main use, such as Hydroelectric, Flood Risk Reduction, Irrigation, Water Supply, Recreation or Fire Protection), hazard (High, Significant, Low or Undetermined: what would happen downstream if it failed, not how likely a failure is), river, state, owner, damType and condition. " +
    "Use it for 'dams near here', 'biggest dams in this state', 'when were the dams on this river built', 'high-hazard dams', 'how tall is Glen Canyon Dam' or 'which dams make power'. " +
    "United States only; elsewhere it returns nothing. Year completed is missing for some old dams, and storage and height are as reported by the owner or state. " +
    "The hazard rating is about consequences and is not a safety rating; condition is often 'Not Rated'. " +
    "At most 2,000 dams are returned, biggest storage first, and the result says when that cap is hit. " +
    "Zoom in to a region under 250,000 km² (about a 500 km square) first.",
  coverage: "us",
  license: "Public domain (US Army Corps of Engineers, National Inventory of Dams)",
  requiredEnv: [],
  maxAreaKm2: 250_000,
  input: z.object({}),
  style: { geometry: "point", color: layerColor("dams"), unit: "acre-feet", extrude: "v", cluster: true },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "National Inventory of Dams (US Army Corps of Engineers; public domain)",
      url: "https://nid.sec.usace.army.mil/",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > dams.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${dams.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const res = await arcgisQuery(ctx, SERVICE_URL, {
      outFields: FIELDS,
      bbox: ctx.bbox,
      // About 3% of dams have no storage figure; ArcGIS sorts those first in a descending order, so they would fill the cap.
      where: "NID_STORAGE > 0",
      orderByFields: "NID_STORAGE DESC",
      ttlSeconds: TTL_SECONDS,
      cacheSuffix: "dams",
    });
    if (!res.ok) return { error: res.error, hint: "upstream" };

    const data = normalizeDams(res.fc);
    const notes: string[] = [];
    if (res.truncated) notes.push(TRUNCATED_NOTE);
    if (data.features.length === 0) notes.push("No dams in the National Inventory of Dams for this area");
    return {
      kind: "geojson",
      data,
      citation,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(dams);

export default dams;
