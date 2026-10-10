/**
 * Mines, prospects and mineral deposits in the United States from two USGS point datasets, both on the USGS energy ArcGIS server (keyless):
 *   MRDS, the Mineral Resources Data System (verified live 2026-10-10, point layer, maxRecordCount 2000, f=geojson works):
 *     https://energy.usgs.gov/arcgis/rest/services/Hosted/Mineral_Resource_Data_System/FeatureServer/0
 *     Fields: dep_id (deposit id, links to mrdata.usgs.gov/mrds/show-mrds.php?dep_id=...), site_name, dev_stat ("Producer", "Past Producer", "Plant",
 *     "Prospect", "Occurrence", "Unknown"), code_list (commodity codes separated by spaces, e.g. " U V" or " AU AG"; first code is the main one),
 *     grade (a letter). MRDS stopped being updated around 2011, so it is a historic record: closed mines are still listed.
 *   USMIN mine and prospect features (point layer 17 of the USMin_Prospect_and_mine_related_map_features service; layer 18 holds the mine
 *     polygons, not used): https://energy.usgs.gov/arcgis/rest/services/Hosted/USMin_Prospect_and_mine_related_map_features/FeatureServer/17
 *     Fields: ftr_type (47 kinds: Mine, Open Pit Mine, Adit, Mine Shaft, Prospect Pit, Quarry, Gravel Pit, Uranium Mine, Tailings - Pond, ...),
 *     ftr_name, topo_name and topo_date (the USGS topographic map the symbol was digitised from), state, county.
 * Both services put the "capped" flag under `properties` (see layers/_shared/arcgis.ts).
 * Density: Moab box -109.8,38.4,-109.4,38.7 held 169 MRDS records (128 mention uranium) and 1,526 USMIN symbols in -109.7,38.4,-109.5,38.6.
 * Output: MRDS points: kind = main commodity (gold, uranium, ...), status (dev_stat), commodities, grade, id, url, source "MRDS".
 *   USMIN points: kind = feature type, name, topoName, topoYear, state, county, source "USMIN". No v or t.
 * The `commodity` input filters MRDS only (USMIN symbols carry no commodity) with `code_list LIKE '% U %' OR ...` (both spellings of the
 *   list edges), which the server accepts.
 * Smoke check 2026-10-10 (live, through runLayer): Moab box -109.8,38.4,-109.4,38.7 returned 296 points in 0.6 s (169 MRDS, 127 USMIN; first MRDS "Discovery",
 *   uranium, copper, vanadium, Past Producer); commodity uranium with source mrds returned 128 in 0.4 s; commodity gold over the San Gabriel Mountains
 *   -118.3,34,-118,34.3 returned 8 sites.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { bboxAreaKm2, defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

export const MRDS_URL = "https://energy.usgs.gov/arcgis/rest/services/Hosted/Mineral_Resource_Data_System/FeatureServer/0";
export const USMIN_URL =
  "https://energy.usgs.gov/arcgis/rest/services/Hosted/USMin_Prospect_and_mine_related_map_features/FeatureServer/17";
/** The records are decades old and change rarely. */
const TTL_SECONDS = 7 * 86_400;
const TRUNCATED_NOTE = "Showing 2,000 records";

/** MRDS commodity codes to plain names (the common ones; others fall back to the code). */
export const COMMODITY_NAMES: Record<string, string> = {
  AG: "silver",
  AL: "aluminum",
  AS: "arsenic",
  AU: "gold",
  B: "boron",
  BA: "barite",
  BE: "beryllium",
  BI: "bismuth",
  BR: "brine",
  CA: "calcium",
  CD: "cadmium",
  CO: "cobalt",
  COA: "coal",
  CR: "chromium",
  CU: "copper",
  F: "fluorite",
  FE: "iron",
  GA: "gallium",
  GYP: "gypsum",
  HG: "mercury",
  K: "potash",
  LI: "lithium",
  MG: "magnesium",
  MN: "manganese",
  MO: "molybdenum",
  NB: "niobium",
  NI: "nickel",
  P: "phosphate",
  PB: "lead",
  REE: "rare earths",
  S: "sulfur",
  SB: "antimony",
  SE: "selenium",
  SIL: "silica",
  SN: "tin",
  SR: "strontium",
  TE: "tellurium",
  TH: "thorium",
  TI: "titanium",
  U: "uranium",
  V: "vanadium",
  W: "tungsten",
  ZN: "zinc",
  ZR: "zirconium",
};

