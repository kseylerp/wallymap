/**
 * BLM livestock grazing allotments and wild horse and burro areas (Bureau of Land Management).
 * Services (verified live 2026-10-09, keyless ArcGIS MapServers, `f=geojson` queries work, maxRecordCount 2000):
 *   https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_Grazing_Allotment/MapServer/12  "Grazing Allotment Polygons"
 *     fields used: ALLOT_NAME, ALLOT_NO (string, e.g. "03530"), GIS_ACRES, ADMIN_ST. (ACTIVE_DT is a placeholder year 9999.)
 *   https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_WHB/MapServer/0  "Herd Management Area (HMA) Polygons"
 *     fields used: HMA_NAME, HMA_ID, ADMIN_ST, ADMIN_AGCY ("BLM" | "USFS" | "UNK"), HERD_TYPE ("HORSE" | "BURRO" | "BOTH" | "UNK"), BLM_ACRES
 *   https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_WHB/MapServer/1  "Herd Area Polygons" (same fields; HA_NAME, HA_NO)
 * Herd areas are where horses and burros lived in 1971; herd management areas are the parts still managed for them.
 * Output `kind`: "allotment" | "herd-management-area" | "herd-area"; `v` is acres.
 * Smoke through runLayer (2026-10-09): central Nevada -117,39,-116,40 returned 26 allotments, 10 herd management
 * areas and 13 herd areas in 0.7 s (see the test for the recorded counts).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const BASE = "https://gis.blm.gov/arcgis/rest/services/range";
const ALLOTMENTS = `${BASE}/BLM_Natl_Grazing_Allotment/MapServer/12`;
const HERD_MANAGEMENT_AREAS = `${BASE}/BLM_Natl_WHB/MapServer/0`;
const HERD_AREAS = `${BASE}/BLM_Natl_WHB/MapServer/1`;

const ALLOTMENT_FIELDS = ["ALLOT_NAME", "ALLOT_NO", "GIS_ACRES", "ADMIN_ST"];
const HMA_FIELDS = ["HMA_NAME", "HMA_ID", "ADMIN_ST", "ADMIN_AGCY", "HERD_TYPE", "BLM_ACRES"];
const HA_FIELDS = ["HA_NAME", "HA_NO", "ADMIN_ST", "ADMIN_AGCY", "HERD_TYPE", "BLM_ACRES"];

/** Boundaries change rarely, so a day is a safe cache lifetime. */
const TTL_SECONDS = 86_400;
const MAX_RECORDS = 2000;

const TRUNCATED_NOTE = "Showing the 2,000 largest allotments or herd areas in view; zoom in for all";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export type GrazingKind = "allotment" | "herd-management-area" | "herd-area";

const inputSchema = z.object({
  show: z.enum(["both", "allotments", "herds"]).default("both"),
});

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** "UNK" and blank mean the agency did not record a value. */
function known(value: unknown): string | undefined {
  const text = str(value);
  return text === undefined || text.toUpperCase() === "UNK" ? undefined : text;
}

const ANIMALS: Record<string, string> = { HORSE: "horses", BURRO: "burros", BOTH: "horses and burros" };

/** Display simplification in degrees: grows with the view because allotments are large. */
export function simplifyOffset(bbox: BBox): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.min(0.02, Math.max(0.001, span / 400));
}

/** Converts service rows of one kind to polygons with readable names, `kind` and `v` (acres). */
export function normalizeGrazing(fc: FeatureCollection, kind: GrazingKind): Feature<Geometry>[] {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const properties: Record<string, string | number> = { kind };

    if (kind === "allotment") {
      properties.name = str(p.ALLOT_NAME) ?? "Unnamed allotment";
      const number = str(p.ALLOT_NO);
      if (number !== undefined) properties.allotmentNumber = number;
      const acres = num(p.GIS_ACRES);
      if (acres !== undefined) {
        properties.acres = Math.round(acres);
        properties.v = Math.round(acres);
      }
    } else {
      const name = kind === "herd-area" ? str(p.HA_NAME) : str(p.HMA_NAME);
      properties.name = name ?? "Unnamed herd area";
      const id = kind === "herd-area" ? str(p.HA_NO) : str(p.HMA_ID);
      if (id !== undefined) properties.herdId = id;
      const herdType = str(p.HERD_TYPE)?.toUpperCase();
      if (herdType !== undefined && ANIMALS[herdType] !== undefined) properties.animals = ANIMALS[herdType];
      const agency = known(p.ADMIN_AGCY);
      if (agency !== undefined) properties.agency = agency;
      const acres = num(p.BLM_ACRES);
      if (acres !== undefined) {
        properties.acres = Math.round(acres);
        properties.v = Math.round(acres);
      }
    }
    const state = str(p.ADMIN_ST);
    if (state !== undefined) properties.state = state;
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return features;
}