/** Names the `commodity` input accepts, mapped to their MRDS code. */
export const COMMODITY_CODES = {
  gold: "AU",
  silver: "AG",
  copper: "CU",
  lead: "PB",
  zinc: "ZN",
  uranium: "U",
  vanadium: "V",
  iron: "FE",
  tungsten: "W",
  molybdenum: "MO",
  tin: "SN",
  antimony: "SB",
  mercury: "HG",
  manganese: "MN",
  nickel: "NI",
  cobalt: "CO",
  lithium: "LI",
  barite: "BA",
  fluorite: "F",
  coal: "COA",
  gypsum: "GYP",
  potash: "K",
  phosphate: "P",
  "rare earths": "REE",
} as const;
export type CommodityName = keyof typeof COMMODITY_CODES;

/** SQL for "this code is in the space-separated code_list", written without string concatenation so any ArcGIS back end takes it. */
export function commodityWhere(code: string): string {
  return `code_list LIKE '% ${code} %' OR code_list LIKE '% ${code}' OR code_list LIKE '${code} %' OR code_list = '${code}'`;
}

const EMPTY: FeatureCollection<Point> = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.trim() !== "N/A" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPoint(geometry: unknown): geometry is Point {
  return typeof geometry === "object" && geometry !== null && "type" in geometry && geometry.type === "Point";
}

/** Commodity names for a code list: " U V" -> ["uranium", "vanadium"]; unknown codes stay as they are. */
export function commoditiesOf(codeList: string): string[] {
  return codeList
    .split(/\s+/)
    .filter((c) => c !== "")
    .map((c) => COMMODITY_NAMES[c] ?? c.toLowerCase());
}

/** MRDS rows to points: kind is the main commodity. */
export function normalizeMrds(fc: FeatureCollection): Feature<Point>[] {
  const out: Feature<Point>[] = [];
  for (const f of fc.features) {
    if (!isPoint(f.geometry)) continue;
    const p = f.properties ?? {};
    const commodities = commoditiesOf(str(p.code_list) ?? "");
    const properties: Record<string, string> = {
      name: str(p.site_name) ?? "Unnamed site",
      kind: commodities[0] ?? "unknown",
      source: "MRDS",
    };
    if (commodities.length > 0) properties.commodities = commodities.join(", ");
    const status = str(p.dev_stat);
    if (status !== undefined) properties.status = status;
    const grade = str(p.grade);
    if (grade !== undefined) properties.grade = grade;
    const id = str(p.dep_id);
    if (id !== undefined) {
      properties.id = id;
      properties.url = `https://mrdata.usgs.gov/mrds/show-mrds.php?dep_id=${encodeURIComponent(id)}`;
    }
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out;
}

/** USMIN rows to points: kind is the feature type (Mine, Adit, Quarry, ...). */
export function normalizeUsmin(fc: FeatureCollection): Feature<Point>[] {
  const out: Feature<Point>[] = [];
  for (const f of fc.features) {
    if (!isPoint(f.geometry)) continue;
    const p = f.properties ?? {};
    const type = str(p.ftr_type) ?? "Mine feature";
    const properties: Record<string, string | number> = {
      name: str(p.ftr_name) ?? type,
      kind: type,
      source: "USMIN",
    };
    const topo = str(p.topo_name);
    if (topo !== undefined) properties.topoName = topo;
    const year = num(p.topo_date);
    if (year !== undefined && year > 0) properties.topoYear = year;
    const state = str(p.state);
    if (state !== undefined) properties.state = state;
    const county = str(p.county);
    if (county !== undefined) properties.county = county;
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out;
}

const mines = defineLayer({
  id: "mines",
  title: "Mines and mineral deposits",
  description:
    "Mines, prospects, quarries and mineral deposits in the US from two USGS records: MRDS (deposits with their commodities) and USMIN (mine, shaft and tunnel symbols copied from old topographic maps). Each point has name, kind (MRDS: main commodity such as gold or uranium; USMIN: feature type such as Mine, Adit, Quarry) and source; MRDS adds status (Producer, Past Producer, Prospect, Occurrence), commodities and url, USMIN adds topoName and topoYear. commodity filters MRDS; source picks one record. MRDS stopped updating around 2011, so most sites are closed and new mines are missing, and a point does not mean a mine is open or safe. At most 2,000 per record. Zoom in to under 15,000 km².",
  coverage: "us",
  license: "Public domain (USGS MRDS and USMIN)",
  requiredEnv: [],
  maxAreaKm2: 15_000,
  input: z.object({
    commodity: z
      .enum(Object.keys(COMMODITY_CODES) as [CommodityName, ...CommodityName[]])
      .optional()
      .describe("Only MRDS sites that list this commodity, for example 'gold' or 'uranium'."),
    source: z
      .enum(["both", "mrds", "usmin"])
      .default("both")
      .describe("Which record: 'mrds' (deposits with commodities), 'usmin' (mine symbols from topographic maps) or 'both' (default)."),
  }),
  style: { geometry: "point", color: layerColor("mines"), cluster: true },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "USGS Mineral Resources Data System (MRDS, historic, about 2011) and USMIN mine and prospect features",
      url: "https://mrdata.usgs.gov/mrds/",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > mines.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${mines.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const notes: string[] = [];
    // USMIN symbols have no commodity, so asking for one means MRDS only.
    const source = input.commodity !== undefined ? "mrds" : input.source;
    if (input.commodity !== undefined && input.source === "usmin") {
      notes.push("USMIN symbols carry no commodity, so the commodity filter shows MRDS sites only");
    }

    const [mrds, usmin] = await Promise.all([
      source !== "usmin"
        ? arcgisQuery(ctx, MRDS_URL, {
            outFields: ["dep_id", "site_name", "dev_stat", "code_list", "grade"],
            where: input.commodity === undefined ? undefined : commodityWhere(COMMODITY_CODES[input.commodity]),
            bbox: ctx.bbox,
            ttlSeconds: TTL_SECONDS,
            cacheSuffix: `mines:mrds:${input.commodity ?? "all"}`,
          })
        : null,
      source !== "mrds"
        ? arcgisQuery(ctx, USMIN_URL, {
            outFields: ["ftr_type", "ftr_name", "topo_name", "topo_date", "state", "county"],
            bbox: ctx.bbox,
            ttlSeconds: TTL_SECONDS,
            cacheSuffix: "mines:usmin",
          })
        : null,
    ]);

    const features: Feature<Point>[] = [];
    const failed: string[] = [];
    const take = (res: ArcgisResult | null, label: string, normalize: (fc: FeatureCollection) => Feature<Point>[]) => {
      if (res === null) return;
      if (!res.ok) {
        failed.push(`${label} (${res.error})`);
        return;
      }
      features.push(...normalize(res.fc));
      if (res.truncated) notes.push(`${TRUNCATED_NOTE} from ${label}; zoom in for the rest`);
    };
    take(mrds, "MRDS", normalizeMrds);
    take(usmin, "USMIN", normalizeUsmin);

    const asked = (mrds === null ? 0 : 1) + (usmin === null ? 0 : 1);
    if (failed.length === asked) return { error: `Mine records unavailable: ${failed.join("; ")}`, hint: "upstream" };
    if (failed.length > 0) notes.push(`Missing ${failed.join(" and ")}`);
    if (features.length === 0 && failed.length === 0) {
      notes.push(input.commodity !== undefined ? `No MRDS sites listing ${input.commodity} in this area` : "No mines or prospects recorded in this area");
    } else if (mrds !== null && mrds.ok) {
      notes.push("MRDS is a historic record (about 2011): most sites are closed or only prospects");
    }

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(mines);

export default mines;