const grazingAllotments = defineLayer({
  id: "grazing-allotments",
  title: "Grazing allotments and wild horse areas",
  description:
    "Where cattle and sheep graze on Bureau of Land Management (BLM) public land, and where wild horses and burros live, drawn as polygons. " +
    "kind is 'allotment' (a livestock grazing allotment: name, allotmentNumber, state, acres), 'herd-management-area' (land the BLM or Forest Service currently manages for a wild horse or burro herd: name, herdId, animals, agency, state, acres) or 'herd-area' (where wild horses and burros were found in 1971, many no longer managed for them). v is acres for all three. " +
    "Use it for 'where is there grazing or cattle on public land', 'is this allotment grazed', or 'where can I see wild horses or burros'. Set show to 'allotments' or 'herds' to draw one group; the default draws both. " +
    "Caveats: an allotment is an administrative area where grazing is permitted, not proof that livestock are there now; allotments can include private and state land, and their gate and fence positions are not shown. " +
    "Herd areas are historic ranges, so a herd area outside a herd management area usually has no animals today, and herd management areas are the better place to look for wild horses. Animals are not located, only their ranges. " +
    "United States only (mostly the western states; Alaska has no BLM allotments in this dataset). Boundaries are simplified for display, so edges are not survey-grade. " +
    "At most 2,000 polygons per group are returned, largest first, and the result says when that cap is hit. " +
    "Zoom in to a region under 150,000 km² (about a 390 km square) first.",
  coverage: "us",
  license: "Public domain (Bureau of Land Management)",
  requiredEnv: [],
  maxAreaKm2: 150_000,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("grazing-allotments"), fillOpacity: 0.18 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "Bureau of Land Management, National Grazing Allotment and Wild Horse and Burro Herd Area datasets (public domain)",
      url: "https://gis.blm.gov/",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > grazingAllotments.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${grazingAllotments.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const common = {
      bbox: ctx.bbox,
      maxRecords: MAX_RECORDS,
      maxAllowableOffset: simplifyOffset(ctx.bbox),
      ttlSeconds: TTL_SECONDS,
    };
    type Part = { label: string; kind: GrazingKind; result: Promise<ArcgisResult> };
    const parts: Part[] = [];
    if (input.show !== "herds") {
      parts.push({
        label: "Grazing allotments",
        kind: "allotment",
        result: arcgisQuery(ctx, ALLOTMENTS, { ...common, outFields: ALLOTMENT_FIELDS, orderByFields: "GIS_ACRES DESC", cacheSuffix: "blm-allotments" }),
      });
    }
    if (input.show !== "allotments") {
      parts.push(
        {
          label: "Herd management areas",
          kind: "herd-management-area",
          result: arcgisQuery(ctx, HERD_MANAGEMENT_AREAS, { ...common, outFields: HMA_FIELDS, orderByFields: "BLM_ACRES DESC", cacheSuffix: "blm-hma" }),
        },
        {
          label: "Herd areas",
          kind: "herd-area",
          result: arcgisQuery(ctx, HERD_AREAS, { ...common, outFields: HA_FIELDS, orderByFields: "BLM_ACRES DESC", cacheSuffix: "blm-ha" }),
        },
      );
    }
    const settled = await Promise.all(parts.map(async (p) => ({ ...p, result: await p.result })));

    const failed = settled.filter((p) => !p.result.ok);
    if (failed.length === settled.length) {
      const first = failed[0].result;
      return { error: first.ok ? "BLM services returned no response" : first.error, hint: "upstream" };
    }

    const features: Feature<Geometry>[] = [];
    const notes: string[] = [];
    let truncated = false;
    for (const part of settled) {
      if (!part.result.ok) {
        notes.push(`${part.label} could not be loaded`);
        continue;
      }
      features.push(...normalizeGrazing(part.result.fc, part.kind));
      truncated = truncated || part.result.truncated;
    }
    if (truncated) notes.push(TRUNCATED_NOTE);

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(grazingAllotments);

export default grazingAllotments;
